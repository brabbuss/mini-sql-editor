import {
  ConfirmationRequired,
  ErrorBody,
  InsertFormat,
  InsertResult,
  Run,
  RunRequest,
  StatementRef,
  TableRef
} from '../../shared/api';

/** A failed request, as the server reported it (the body shapes come from server/errors.ts). */
export class ApiError extends Error {
  /** ClickHouse's error code and type, when ClickHouse rejected the request */
  readonly code?: string;
  readonly type?: string;
  /** Where in the script a structural error starts (an unterminated string, comment or heredoc) */
  readonly position?: number;

  constructor(
    message: string,
    /** HTTP status, or 0 when the server couldn't be reached at all */
    readonly status: number,
    body?: Partial<ErrorBody>
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = body?.code;
    this.type = body?.type;
    this.position = body?.position;
  }
}

/** A run that started, or the destructive statements to confirm first (nothing ran) */
export type StartResult = { started: true; run: Run } | { started: false; destructive: StatementRef[] };

/** A request cancelled through its AbortSignal: not a failure, the caller no longer needed it */
export function isAbort(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Sends a request to the API. Rejects with ApiError for anything that went wrong, except an abort, which is rethrown
 * as-is so the caller can tell "no longer needed" apart from a failure. Returns the response and its parsed body.
 */
async function request(url: string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    throw new ApiError('Could not reach the server. Is it running?', 0);
  }

  // Error responses are JSON from our server, but a proxy in between (e.g. Vite's in development) may send HTML.
  // A 304 has no body
  const body: unknown = await response.json().catch(() => undefined);
  return { response, body };
}

function toApiError(response: Response, body: unknown) {
  const errorBody = (typeof body === 'object' && body !== null ? body : {}) as Partial<ErrorBody>;
  const message =
    typeof errorBody.error === 'string' ? errorBody.error : `Request failed with status ${response.status}`;
  return new ApiError(message, response.status, errorBody);
}

/**
 * Starts a script as a run on the server; it keeps running there, so follow it with getRun. Deliberately not
 * abortable: once sent, the server may already be running it, and the response carries the only way to reach the run
 * (its id). Stop a run with cancelRun instead.
 */
export async function startRun(
  sql: string,
  { confirmDestructive }: { confirmDestructive?: boolean } = {}
): Promise<StartResult> {
  const payload: RunRequest = { sql, ...(confirmDestructive && { confirmDestructive }) };
  const { response, body } = await request('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (response.status === 409) {
    return { started: false, destructive: (body as ConfirmationRequired).destructive };
  }
  if (!response.ok) {
    throw toApiError(response, body);
  }
  return { started: true, run: body as Run };
}

/**
 * The run's current state, or undefined when it hasn't changed since `etag`: the server then answers 304 without a
 * body, so polling a long statement costs almost nothing. Rejects with a 404 ApiError once the run has expired.
 */
export async function getRun(
  id: string,
  { etag, signal }: { etag?: string; signal?: AbortSignal } = {}
): Promise<{ run: Run; etag?: string } | undefined> {
  // With If-None-Match set here, the browser passes a 304 through instead of answering from its own cache
  const { response, body } = await request(`/api/runs/${encodeURIComponent(id)}`, {
    headers: etag ? { 'If-None-Match': etag } : {}, // only send the run if it no longer matches this
    signal
  });
  if (response.status === 304) {
    return undefined;
  }
  if (!response.ok) {
    throw toApiError(response, body);
  }
  return { run: body as Run, etag: response.headers.get('ETag') ?? undefined };
}

/** Asks the server to cancel the run. Safe to repeat; the run's statements show what was stopped */
export async function cancelRun(id: string): Promise<Run> {
  const { response, body } = await request(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  if (!response.ok) {
    throw toApiError(response, body);
  }
  return body as Run;
}

/** The tables a file can be inserted into, as the current ClickHouse user sees them */
export async function listTables(signal?: AbortSignal): Promise<TableRef[]> {
  const { response, body } = await request('/api/tables', { signal });
  if (!response.ok) {
    throw toApiError(response, body);
  }
  return body as TableRef[];
}

/**
 * Inserts a file into a table. The file itself is the request body, so the browser streams it from disk rather than it
 * being read into memory here. Aborting the signal cancels the upload, and the server then stops the insert
 */
export async function insertFile(
  file: Blob,
  { database, table, format }: { database: string; table: string; format: InsertFormat },
  signal?: AbortSignal
): Promise<InsertResult> {
  const params = new URLSearchParams({ database, table, format });
  const { response, body } = await request(`/api/insert?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    signal
  });
  if (!response.ok) {
    throw toApiError(response, body);
  }
  return body as InsertResult;
}
