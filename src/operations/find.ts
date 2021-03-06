import { Aspect, defineAspects, Hint } from './operation';
import { ReadPreference } from '../read_preference';
import {
  maxWireVersion,
  MongoDBNamespace,
  Callback,
  formattedOrderClause,
  normalizeHintField
} from '../utils';
import { MongoError } from '../error';
import type { Document } from '../bson';
import type { Server } from '../sdam/server';
import type { Collection } from '../collection';
import type { CollationOptions } from '../cmap/wire_protocol/write_command';
import type { QueryOptions } from '../cmap/wire_protocol/query';
import { CommandOperation, CommandOperationOptions } from './command';

/** @public */
export type SortDirection = 1 | -1 | 'asc' | 'desc' | { $meta: string };
/** @public */
export type Sort =
  | { [key: string]: SortDirection }
  | [string, SortDirection][]
  | [string, SortDirection];

/** @public */
export interface FindOptions extends QueryOptions, CommandOperationOptions {
  /** Sets the limit of documents returned in the query. */
  limit?: number;
  /** Set to sort the documents coming back from the query. Array of indexes, `[['a', 1]]` etc. */
  sort?: Sort;
  /** The fields to return in the query. Object of fields to either include or exclude (one of, not both), `{'a':1, 'b': 1}` **or** `{'a': 0, 'b': 0}` */
  projection?: Document;
  /** Set to skip N documents ahead in your query (useful for pagination). */
  skip?: number;
  /** Tell the query to use specific indexes in the query. Object of indexes to use, `{'_id':1}` */
  hint?: Hint;
  /** Explain the query instead of returning the data. */
  explain?: boolean;
  /** Specify if the cursor can timeout. */
  timeout?: boolean;
  /** Specify if the cursor is tailable. */
  tailable?: boolean;
  /** Specify if the cursor is a a tailable-await cursor. Requires `tailable` to be true */
  awaitData?: boolean;
  /** Set the batchSize for the getMoreCommand when iterating over the query results. */
  batchSize?: number;
  /** If true, returns only the index keys in the resulting documents. */
  returnKey?: boolean;
  /** Set index bounds. */
  min?: number;
  /** Set index bounds. */
  max?: number;
  /** You can put a $comment field on a query to make looking in the profiler logs simpler. */
  comment?: string | Document;
  /** Number of milliseconds to wait before aborting the query. */
  maxTimeMS?: number;
  /** The maximum amount of time for the server to wait on new documents to satisfy a tailable cursor query. Requires `tailable` and `awaitData` to be true */
  maxAwaitTimeMS?: number;
  /** The server normally times out idle cursors after an inactivity period (10 minutes) to prevent excess memory use. Set this option to prevent that. */
  noCursorTimeout?: boolean;
  /** Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields). */
  collation?: CollationOptions;
  /** Enables writing to temporary files on the server. */
  allowDiskUse?: boolean;
  /** Determines whether to close the cursor after the first batch. Defaults to false. */
  singleBatch?: boolean;
  /** For queries against a sharded collection, allows the command (or subsequent getMore commands) to return partial results, rather than an error, if one or more queried shards are unavailable. */
  allowPartialResults?: boolean;
  /** Determines whether to return the record identifier for each document. If true, adds a field $recordId to the returned documents. */
  showRecordId?: boolean;

  /** @deprecated Use `awaitData` instead */
  awaitdata?: boolean;
  /** @deprecated Use `projection` instead */
  fields?: Document;
  /** @deprecated Limit the number of items to scan. */
  maxScan?: number;
  /** @deprecated An internal command for replaying a replica set’s oplog. */
  oplogReplay?: boolean;
  /** @deprecated Snapshot query. */
  snapshot?: boolean;
  /** @deprecated Show disk location of results. */
  showDiskLoc?: boolean;
  /** @deprecated Use `allowPartialResults` instead */
  partial?: boolean;
}

const SUPPORTS_WRITE_CONCERN_AND_COLLATION = 5;

/** @internal */
export class FindOperation extends CommandOperation<FindOptions, Document> {
  cmd: Document;
  filter: Document;
  readPreference: ReadPreference;

  hint?: Hint;

