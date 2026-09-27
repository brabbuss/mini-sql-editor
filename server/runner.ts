import { ClickHouseClient, ClickHouseError } from '@clickhouse/client';
import { Run } from '../shared/api';
import { Statement } from '../shared/splitStatements';
import { ClickHouseRequestOptions } from './clickhouseRequestOptions';
import { logHttpError, toHttpError } from './errors';
import { Logger } from './logger';
import { executeStatement, StatementClient } from './statement';

/** The part of the ClickHouse client a run uses: the same as for executing one statement */
export type RunClient = StatementClient;
/** The part of the ClickHouse client that sends KILLs (see ExecuteOptions.controlClient) */
export type ControlClient = Pick<ClickHouseClient, 'command'>;

export interface ExecuteOptions {
  runId: string;
  /** The caller's ClickHouse login and forwarded headers, used for every statement and for cancelling */
  requestOptions: ClickHouseRequestOptions;
  /** Aborted when the user cancels the run */
  signal: AbortSignal;
  logger: Logger;
  /**
   * Sends the KILLs that cancel a statement. Should have its own connection pool: a running statement holds its
   * connection until it ends, so a KILL sharing their pool can wait behind the very statements it's cancelling.
   * Defaults to `client`.
   */
  controlClient?: ControlClient;
  /** How long ClickHouse lets each statement run. Defaults to MAX_EXECUTION_SECONDS (statement.ts) */
  maxExecutionSeconds?: number;
}

// Killing your own query only needs to see it: SELECT on system.processes. (The KILL QUERY privilege is for other
// users' queries.) Verified on 24.6
const CANCEL_DENIED_NOTICE =
  "Couldn't cancel: your ClickHouse user needs permission to see its running queries (SELECT on system.processes). " +
  'The running statement finished on the server; the statements after it were skipped.';
// A KILL that reaches ClickHouse before the query has registered matches nothing, silently, so it's repeated
// until the statement ends: at most KILL_ATTEMPTS times, KILL_RETRY_MS apart
const KILL_ATTEMPTS = 5;
const KILL_RETRY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A run plus what the server needs to execute it. Built by prepareRun, so the two arrays always line up by index.
 * Stays on the server: only `run` is sent to the browser.
 */
export interface PreparedRun {
  /** The public view, updated as the run executes so it can be served while it runs */
  run: Run;
  /** The statements to execute (SQL, position and classification), in the same order as run.statements */
  statements: Statement[];
  /**
   * Bumped whenever `run` changes. It's the ETag polls are answered with, so an unchanged run gets a 304 without being
   * serialized; a change that doesn't bump it is never seen by the browser
   */
  version: number;
}

/** A run whose statements are all waiting to run */
export function prepareRun(id: string, statements: Statement[]): PreparedRun {
  const run: Run = {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    statements: statements.map((statement, index) => ({
      index,
      sql: statement.sql,
      start: statement.start,
      end: statement.end,
      kind: statement.classification.kind,
      status: 'pending'
    }))
  };
  return { run, statements, version: 0 };
}

/**
 * Runs a script's statements in order, in one ClickHouse session so USE, SET and temporary tables carry over,
 * and stops at the first error. Updates `run` as it goes, so its current state can be served while it runs.
 */
export async function executeRun(client: RunClient, prepared: PreparedRun, options: ExecuteOptions) {
  const { run, statements } = prepared;
  const { runId, requestOptions, signal, logger, controlClient = client, maxExecutionSeconds } = options;
  // The statement being run, if any
  let running: RunningStatement | undefined;

  // Cancel the running statement by its query_id (set for each query below before runStatement)
  // only listen to the first abort then clean up
  // cancels during await runStatement
  signal.addEventListener(
    'abort',
    () => {
      const target = running;
      if (!target) {
        // statement has finished, nothing to cancel
        return;
      }
      void killUntilEnded(controlClient, target, requestOptions).then((notice) => {
        if (notice) {
          run.notice = notice;
          prepared.version++;
        }
      });
    },
    { once: true }
  );

  let failed = false;
  for (const [index, statement] of statements.entries()) {
    const result = run.statements[index];

    if (failed || signal.aborted) {
      // this handles the case of a user attempting to cancel a query but is unable to
      // even though the running query cannot be cancelled, we prevent the rest of the statements
      // from running
      result.status = 'skipped';
      prepared.version++;
      continue;
    }

    result.status = 'running';
    prepared.version++;
    const queryId = `${runId}-${index}`;
    const started = performance.now();
    const execution = executeStatement(client, statement, {
      queryId,
      sessionId: runId,
      requestOptions,
      tag: { runId, index },
      maxExecutionSeconds
    }).then((output) => {
      if (output) {
        Object.assign(result, output);
      }
    });
    running = { queryId, ended: execution.then(ignore, ignore) };
    try {
      await execution;
      result.status = 'ok';
    } catch (error) {
      if (signal.aborted && error instanceof ClickHouseError && error.type === 'QUERY_WAS_CANCELLED') {
        result.status = 'cancelled';
      } else {
        const httpError = toHttpError(error);
        logHttpError(logger, error, httpError, { runId, statement: index + 1 });
        result.status = 'error';
        result.error = { ...httpError.body, fault: httpError.fault };
        failed = true;
      }
    } finally {
      // clean up in case cancel arrives after runStatement
      running = undefined;
      result.elapsedMs = performance.now() - started;
      // Once for the result, status and time: set together, so no poll can see some without the others
      prepared.version++;
    }
  }

  run.status = signal.aborted ? 'cancelled' : failed ? 'failed' : 'finished';
  run.finishedAt = new Date().toISOString();
  prepared.version++;
}

/** A statement being run: its query_id, and a promise that settles when it ends (either way) */
interface RunningStatement {
  queryId: string;
  ended: Promise<void>;
}

/**
 * Kills a running statement by its query_id, repeating the KILL until the statement ends: one that arrives before
 * ClickHouse has registered the query matches nothing. Never throws; returns why it couldn't, if it couldn't.
 */
async function killUntilEnded(
  client: ControlClient,
  target: RunningStatement,
  requestOptions: ClickHouseRequestOptions
): Promise<string | undefined> {
  // KILL's WHERE clause is itself the "is it running yet?" check, so it's simply repeated until the statement ends
  for (let attempt = 1; attempt <= KILL_ATTEMPTS; attempt++) {
    try {
      // Not in the run's session: it's busy with the statement being killed
      await client.command({
        query: 'KILL QUERY WHERE query_id = {queryId:String} SYNC',
        query_params: { queryId: target.queryId },
        ...requestOptions
      });
    } catch (error) {
      return error instanceof ClickHouseError && error.type === 'ACCESS_DENIED'
        ? CANCEL_DENIED_NOTICE
        : `Couldn't cancel: ${error instanceof Error ? error.message : String(error)}`;
    }

    // Whichever comes first: the statement ends, or the retry interval passes
    // Ending doesn't mean the query was killed - it may also have finished or failed just before the KILL was received.
    // Either way there's nothing left to kill, the loop in executeRun records which of those it was
    const outcome = await Promise.race([
      target.ended.then(() => 'ended' as const),
      sleep(KILL_RETRY_MS).then(() => 'running' as const)
    ]);

    if (outcome === 'ended') {
      return undefined;
    }
  }
  return undefined;
}

function ignore() {
  // Only whether the statement has ended matters here; its result or error is handled in the loop
}
