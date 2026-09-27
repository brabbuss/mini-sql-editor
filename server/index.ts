import { existsSync } from 'fs';
import path from 'path';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { consoleLogger } from './logger';
import { MAX_RUNS } from './runStore';
import { createServer } from './server';
import { MAX_EXECUTION_SECONDS } from './statement';

const port = 8080; // default port to listen
const clientDir = path.resolve(__dirname, '../dist/client');

// Clients live for the app's lifetime; each request's credentials are passed per query (see clickhouseRequestOptions.ts)
// Their own logging is off: they log every query error, which would duplicate the app's error logs.
// To surface their internal warnings, pass a LoggerClass that forwards to `consoleLogger` instead.
const clientOptions = { url: 'http://localhost:8123', log: { level: ClickHouseLogLevel.OFF } };
// For statements. A run executes one statement at a time, and a running statement holds its connection until it
// ends, so the pool fits every run the store allows at once (MAX_RUNS). It's a maximum: connections open on demand.
// With the client's default (10), runs past the 10th would wait in Node while shown as running.
// Its timeout outlasts the statements' time limit, so ClickHouse stops a slow statement and reports it, rather than
// the client giving up on a statement that keeps running (the default, 30 s, did: see MAX_EXECUTION_SECONDS)
const client = createClient({
  ...clientOptions,
  max_open_connections: MAX_RUNS,
  request_timeout: (MAX_EXECUTION_SECONDS + 30) * 1000
});
// For cancelling: KILLs get their own pool, so a cancel never waits for a connection behind the statements it's
// cancelling (verified: sharing a busy pool, a KILL waited until the running queries had finished)
const controlClient = createClient(clientOptions);
// Most file uploads inserting at once. An upload holds its connection for the whole transfer, so uploads get their own
// small pool rather than taking connections runs need; more wait in Node until one finishes
const INSERT_CONNECTIONS = 5;
const insertClient = createClient({ ...clientOptions, max_open_connections: INSERT_CONNECTIONS });
if (!existsSync(path.join(clientDir, 'index.html'))) {
  consoleLogger.warn(
    'The React app is not built, so / will 404. Run `npm run start` (builds first) or `npm run build`.',
    {
      clientDir
    }
  );
}

// start the Express server
createServer(client, consoleLogger, { clientDir, controlClient, insertClient }).listen(port, () => {
  console.log(`server started at http://localhost:${port}`);
});
