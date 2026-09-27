import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Run } from '../../shared/api';
import { ApiError, cancelRun, getRun, insertFile, listTables, startRun } from './api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records what fetch was sent, and answers with `status` and `body` (a string is sent as-is, anything else as JSON) */
function respondWith(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const sent: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    const text = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json', ...headers } });
  };
  return sent;
}

const run: Run = { id: 'run-1', status: 'running', statements: [], startedAt: '2026-01-01T00:00:00.000Z' };

describe('startRun', () => {
  it('posts the script to /api/runs and returns the started run', async () => {
    const sent = respondWith(202, run);

    const result = await startRun('SELECT 1');

    assert.deepEqual(result, { started: true, run });
    assert.equal(sent[0].url, '/api/runs');
    assert.equal(sent[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(sent[0].init?.body)), { sql: 'SELECT 1' });
  });

  it('sends the confirmation for destructive statements when given', async () => {
    const sent = respondWith(202, run);

    await startRun('DROP TABLE t', { confirmDestructive: true });

    assert.deepEqual(JSON.parse(String(sent[0].init?.body)), { sql: 'DROP TABLE t', confirmDestructive: true });
  });

  // Not an error: nothing ran, and the user decides whether to go ahead
  it('returns the destructive statements when the server asks for confirmation', async () => {
    const destructive = [{ index: 1, sql: 'DROP TABLE t', start: 10, end: 22 }];
    respondWith(409, { error: 'The script deletes or overwrites data; confirm to run it', destructive });

    assert.deepEqual(await startRun('SELECT 1; DROP TABLE t'), { started: false, destructive });
  });

  it("rejects with the server's error, status and where in the script it is", async () => {
    respondWith(400, { error: 'Unterminated string', position: 7 });

    await assert.rejects(startRun("SELECT 'oops"), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'Unterminated string');
      assert.equal(error.status, 400);
      assert.equal(error.position, 7);
      return true;
    });
  });

  it('rejects with a readable error when the response is not JSON', async () => {
    respondWith(502, '<html>Bad Gateway</html>');

    await assert.rejects(startRun('SELECT 1'), {
      name: 'ApiError',
      status: 502,
      message: 'Request failed with status 502'
    });
  });

  it('rejects with status 0 when the server cannot be reached', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    await assert.rejects(startRun('SELECT 1'), {
      name: 'ApiError',
      status: 0,
      message: 'Could not reach the server. Is it running?'
    });
  });
});

describe('getRun', () => {
  it('returns the run and its ETag', async () => {
    const sent = respondWith(200, run, { ETag: 'W/"abc"' });

    assert.deepEqual(await getRun('run-1'), { run, etag: 'W/"abc"' });
    assert.equal(sent[0].url, '/api/runs/run-1');
  });

  // While a statement runs, most polls find nothing new: the server answers 304 without the (possibly large) body
  it('sends the last ETag, and returns nothing when the run is unchanged', async () => {
    const sent = respondWith(304);

    assert.equal(await getRun('run-1', { etag: 'W/"abc"' }), undefined);
    assert.equal(new Headers(sent[0].init?.headers).get('If-None-Match'), 'W/"abc"');
  });

  it('rejects with 404 for a run that expired or belongs to someone else', async () => {
    respondWith(404, { error: 'Run not found. It may have expired, or been started with other credentials' });

    await assert.rejects(getRun('gone'), { name: 'ApiError', status: 404 });
  });

  // Polls stop when the run on screen changes or the page unmounts; that isn't "could not reach the server"
  it('passes the abort signal to fetch and rethrows the abort as-is', async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async (_url, init) => {
      init?.signal?.throwIfAborted();
      throw new Error('getRun did not pass the abort signal to fetch');
    };

    await assert.rejects(getRun('run-1', { signal: controller.signal }), { name: 'AbortError' });
  });

  it('encodes the id into the path', async () => {
    const sent = respondWith(200, run);

    await getRun('a/b');

    assert.equal(sent[0].url, '/api/runs/a%2Fb');
  });
});

describe('cancelRun', () => {
  it('posts to the run’s cancel endpoint and returns the run', async () => {
    const sent = respondWith(202, run);

    assert.deepEqual(await cancelRun('run-1'), run);
    assert.equal(sent[0].url, '/api/runs/run-1/cancel');
    assert.equal(sent[0].init?.method, 'POST');
  });
});

describe('listTables', () => {
  it('returns the tables the server lists', async () => {
    const tables = [{ database: 'default', name: 'events' }];
    const sent = respondWith(200, tables);

    assert.deepEqual(await listTables(), tables);
    assert.equal(sent[0].url, '/api/tables');
  });

  it('rejects with the server error', async () => {
    respondWith(502, { error: 'ClickHouse is unreachable' });

    await assert.rejects(listTables(), { name: 'ApiError', status: 502, message: 'ClickHouse is unreachable' });
  });
});

describe('insertFile', () => {
  // The File itself is the body: the browser streams it from disk instead of it being read into memory here
  it('posts the file itself as the body, with where it goes in the URL', async () => {
    const sent = respondWith(200, { rows: 2, elapsedMs: 5 });
    const file = new Blob(['id,name\n1,a\n2,b\n']);

    const result = await insertFile(file, { database: 'my db', table: 'events', format: 'CSVWithNames' });

    assert.deepEqual(result, { rows: 2, elapsedMs: 5 });
    assert.equal(sent[0].url, '/api/insert?database=my+db&table=events&format=CSVWithNames');
    assert.equal(sent[0].init?.method, 'POST');
    assert.equal(sent[0].init?.body, file);
    assert.equal(new Headers(sent[0].init?.headers).get('Content-Type'), 'application/octet-stream');
  });

  it("rejects with ClickHouse's error, e.g. a bad row", async () => {
    respondWith(400, {
      error: 'Cannot parse input (at row 3)',
      code: '27',
      type: 'CANNOT_PARSE_INPUT_ASSERTION_FAILED'
    });

    await assert.rejects(insertFile(new Blob(['x']), { database: 'd', table: 't', format: 'CSVWithNames' }), {
      name: 'ApiError',
      status: 400,
      type: 'CANNOT_PARSE_INPUT_ASSERTION_FAILED'
    });
  });
});
