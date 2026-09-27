import { ClickHouseError } from '@clickhouse/client';
import { ErrorBody, Fault } from '../shared/api';
import { LogFields, Logger } from './logger';

export interface HttpError {
  status: number;
  fault: Fault;
  body: ErrorBody & Record<string, unknown>;
}

/**
 * A request this server rejects itself, before reaching ClickHouse (e.g. a missing field).
 * Shaped like body-parser's errors (from `http-errors`): a 4xx `status`, and `expose` marking the
 * message as safe to show the caller, so both are handled the same way.
 */
export class RequestError extends Error {
  readonly expose = true;

  constructor(
    readonly status: number,
    message: string,
    /** Extra fields for the response body, e.g. the position of an unterminated string */
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

function isExposedClientError(error: unknown): error is Error & { status: number } {
  if (!(error instanceof Error)) {
    return false;
  }
  const { status, expose } = error as Error & { status?: unknown; expose?: unknown };
  return expose === true && typeof status === 'number' && status >= 400 && status < 500;
}

// Node network error codes meaning ClickHouse couldn't be reached
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EPIPE']);

// The OS gave up connecting: ClickHouse didn't answer in time
const CONNECT_TIMEOUT_CODE = 'ETIMEDOUT';

// The client reports its own request_timeout as a plain Error with this message: no class or code to check.
// Guarded by an integration test, so a change in the client fails a test instead of turning timeouts into 500s.
// TODO: in the script runner, own the timeout with an AbortSignal and check the signal instead of this message.
const CLIENT_TIMEOUT_MESSAGE = 'Timeout error.';

/**
 * Maps any error from handling a request to an HTTP response.
 *
 * ClickHouse's own HTTP statuses aren't used: it answers some plain user mistakes with 500
 * (e.g. `SELECT 1 + 'a'`). Instead, any error ClickHouse returned means it received and rejected
 * the request, so it's the caller's problem (4xx).
 */
export function toHttpError(error: unknown): HttpError {
  // Our validation errors, and body-parser's (malformed JSON, body over the size limit)
  if (isExposedClientError(error)) {
    const details = error instanceof RequestError ? error.details : {};
    return { status: error.status, fault: 'client', body: { error: error.message, ...details } };
  }

  if (error instanceof ClickHouseError) {
    const body = { error: error.message, code: error.code, ...(error.type && { type: error.type }) };
    if (error.type === 'AUTHENTICATION_FAILED') {
      return { status: 401, fault: 'client', body };
    }
    if (error.type === 'ACCESS_DENIED') {
      return { status: 403, fault: 'client', body };
    }
    // Every other ClickHouse error is the caller's query or its limits
    // Ccan get more exhaustive as needed
    return { status: 400, fault: 'client', body };
  }

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && NETWORK_ERROR_CODES.has(code)) {
      // No `code` in the body: it's reserved for ClickHouse's error codes. The network code goes to the log.
      return { status: 502, fault: 'upstream', body: { error: 'ClickHouse is unreachable' } };
    }
    if (code === CONNECT_TIMEOUT_CODE || error.message === CLIENT_TIMEOUT_MESSAGE) {
      return { status: 504, fault: 'upstream', body: { error: 'ClickHouse did not respond in time' } };
    }
  }

  // Details stay in the server log; the response doesn't expose internals.
  return { status: 500, fault: 'server', body: { error: 'Internal server error' } };
}

/**
 * Logs every failed request with its fault. Since caller mistakes are routine, they're info;
 * anything upstream or server-side needs attention.
 */
export function logHttpError(logger: Logger, error: unknown, httpError: HttpError, context: LogFields) {
  const fields = {
    ...context,
    status: httpError.status,
    fault: httpError.fault,
    // From the error, not the body: includes network codes (e.g. ECONNREFUSED) the response leaves out
    code: (error as { code?: unknown } | null)?.code,
    type: httpError.body.type,
    message: error instanceof Error ? error.message : String(error)
  };
  if (httpError.fault === 'client') {
    logger.info('request failed', fields);
  } else {
    logger.error('request failed', { ...fields, stack: error instanceof Error ? error.stack : undefined });
  }
}
