import { randomUUID } from 'node:crypto';
import express, { NextFunction, Request, Response, Router } from 'express';
import bodyParser from 'body-parser';
import { ConfirmationRequired, MAX_INSERT_BYTES, MAX_STATEMENTS } from '../shared/api';
import { splitStatements, Statement } from '../shared/splitStatements';
import { clickhouseRequestOptions } from './clickhouseRequestOptions';
import { logHttpError, RequestError, toHttpError } from './errors';
import { InsertClient, insertFile, insertTarget, listTables, tooLargeMessage } from './insert';
import { Logger } from './logger';
import { ControlClient, executeRun, prepareRun, RunClient } from './runner';
import { ownerOf, RunStore, StoredRun } from './runStore';

/**
 * The part of the ClickHouse client the routes use. The API receives one shared client
 * rather than creating it, so tests can substitute a fake.
 */
export type ApiClient = RunClient & InsertClient;

export interface ApiOptions {
  logger: Logger;
  runStore: RunStore;
  /** Sends the KILLs that cancel statements (see runner.ts). Defaults to `client` */
  controlClient?: ControlClient;
  /** Streams file uploads into tables, over its own small pool so uploads can't take runs' connections. Defaults to `client` */
  insertClient?: InsertClient;
  /** Largest file accepted by POST /api/insert; tests pass a small one */
  maxInsertBytes?: number;
}

/** Scripts can be much larger than a single query; body-parser's default is 100 KB */
const BODY_LIMIT = '1mb';

// The body is typed as unknown on purpose: it's whatever the caller sent, so it has to be checked
type RunRequestBody = Request<Record<string, string>, unknown, { sql?: unknown; confirmDestructive?: unknown }>;

/**
 * The API routes. Errors are passed on with next(error); the server's error handler turns them
 * into responses (see createServer in server.ts, which also serves the React app).
 */
export function createApi(
  client: ApiClient,
  { logger, runStore, controlClient, insertClient = client, maxInsertBytes = MAX_INSERT_BYTES }: ApiOptions
): Router {
  const jsonParser = bodyParser.json({ limit: BODY_LIMIT });
  const urlencodedParser = bodyParser.urlencoded({ extended: false, limit: BODY_LIMIT });

  const api = express.Router();

  // Registered before the body parsers: the body is the file itself, streamed to ClickHouse untouched and never held in
  // memory (the JSON parser would otherwise read a JSON-lines file sent as application/json)
  api.post('/api/insert', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Browsers always declare a file's size, so an oversized upload is refused before a byte of it is read
      if (Number(req.headers['content-length']) > maxInsertBytes) {
        throw new RequestError(413, tooLargeMessage(maxInsertBytes));
      }
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) {
          // An upload abandoned halfway (the tab closed) stops the insert in ClickHouse too
          controller.abort();
        }
      });
      const target = insertTarget(req.query);
      const result = await insertFile(insertClient, req, target, {
        queryId: randomUUID(),
        requestOptions: clickhouseRequestOptions(req.headers),
        signal: controller.signal,
        maxBytes: maxInsertBytes
      });
      res.send(result);
    } catch (error) {
      next(error);
    }
  });

  // we handle these middleware throwing via next(err), which routes to the server's error handler (createErrorHandler)
  api.use(jsonParser);
  api.use(urlencodedParser);

  // The tables a file can be inserted into, as the caller sees them
  api.get('/api/tables', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.send(await listTables(client, clickhouseRequestOptions(req.headers)));
    } catch (error) {
      next(error);
    }
  });

  // Runs: a script is split, classified and started in the background; the UI polls its progress and can cancel it
  api.post('/api/runs', (req: RunRequestBody, res: Response, next: NextFunction) => {
    try {
      const statements = statementsFrom(req.body.sql, 'sql');
      if (statements.length > MAX_STATEMENTS) {
        throw new RequestError(
          400,
          `The script has ${statements.length} statements; the limit is ${MAX_STATEMENTS}. Split it into smaller scripts`
        );
      }

      const { confirmDestructive } = req.body;
      // Checked for the whole script before anything runs, so a confirmation never interrupts a half-run script
      const destructive = statements.filter((s) => s.classification.kind === 'destructive');
      if (destructive.length > 0 && confirmDestructive !== true) {
        const details: Omit<ConfirmationRequired, 'error'> = {
          destructive: destructive.map((s) => ({
            index: statements.indexOf(s),
            sql: s.sql,
            start: s.start,
            end: s.end
          }))
        };
        throw new RequestError(409, 'The script deletes or overwrites data; confirm to run it', details);
      }

      const requestOptions = clickhouseRequestOptions(req.headers);
      const prepared = prepareRun(randomUUID(), statements);
      const added = runStore.add(prepared, ownerOf(requestOptions));
      if (!added.ok) {
        throw new RequestError(429, tooManyRunsMessage(added.reason, runStore.maxRunningPerOwner));
      }
      startInBackground(added.stored, requestOptions, { client, controlClient, runStore, logger });

      res.status(202).location(`/api/runs/${prepared.run.id}`).send(prepared.run);
    } catch (error) {
      // routes to the server's error handler (createErrorHandler)
      next(error);
    }
  });

  // Unknown, expired and other people's runs all answer 404, so a run's existence isn't revealed
  const findRun = (req: Request<{ id: string }>) => {
    const stored = runStore.get(req.params.id, ownerOf(clickhouseRequestOptions(req.headers)));
    if (!stored) {
      throw new RequestError(404, 'Run not found. It may have expired, or been started with other credentials');
    }
    return stored;
  };

  // The ETag is the run's version, bumped on every change, so a poll of an unchanged run gets a 304 without the run
  // being serialized (Express's implicit handling of ETag hashes the whole response, every row of every result, on every poll)
  api.get('/api/runs/:id', (req: Request<{ id: string }>, res: Response) => {
    const { prepared } = findRun(req);
    res.set('ETag', `"${prepared.run.id}-${prepared.version}"`);
    if (req.fresh) {
      res.status(304).end();
      return;
    }
    res.send(prepared.run);
  });

  // Cancelling a finished or already-cancelled run changes nothing, so it's safe to repeat
  api.post('/api/runs/:id/cancel', (req: Request<{ id: string }>, res: Response) => {
    const stored = findRun(req);
    stored.controller.abort();
    res.status(202).send(stored.prepared.run);
  });

  // Anything else under /api gets a JSON 404 through the error handler, instead of Express's HTML "Cannot GET" page.
  // Paths outside /api are left to Express: the app has no client-side routes to fall back to
  api.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    next(new RequestError(404, `No such endpoint: ${req.method} ${req.baseUrl}${req.path}`));
  });

  return api;
}

