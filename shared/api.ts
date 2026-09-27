import { StatementKind } from './classify';

/**
 * The HTTP API's response shapes, shared by the server and the browser so a change on one side is a compile
 * error on the other.
 */

/** Rows kept per statement; more than this and the result is marked truncated */
export const ROW_CAP = 10_000;
/** Statements allowed in one script, to keep each run's results bounded in memory */
export const MAX_STATEMENTS = 200;

/** POST /api/runs */
export interface RunRequest {
  sql: string;
  /** Required when the script contains destructive statements (see ConfirmationRequired) */
  confirmDestructive?: boolean;
}

/** Every error response */
export interface ErrorBody {
  error: string;
  /** ClickHouse's error code and type, when ClickHouse rejected the request */
  code?: string;
  type?: string;
  /** Where in the script a structural error starts (an unterminated string, comment or heredoc) */
  position?: number;
}

/**
 * Whose problem an error is: the caller's (bad SQL, bad credentials), ClickHouse's availability (unreachable, too
 * slow), or a bug in this server.
 */
export type Fault = 'client' | 'upstream' | 'server';

/**
 * A statement's error. A run answers 200 even when a statement fails, so the fault takes the place of the HTTP
 * status: it tells "fix your SQL" apart from "ClickHouse is down" and "our bug"
 */
export interface StatementError extends ErrorBody {
  fault: Fault;
}

/** Where a statement sits in the script, for pointing at it in the editor */
export interface StatementRef {
  index: number;
  sql: string;
  start: number;
  end: number;
}

/**
 * 409 from POST /api/runs: the script deletes or overwrites data (DROP, TRUNCATE, DELETE, ALTER … UPDATE …) and
 * confirmDestructive wasn't set. Nothing has run. A safety net against accidents, not security: ClickHouse grants
 * decide what a user may actually do.
 */
export interface ConfirmationRequired extends ErrorBody {
  destructive: StatementRef[];
}

/** A result column, from ClickHouse's JSONCompact metadata */
export interface Column {
  name: string;
  /** ClickHouse type, e.g. UInt64, Nullable(String) */
  type: string;
}

export type StatementStatus = 'pending' | 'running' | 'ok' | 'error' | 'cancelled' | 'skipped';

export interface StatementResult {
  index: number;
  /** The statement's exact text, and where it sits in the script */
  sql: string;
  start: number;
  end: number;
  kind: StatementKind;
  status: StatementStatus;
  elapsedMs?: number; // total on our end, not total on ClickHouse's end
  /** For statements that return rows. Rows are arrays in column order; 64-bit integers arrive as strings */
  columns?: Column[];
  rows?: unknown[][];
  /** More than ROW_CAP rows existed; rows holds the first ROW_CAP */
  truncated?: boolean;
  stats?: { rowsRead: number; bytesRead: number };
  error?: StatementError;
}

export type RunStatus = 'running' | 'finished' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  status: RunStatus;
  statements: StatementResult[];
  /** ISO timestamps */
  startedAt: string;
  finishedAt?: string;
  /** Something the user should know about the run as a whole, e.g. why a cancel couldn't stop a statement */
  notice?: string;
}

/**
 * Formats a file can be inserted in (POST /api/insert). The file is sent to ClickHouse as-is, so the names are
 * ClickHouse's: CSV and TSV with a header row (columns matched by name), JSON lines, and Parquet
 */
export const INSERT_FORMATS = ['CSVWithNames', 'TabSeparatedWithNames', 'JSONEachRow', 'Parquet'] as const;
export type InsertFormat = (typeof INSERT_FORMATS)[number];

/** Largest file POST /api/insert accepts. Bigger loads belong in clickhouse-client or S3 table functions, not a browser upload */
export const MAX_INSERT_BYTES = 100 * 1024 * 1024;

/** GET /api/tables: a table the caller can see (ClickHouse hides the ones they have no grants on) */
export interface TableRef {
  database: string;
  name: string;
}

/** POST /api/insert?database=…&table=…&format=…, with the file as the body */
export interface InsertResult {
  /** Rows ClickHouse wrote */
  rows: number;
  elapsedMs: number;
}
