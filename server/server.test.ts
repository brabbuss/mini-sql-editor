import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createErrorHandler, createServer } from './server';
import { closeTestServers, fakeRunClickHouse, recordingLogger, startTestServer } from './testHelpers';

after(closeTestServers);

describe('createServer', () => {
  // Stands in for the built React app
  let clientDir: string;
  before(() => {
    clientDir = mkdtempSync(path.join(tmpdir(), 'sql-editor-client-'));
    writeFileSync(path.join(clientDir, 'index.html'), '<div id="root"></div>');
  });
  after(() => rmSync(clientDir, { recursive: true, force: true }));

  it('serves the React app at /', async () => {
    const api = await startTestServer(
      createServer(fakeRunClickHouse().client, recordingLogger().logger, { clientDir })
    );
    const res = await api.get('/');

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.text, '<div id="root"></div>');
  });

  it('serves the API alongside the React app', async () => {
    const api = await startTestServer(
      createServer(fakeRunClickHouse().client, recordingLogger().logger, { clientDir })
    );
    const res = await api.post('/api/runs').send({ sql: 'SELECT 1' });

    assert.equal(res.status, 202);
    assert.equal(res.body.statements[0].sql, 'SELECT 1');
  });

  // Express's default is an HTML "Cannot GET" page; API callers get JSON for every error
  it('answers an unknown API path with a JSON 404', async () => {
    const log = recordingLogger();
    const api = await startTestServer(createServer(fakeRunClickHouse().client, log.logger, { clientDir }));
    const res = await api.get('/api/nope');

    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.deepEqual(res.body, { error: 'No such endpoint: GET /api/nope' });
    assert.equal(log.entries[0].fields?.fault, 'client');
  });
});

describe('createErrorHandler', () => {
  // createServer registers it after the static files it serves, outside the API routes
  it('gives errors from other middleware the same JSON response and logging', async () => {
    const log = recordingLogger();
    const server = express();
    server.use((_req, res, next) => {
      // What serving an unreadable file produces: the content type is already set, then the read fails
      // with an internal error whose message includes the file's path
      res.type('html');
      next(
        Object.assign(new Error("EACCES: permission denied, open '/srv/app/index.html'"), {
          status: 500,
          expose: false
        })
      );
    });
    server.use(createErrorHandler(log.logger));

    const api = await startTestServer(server);
    const res = await api.get('/');

    assert.equal(res.status, 500);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.deepEqual(res.body, { error: 'Internal server error' });
    assert.equal(log.entries[0].level, 'error');
    assert.equal(log.entries[0].fields?.fault, 'server');
  });

  it('logs and hands the error back to Express when the response was already partly sent', () => {
    const log = recordingLogger();
    const error = new Error('stream failed');
    const passedOn: unknown[] = [];
    const res = { headersSent: true, status: () => assert.fail('must not write a new response') };

    createErrorHandler(log.logger)(error, { method: 'GET', path: '/' } as never, res as never, (e?: unknown) =>
      passedOn.push(e)
    );

    assert.deepEqual(passedOn, [error]);
    assert.equal(log.entries[0].fields?.fault, 'server');
  });
});
