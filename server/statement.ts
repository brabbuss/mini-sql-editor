import { ClickHouseClient, ClickHouseError } from '@clickhouse/client';
import { Column, ROW_CAP } from '../shared/api';
import { Statement } from '../shared/splitStatements';
import { ClickHouseRequestOptions } from './clickhouseRequestOptions';
import { RequestError } from './errors';

/** The part of the ClickHouse client executing a statement uses */
export type StatementClient = Pick<ClickHouseClient, 'query' | 'command'>;

/**
 * How long ClickHouse lets a statement run (max_execution_time), after which it stops it with TIMEOUT_EXCEEDED. The
 * client's request timeout must be longer (see index.ts): when the client gave up first, the statement was reported
 * as failed but kept running, and a write finished after the error (verified). Sent with each statement, so it
 * overrides a script's `SET max_execution_time` (verified); a statement's own SETTINGS clause still overrides it
 */
export const MAX_EXECUTION_SECONDS = 300;

export interface StatementOptions {
  queryId: string;
  /** A ClickHouse session to run in, so USE, SET and temporary tables carry over from earlier statements */
  sessionId?: string;
  /** The caller's ClickHouse login and forwarded headers */
  requestOptions: ClickHouseRequestOptions;
  /** Merged into the query's log_comment, so the app's queries can be found in system.query_log */
  tag: Record<string, unknown>;
  /** Defaults to MAX_EXECUTION_SECONDS; tests pass a short one */
  maxExecutionSeconds?: number;
}

/** The result of a statement that returns rows */
export interface StatementOutput {
  columns: Column[];
  /** At most ROW_CAP rows, as arrays in column order */
  rows: unknown[][];
  /** More than ROW_CAP rows existed */
  truncated: boolean;
  stats: { rowsRead: number; bytesRead: number };
}

// JSONCompact's response. `exception` only appears when an error happens after rows were sent, which
// wait_end_of_query prevents; it's checked anyway so a partial result can never pass as a success.
interface CompactResult {
  meta?: { name: string; type: string }[];
  data: unknown[][];
  statistics?: { rows_read: number; bytes_read: number };
  exception?: string;
}

const FORMAT_CLAUSE_MESSAGE =
  'Remove the FORMAT clause: the editor shows results as a table and chooses the format itself.';

/**
 * Executes one statement (as split and classified by splitStatements). Returns its result if it returns rows,
 * nothing otherwise, and throws on failure. Knows nothing about runs (sessions, cancelling, statuses): the runner
 * builds those on top of it.
 */
export async function executeStatement(
  client: StatementClient,
  statement: Statement,
  { queryId, sessionId, requestOptions, tag, maxExecutionSeconds = MAX_EXECUTION_SECONDS }: StatementOptions
): Promise<StatementOutput | undefined> {
  const { returnsRows, hasFormatClause } = statement.classification;
  // Tags the query in system.query_log, so the app's queries can be found (and runs grouped)
  const log_comment = JSON.stringify({ app: 'sql-editor', ...tag });
  const common = {
    query: statement.sql,
    query_id: queryId,
    ...(sessionId && { session_id: sessionId }),
    ...requestOptions
  };

  if (!returnsRows) {
    // Sent as-is. client.query would append FORMAT, which breaks INSERT … VALUES, SET and USE, and makes DDL
    // report a failure after it has already run
    await client.command({ ...common, clickhouse_settings: { log_comment, max_execution_time: maxExecutionSeconds } });
    return undefined;
  }
  if (hasFormatClause) {
    throw new RequestError(400, FORMAT_CLAUSE_MESSAGE);
  }

  const resultSet = await client.query({
    ...common,
    format: 'JSONCompact',
    clickhouse_settings: {
      log_comment,
      max_execution_time: maxExecutionSeconds,
      // Otherwise an error partway through a result arrives as HTTP 200 and the partial rows pass as a success
      wait_end_of_query: 1,
      // Stop reading past the cap. ClickHouse stops at a block boundary once it has reached the limit, so it can
      // return exactly the limit even when more rows exist; with ROW_CAP + 1, "more than ROW_CAP returned" means
      // truncated in every case (verified across block sizes). The exact cap is applied below
      max_result_rows: String(ROW_CAP + 1),
      result_overflow_mode: 'break'
    }
  });
  const response = (await resultSet.json<unknown[]>()) as CompactResult;
  if (response.exception) {
    throw clickHouseErrorFrom(response.exception);
  }

  return {
    columns: response.meta ?? [],
    // Exact: ClickHouse returns more than ROW_CAP rows exactly when more exist (see max_result_rows)
    truncated: response.data.length > ROW_CAP,
    rows: response.data.slice(0, ROW_CAP),
    stats: { rowsRead: response.statistics?.rows_read ?? 0, bytesRead: response.statistics?.bytes_read ?? 0 }
  };
}

/** Turns an error ClickHouse wrote into a response body ("Code: 395. DB::Exception: … (TYPE)") into a ClickHouseError */
function clickHouseErrorFrom(exception: string) {
  const code = /Code: (\d+)/.exec(exception)?.[1] ?? '0';
  const type = /\(([A-Z][A-Z_]+)\)/.exec(exception)?.[1];
  const message = exception.replace(/^Code: \d+\. DB::Exception: /, '');
  return new ClickHouseError({ message, code, type });
}
