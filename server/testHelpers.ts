import http from 'node:http';
import { Readable } from 'node:stream';
import { ClickHouseClient, ClickHouseError, CommandParams, ExecParams, QueryParams } from '@clickhouse/client';
import { Express } from 'express';
import supertest from 'supertest';
import { InsertClient } from './insert';
import { ControlClient, RunClient } from './runner';
import { LogFields, Logger } from './logger';

/** Servers started by startTestServer, until closeTestServers */
const testServers = new Set<http.Server>();

/**
 * Serves `app` on 127.0.0.1 and returns supertest for it. Given the app itself, supertest listens on every address
 * but connects to 127.0.0.1, and on macOS another program listening on 127.0.0.1 at the same port takes that
 * connection: random ECONNRESET, "socket hang up" or a stranger's 404 (measured: 5 in 6,000 requests; 0 in 6,000
 * when bound to 127.0.0.1). Binding to an address is asynchronous, so it has to happen before supertest gets the
 * server, and supertest then leaves closing it to us: call closeTestServers after a file's tests.
 */
export async function startTestServer(app: Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  testServers.add(server);
  return supertest(server);
}

/** supertest for a server started by startTestServer */
export type TestApi = Awaited<ReturnType<typeof startTestServer>>;

export async function closeTestServers() {
  await Promise.all([...testServers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  testServers.clear();
}

/** Records log entries instead of printing them */
export function recordingLogger() {
  const entries: { level: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    info: (_message, fields) => entries.push({ level: 'info', fields }),
    warn: (_message, fields) => entries.push({ level: 'warn', fields }),
    error: (_message, fields) => entries.push({ level: 'error', fields })
  };
  return { logger, entries };
}

/** A call the fake received: which client method, everything it was sent, and for exec the body it read */
type Call = { method: 'query' | 'command' | 'exec'; params: QueryParams | CommandParams | ExecParams; body?: string };

/** How the fake answers one statement */
interface Outcome {
  /** Rows to return (JSONCompact arrays). Default: one row, [1] */
  data?: unknown[][];
  /** Columns to return. Default: one UInt8 column named "1" */
  meta?: { name: string; type: string }[];
  /** Fail the statement with this error instead of answering */
  error?: Error;
  /** Put this error text in the response body, as ClickHouse does when a query fails after sending rows */
  exception?: string;
  /** For an insert (exec): the rows ClickHouse reports as written */
  writtenRows?: number;
}

interface FakeRunOptions {
  /** Keep this statement "running" until the test calls release(), or a KILL cancels it */
  holdSql?: string;
  /** Fail every KILL with this error, e.g. ACCESS_DENIED for a user who can't see their running queries */
  killError?: Error;
  /** How many KILLs match nothing first, as when one arrives before ClickHouse has registered the query */
  killsIgnored?: number;
}

/**
 * A fake ClickHouse for runs: answers each statement from `outcomes` (by its SQL), records every call, and can hold a
 * statement until the test releases it or a KILL arrives.
 *
 * @param outcomes how to answer each statement, keyed by its exact SQL; statements not listed get the defaults
 * @returns `client` to pass to the code under test, `calls` it received (in order), `release()` to let a held
 *   statement finish, and a separate `controlClient` for KILLs, whose calls are recorded in `controlCalls`
 */
export function fakeRunClickHouse(outcomes: Record<string, Outcome> = {}, options: FakeRunOptions = {}) {
  let killsToIgnore = options.killsIgnored ?? 0;
  const calls: Call[] = [];
  const controlCalls: Call[] = [];
  let releaseHeld: (() => void) | undefined;
  let rejectHeld: ((error: Error) => void) | undefined;
  const held = new Promise<void>((resolve, reject) => {
    releaseHeld = resolve;
    rejectHeld = reject;
  });

  const answer = async (sql: string) => {
    if (sql === options.holdSql) {
      await held;
    }
    const outcome = outcomes[sql] ?? {};
    if (outcome.error) {
      throw outcome.error;
    }
    return outcome;
  };

  const query = async (params: QueryParams) => {
    calls.push({ method: 'query', params });
    const outcome = await answer(params.query);
    const data = outcome.data ?? [[1]];
    return {
      json: async () => ({
        meta: outcome.meta ?? [{ name: '1', type: 'UInt8' }],
        data,
        rows: data.length,
        statistics: { elapsed: 0.001, rows_read: data.length, bytes_read: data.length * 8 },
        ...(outcome.exception && { exception: outcome.exception })
      })
    };
  };
  const kill = () => {
    if (options.killError) {
      throw options.killError;
    }
    if (killsToIgnore > 0) {
      killsToIgnore--;
      return {};
    }
    rejectHeld?.(new ClickHouseError({ message: 'Query was cancelled', code: '394', type: 'QUERY_WAS_CANCELLED' }));
    return {};
  };
  const command = async (params: CommandParams) => {
    calls.push({ method: 'command', params });
    if (params.query.startsWith('KILL QUERY')) {
      return kill();
    }
    await answer(params.query);
    return {};
  };
  // Inserts: reads the uploaded body as ClickHouse would, so a stream that fails partway (e.g. the size cap) fails the
  // insert, then answers from the outcome for its SQL
  const exec = async (params: ExecParams & { values: Readable }) => {
    const call: Call = { method: 'exec', params };
    calls.push(call);
    const chunks: Buffer[] = [];
    for await (const chunk of params.values) {
      chunks.push(Buffer.from(chunk));
    }
    call.body = Buffer.concat(chunks).toString();
    const outcome = await answer(params.query);
    return {
      stream: Readable.from([]),
      query_id: params.query_id ?? 'fake',
      summary: { written_rows: String(outcome.writtenRows ?? 0) }
    };
  };
  // Another client to the same ClickHouse, as index.ts creates for cancelling: its KILLs reach the same statements
  const controlCommand = async (params: CommandParams) => {
    controlCalls.push({ method: 'command', params });
    return params.query.startsWith('KILL QUERY') ? kill() : {};
  };

  const client: RunClient & InsertClient = {
    query: query as unknown as ClickHouseClient['query'],
    command: command as unknown as ClickHouseClient['command'],
    exec: exec as unknown as ClickHouseClient['exec']
  };
  const controlClient: ControlClient = { command: controlCommand as unknown as ClickHouseClient['command'] };
  return { client, calls, release: () => releaseHeld?.(), controlClient, controlCalls };
}