  constructor(
    collection: Collection,
    ns: MongoDBNamespace,
    filter: Document = {},
    options: FindOptions = {}
  ) {
    super(collection, options);
    this.ns = ns;
    this.readPreference = ReadPreference.resolve(collection, this.options);

    if (typeof filter !== 'object' || Array.isArray(filter)) {
      throw new MongoError('Query filter must be a plain object or ObjectId');
    }

    // If the filter is a buffer, validate that is a valid BSON document
    if (Buffer.isBuffer(filter)) {
      const objectSize = filter[0] | (filter[1] << 8) | (filter[2] << 16) | (filter[3] << 24);
      if (objectSize !== filter.length) {
        throw new TypeError(
          `query filter raw message size does not match message header size [${filter.length}] != [${objectSize}]`
        );
      }
    }

    // special case passing in an ObjectId as a filter
    this.filter = filter != null && filter._bsontype === 'ObjectID' ? { _id: filter } : filter;

    // FIXME: this should be removed as part of NODE-2790
    this.cmd = {
      find: this.ns.toString(),
      query: this.filter
    };

    // TODO: figure out our story about inheriting BSON serialization options
    this.bsonOptions = {
      raw: options.raw ?? collection.s.raw ?? false,
      promoteLongs: options.promoteLongs ?? collection.s.promoteLongs ?? true,
      promoteValues: options.promoteValues ?? collection.s.promoteValues ?? true,
      promoteBuffers: options.promoteBuffers ?? collection.s.promoteBuffers ?? false,
      ignoreUndefined: options.ignoreUndefined ?? collection.s.ignoreUndefined ?? false
    };
  }

  execute(server: Server, callback: Callback<Document>): void {
    // copied from `CommandOperationV2`, to be subclassed in the future
    this.server = server;
    const serverWireVersion = maxWireVersion(server);

    const options = this.options;
    if (typeof options.allowDiskUse !== 'undefined' && serverWireVersion < 4) {
      callback(new MongoError('The `allowDiskUse` option is not supported on MongoDB < 3.2'));
      return;
    }

    const findCommand: Document = Object.assign({}, this.cmd);

    if (options.sort) {
      findCommand.sort = formattedOrderClause(options.sort);
    }

    if (options.projection || options.fields) {
      let projection = options.projection || options.fields;
      if (projection && !Buffer.isBuffer(projection) && Array.isArray(projection)) {
        projection = projection.length
          ? projection.reduce((result, field) => {
              result[field] = 1;
              return result;
            }, {})
          : { _id: 1 };
      }

      findCommand.fields = projection;
    }

    if (options.hint) {
      findCommand.hint = normalizeHintField(options.hint);
    }

    if (typeof options.skip === 'number') {
      findCommand.skip = options.skip;
    }

    if (typeof options.limit === 'number') {
      findCommand.limit = options.limit;
    }

    if (typeof options.batchSize === 'number') {
      findCommand.batchSize = options.batchSize;
    }

    if (typeof options.singleBatch === 'boolean') {
      findCommand.singleBatch = options.singleBatch;
    }

    if (options.comment) {
      findCommand.comment = options.comment;
    }

    if (typeof options.maxTimeMS === 'number') {
      findCommand.maxTimeMS = options.maxTimeMS;
    }

    if (this.readConcern && (!this.session || !this.session.inTransaction())) {
      findCommand.readConcern = this.readConcern;
    }

    if (options.max) {
      findCommand.max = options.max;
    }

    if (options.min) {
      findCommand.min = options.min;
    }

    if (typeof options.returnKey === 'boolean') {
      findCommand.returnKey = options.returnKey;
    }

    if (typeof options.showRecordId === 'boolean') {
      findCommand.showRecordId = options.showRecordId;
    }

    if (typeof options.tailable === 'boolean') {
      findCommand.tailable = options.tailable;
    }

    if (typeof options.oplogReplay === 'boolean') {
      findCommand.oplogReplay = options.oplogReplay;
    }

    if (typeof options.timeout === 'boolean') {
      findCommand.noCursorTimeout = options.timeout;
    } else if (typeof options.noCursorTimeout === 'boolean') {
      findCommand.noCursorTimeout = options.noCursorTimeout;
    }

    if (typeof options.awaitData === 'boolean') {
      findCommand.awaitData = options.awaitData;
    } else if (typeof options.awaitdata === 'boolean') {
      findCommand.awaitData = options.awaitdata;
    }

    if (typeof options.allowPartialResults === 'boolean') {
      findCommand.allowPartialResults = options.allowPartialResults;
    } else if (typeof options.partial === 'boolean') {
      findCommand.allowPartialResults = options.partial;
    }

    if (options.collation) {
      if (serverWireVersion < SUPPORTS_WRITE_CONCERN_AND_COLLATION) {
        callback(
          new MongoError(
            `Server ${server.name}, which reports wire version ${serverWireVersion}, does not support collation`
          )
        );

        return;
      }

      findCommand.collation = options.collation;
    }

    if (typeof options.allowDiskUse === 'boolean') {
      findCommand.allowDiskUse = options.allowDiskUse;
    }

    if (typeof options.snapshot === 'boolean') {
      findCommand.snapshot = options.snapshot;
    }

    if (typeof options.showDiskLoc === 'boolean') {
      findCommand.showDiskLoc = options.showDiskLoc;
    }

    // TODO: use `MongoDBNamespace` through and through
    server.query(
      this.ns.toString(),
      findCommand,
      { fullResult: !!this.fullResponse, ...this.options, ...this.bsonOptions },
      callback
    );
  }
}

defineAspects(FindOperation, [Aspect.READ_OPERATION, Aspect.RETRYABLE]);
