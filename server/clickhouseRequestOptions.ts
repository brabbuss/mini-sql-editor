import { IncomingHttpHeaders } from 'http';

const CLICKHOUSE_HEADER_PREFIX = 'x-clickhouse-';
const USER_HEADER = CLICKHOUSE_HEADER_PREFIX + 'user';
const KEY_HEADER = CLICKHOUSE_HEADER_PREFIX + 'key';

export interface ClickHouseRequestOptions {
  auth?: { username: string; password: string };
  http_headers: Record<string, string>;
}

/**
 * Maps a request's x-clickhouse-* headers to per-query ClickHouse options.
 *
 * User and key become the query's login instead of being forwarded as headers: the client always
 * sends its own auth header, and ClickHouse rejects a request carrying both (error 516).
 * Other x-clickhouse-* headers (e.g. X-ClickHouse-Database) are forwarded as-is
 */
export function clickhouseRequestOptions(headers: IncomingHttpHeaders): ClickHouseRequestOptions {
  const httpHeaders: Record<string, string> = {};
  let username: string | undefined;
  let password: string | undefined;

  for (const [key, value] of Object.entries(headers)) {
    if (!key.startsWith(CLICKHOUSE_HEADER_PREFIX) || value === undefined) {
      continue;
    }

    const joined = Array.isArray(value) ? value.join(', ') : value;

    if (key === USER_HEADER) {
      username = joined;
    } else if (key === KEY_HEADER) {
      password = joined;
    } else {
      httpHeaders[key] = joined;
    }
  }

  if (username === undefined && password === undefined) {
    return { http_headers: httpHeaders };
  }

  // match CH handling: key without a user logs in as `default`, user without a key has an empty '' password
  return { auth: { username: username ?? 'default', password: password ?? '' }, http_headers: httpHeaders };
}