function tooManyRunsMessage(reason: 'ownerBusy' | 'full', maxRunningPerOwner: number) {
  if (reason === 'ownerBusy') {
    const runs = maxRunningPerOwner === 1 ? 'run' : 'runs';
    return `You already have ${maxRunningPerOwner} ${runs} in progress. Wait for one to finish, or cancel one`;
  }
  return 'The server has too many runs in progress. Try again when one finishes';
}

/**
 * A body field holding SQL, split into statements. Rejects what can't run: a missing or non-text field (see
 * requiredText), an unterminated string, comment or heredoc (with its position), and text that's only comments.
 * How many statements are allowed is up to the route.
 */
function statementsFrom(value: unknown, field: string): Statement[] {
  const split = splitStatements(requiredText(value, field));
  if (!split.ok) {
    throw new RequestError(400, split.error.message, { position: split.error.position });
  }
  if (split.statements.length === 0) {
    throw new RequestError(400, `Nothing to run: '${field}' only contains comments`);
  }
  return split.statements;
}

/**
 * A required text field from a request body: missing, null or blank is "required"; anything but a string is
 * rejected too (the client would crash on it, reported as a 500). Returns it as a string.
 */
function requiredText(value: unknown, field: string): string {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    throw new RequestError(400, `'${field}' is required`);
  }
  if (typeof value !== 'string') {
    throw new RequestError(400, `'${field}' must be a string`);
  }
  return value;
}

/**
 * Executes a stored run without holding up the response. executeRun records statement errors itself, so a failure
 * reaching here is a bug; a background task must never fail silently, so it's logged and the run is marked failed.
 */
function startInBackground(
  stored: StoredRun,
  requestOptions: ReturnType<typeof clickhouseRequestOptions>,
  {
    client,
    controlClient,
    runStore,
    logger
  }: { client: ApiClient; controlClient?: ControlClient; runStore: RunStore; logger: Logger }
) {
  const { run } = stored.prepared;
  const signal = stored.controller.signal;
  executeRun(client, stored.prepared, { runId: run.id, requestOptions, signal, logger, controlClient })
    .catch((error) => {
      logHttpError(logger, error, toHttpError(error), { runId: run.id });
      run.status = 'failed';
      run.notice = 'The run stopped because of an internal error';
      run.finishedAt = new Date().toISOString();
      stored.prepared.version++;
    })
    .finally(() => runStore.markFinished(run.id));
}
