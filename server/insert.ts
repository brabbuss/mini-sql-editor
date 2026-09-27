import { Readable, Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ClickHouseClient } from '@clickhouse/client';
import { INSERT_FORMATS, InsertFormat, InsertResult, MAX_INSERT_BYTES, TableRef } from '../shared/api';
import { ClickHouseRequestOptions } from './clickhouseRequestOptions';
import { RequestError } from './errors';

/** The part of the ClickHouse client inserting a file uses */
export type InsertClient = Pick<ClickHouseClient, 'exec'>;

export interface InsertTarget {
  database: string;
  table: string;
  format: InsertFormat;
}

const log_comment = JSON.stringify({ app: 'sql-editor', kind: 'insert' });

/**
 * A ClickHouse identifier, backquoted, with backslashes and backquotes escaped so a name can't end the quoting early and
 * add SQL of its own (verified on 24.6 with a table named we`ird "tab".le)
 */
export function quoteIdentifier(name: string): string {
  return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

/**
 * returns the target table and file format from the query parameters
 */
export function insertTarget(params: Record<string, unknown>): InsertTarget {
  const text = (field: string) => {
    const value = params[field];
    if (Array.isArray(value)) {
      throw new RequestError(400, `'${field}' must be a single value`);
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new RequestError(400, `'${field}' is required`);
    }
    return value;
  };
  const database = text('database');
  const table = text('table');
  const format = text('format');
  if (!(INSERT_FORMATS as readonly string[]).includes(format)) {
    throw new RequestError(400, `Unknown format '${format}'. Use one of: ${INSERT_FORMATS.join(', ')}`);
  }
  return { database, table, format: format as InsertFormat };
}

export function tooLargeMessage(maxBytes: number) {
  const size = maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MB` : `${maxBytes} bytes`;
  return `The file is larger than ${size}, the most this app inserts from a browser upload`;
}

// Counts bytes as they pass, and fails as soon as there are more than maxBytes
function byteLimit(maxBytes: number) {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        // emits an 'error' event as soon as the total goes over the limit. the SDK reading this stream
        // stops its request to ClickHouse and rejects exec with this same error, so insertFile rejects with the 413
        callback(new RequestError(413, tooLargeMessage(maxBytes)));
        return;
      }
      callback(null, chunk);
    }
  });
}

/**
 * Streams a file into a table: the body goes to ClickHouse as it arrives (never held in memory)
 * Not all-or-nothing: ClickHouse writes in blocks of about a million rows, so a bad row
 * after the first block leaves the rows before it in the table. Rejects with a 413
 * RequestError when the body turns out larger than maxBytes.
 */
export async function insertFile(
  client: InsertClient,
  body: Readable,
  { database, table, format }: InsertTarget,
  options: { queryId: string; requestOptions: ClickHouseRequestOptions; signal: AbortSignal; maxBytes?: number }
): Promise<InsertResult> {
  const started = performance.now();
  const limited = byteLimit(options.maxBytes ?? MAX_INSERT_BYTES);
  // pipe, not stream.pipeline. pipeline passes errors along for us, but when anything fails it destroys every stream in
  // the chain, including the request: that closes the connection, so a 413 could never be sent. pipe leaves the request
  // alone, but doesn't pass errors along, so the two listeners below do that part by hand
  body.pipe(limited);
  // The upload broke (e.g. the browser went away): end the stream ClickHouse reads from, so ClickHouse abandons the
  // insert instead of waiting for the rest of the file (tested: it stops within ~70 ms)
  body.on('error', (error) => limited.destroy(error));
  // Either way (over the limit, or the upload broke): stop reading the upload into it.
  // an 'error' event with no listener crashes the process
  limited.on('error', () => body.unpipe(limited));

  const result = await client.exec({
    query: `INSERT INTO ${quoteIdentifier(database)}.${quoteIdentifier(table)} FORMAT ${format}`,
    values: limited,
    query_id: options.queryId,
    abort_signal: options.signal,
    clickhouse_settings: { log_comment },
    ...options.requestOptions
  });
  // An INSERT answers with an empty body; reading it to the end frees the connection
  await finished(result.stream.resume());
  return { rows: Number(result.summary?.written_rows ?? 0), elapsedMs: performance.now() - started };
}

/** Tables a file can go into: no views or dictionaries, no system databases, no temporary tables */
export const TABLES_QUERY =
  "SELECT database, name FROM system.tables WHERE NOT is_temporary AND database NOT IN ('system', 'INFORMATION_SCHEMA', " +
  "'information_schema') AND engine NOT IN ('View', 'MaterializedView', 'LiveView', 'WindowView', 'Dictionary') " +
  'ORDER BY database, name';

/**
 * The tables the caller can see. Asked as the caller: ClickHouse only lists tables they have some grant on (verified: a
 * user with no grants sees none), so nothing is filtered here
 */
export async function listTables(
  client: Pick<ClickHouseClient, 'query'>,
  requestOptions: ClickHouseRequestOptions
): Promise<TableRef[]> {
  const result = await client.query({
    query: TABLES_QUERY,
    format: 'JSONCompact',
    clickhouse_settings: { log_comment },
    ...requestOptions
  });
  const { data } = (await result.json()) as unknown as { data: [string, string][] };
  return data.map(([database, name]) => ({ database, name }));
}
