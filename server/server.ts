import express, { ErrorRequestHandler } from 'express';
import { ApiClient, createApi } from './api';
import { logHttpError, toHttpError } from './errors';
import { consoleLogger, Logger } from './logger';
import { InsertClient } from './insert';
import { ControlClient } from './runner';
import { RunStore } from './runStore';

/**
 * Sends every error through the same mapping: JSON response, fault, log entry.
 * Registered once, at the end of createServer; exported for its own tests.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Keep all 4 parameters: Express recognises error handlers by their count
  return (error, req, res, next) => {
    const httpError = toHttpError(error);
    logHttpError(logger, error, httpError, { method: req.method, path: req.path });

    // The response was already partly sent, so it can't become a JSON error; Express can only close the connection
    if (res.headersSent) {
      next(error);
      return;
    }
    // Set explicitly: middleware that failed partway (e.g. serving a file) may have set another content type
    res.status(httpError.status).type('json').send(httpError.body);
  };
}

/**
 * The whole app from one server: the built React app at / and the API alongside it.
 *
 * @param options.clientDir the built React app (`npm run build`). Omitted when only the API is needed, e.g. in tests.
 * @param options.runStore where runs are kept; tests pass one with small limits
 * @param options.insertClient streams file uploads into tables, over its own small pool (see index.ts). Defaults to
 *   `client`
 * @param options.maxInsertBytes the largest file upload accepted; tests pass a small one
 * @param options.controlClient sends the KILLs that cancel statements, over its own connection pool (see index.ts).
 *   Defaults to `client`
 */
export function createServer(
  client: ApiClient,
  logger: Logger = consoleLogger,
  {
    clientDir,
    runStore = new RunStore(),
    controlClient,
    insertClient,
    maxInsertBytes
  }: {
    clientDir?: string;
    runStore?: RunStore;
    controlClient?: ControlClient;
    insertClient?: InsertClient;
    maxInsertBytes?: number;
  } = {}
) {
  const server = express();

  if (clientDir) {
    server.use(express.static(clientDir));
  }
  server.use(createApi(client, { logger, runStore, controlClient, insertClient, maxInsertBytes }));

  // Every error ends here: the API's (including body-parser's malformed JSON or oversized body, raised before a
  // route runs) and static serving's (e.g. an unreadable file). Same JSON response and logging, instead of
  // defaulting to Express's HTML page, which shows stack traces or file paths.
  server.use(createErrorHandler(logger));

  return server;
}
