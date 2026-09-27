import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STATEMENTS, Run } from '../shared/api';
import { RunStore } from './runStore';
import { createServer } from './server';
import { closeTestServers, fakeRunClickHouse, recordingLogger, startTestServer, TestApi } from './testHelpers';

const alice = { 'X-ClickHouse-User': 'alice', 'X-ClickHouse-Key': 's3cret' };
const bob = { 'X-ClickHouse-User': 'bob', 'X-ClickHouse-Key': 'hunter2' };

after(closeTestServers);

async function setup(options: Parameters<typeof fakeRunClickHouse>[1] = {}, runStore = new RunStore()) {
  const ch = fakeRunClickHouse({}, options);
  const log = recordingLogger();
  const api = await startTestServer(createServer(ch.client, log.logger, { runStore }));
  return { ch, api, log };
}

function start(api: TestApi, body: object, headers = alice) {
  return api.post('/api/runs').set(headers).send(body);
}

/** Polls the run until it's no longer running */
async function finished(api: TestApi, id: string, headers = alice): Promise<Run> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const res = await api.get(`/api/runs/${id}`).set(headers);
    assert.equal(res.status, 200);
    if (res.body.status !== 'running') {
      return res.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${id} didn't finish`);
}

describe('POST /api/runs', () => {
  it('starts the run and answers 202 with its id and pending statements', async () => {
    const { api } = await setup({ holdSql: 'SELECT 2' });

    const res = await start(api, { sql: 'SELECT 1; SELECT 2' });

    assert.equal(res.status, 202);
    assert.match(res.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.headers.location, `/api/runs/${res.body.id}`);
    assert.equal(res.body.status, 'running');
    assert.deepEqual(
      res.body.statements.map((s: { sql: string }) => s.sql),
      ['SELECT 1', 'SELECT 2']
    );
  });

  it('runs the script in the background, with the caller’s credentials and ClickHouse headers', async () => {
    const { api, ch } = await setup();
    const headers = { ...alice, 'X-ClickHouse-Database': 'analytics', 'X-Unrelated': 'ignored' };

    const res = await start(api, { sql: 'SELECT 1; USE db' }, headers);
    const run = await finished(api, res.body.id, headers);

    assert.equal(run.status, 'finished');
    assert.deepEqual(
      run.statements.map((s) => s.status),
      ['ok', 'ok']
    );
    assert.deepEqual(run.statements[0].rows, [[1]]);
    assert.deepEqual(ch.calls[0].params.auth, { username: 'alice', password: 's3cret' });
    // Other X-ClickHouse-* headers are forwarded; anything else isn't
    assert.deepEqual(ch.calls[0].params.http_headers, { 'x-clickhouse-database': 'analytics' });
  });

  describe('rejects a script without running anything', () => {
    const cases: [string, object, RegExp][] = [
      ['no sql', {}, /'sql' is required/],
      ['sql that is not a string', { sql: 42 }, /'sql' must be a string/],
      ['blank sql', { sql: '   ' }, /'sql' is required/],
      ['only comments', { sql: '-- nothing\n/* here */' }, /Nothing to run/],
      [
        `more than ${MAX_STATEMENTS} statements`,
        { sql: 'SELECT 1;'.repeat(MAX_STATEMENTS + 1) },
        new RegExp(`${MAX_STATEMENTS + 1} statements.*limit is ${MAX_STATEMENTS}`)
      ]
    ];
    for (const [label, body, message] of cases) {
      it(`with ${label}`, async () => {
        const { api, ch, log } = await setup();

        const res = await start(api, body);

        assert.equal(res.status, 400);
        assert.match(res.body.error, message);
        assert.equal(ch.calls.length, 0);
        assert.equal(log.entries[0].fields?.fault, 'client');
      });
    }

    it('with an unterminated string, pointing at where it starts', async () => {
      const { api } = await setup();

      const res = await start(api, { sql: "SELECT 1;\nSELECT 'oops" });

      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'Unterminated string', position: 17 });
    });
  });

  describe('destructive statements', () => {
    it('answers 409 with the destructive statements, and runs nothing', async () => {
      const { api, ch } = await setup();

      const res = await start(api, { sql: 'SELECT 1;\nDROP TABLE t' });

      assert.equal(res.status, 409);
      assert.deepEqual(res.body.destructive, [{ index: 1, sql: 'DROP TABLE t', start: 10, end: 22 }]);
      assert.equal(ch.calls.length, 0);
    });

    it('runs them once confirmed', async () => {
      const { api } = await setup();

      const res = await start(api, { sql: 'DROP TABLE t', confirmDestructive: true });

      assert.equal(res.status, 202);
      assert.equal((await finished(api, res.body.id)).status, 'finished');
    });

    it('only accepts true as confirmation', async () => {
      const { api } = await setup();

      const res = await start(api, { sql: 'DROP TABLE t', confirmDestructive: 'yes' });

      assert.equal(res.status, 409);
    });
  });

  it('answers 429 when every slot holds a running run', async () => {
    const { api } = await setup({ holdSql: 'SELECT slow' }, new RunStore({ maxRuns: 1 }));
    await start(api, { sql: 'SELECT slow' }, bob);

    const res = await start(api, { sql: 'SELECT 1' });

    assert.equal(res.status, 429);
    assert.match(res.body.error, /server has too many runs in progress/);
  });

  it('answers 429 to a user with too many runs in progress, and still starts runs for others', async () => {
    const { api } = await setup({ holdSql: 'SELECT slow' }, new RunStore({ maxRunningPerOwner: 1 }));
    await start(api, { sql: 'SELECT slow' });

    const own = await start(api, { sql: 'SELECT 1' });
    const other = await start(api, { sql: 'SELECT 1' }, bob);

    assert.equal(own.status, 429);
    assert.match(own.body.error, /You already have 1 run in progress/);
    assert.equal(other.status, 202);
  });

  it('accepts a script over the old 100 KB body limit, and rejects one over 1 MB with a JSON 413', async () => {
    const { api } = await setup();
    // One statement, so the statement limit doesn't apply
    const literal = (bytes: number) => `SELECT '${'x'.repeat(bytes)}'`;

    assert.equal((await start(api, { sql: literal(600_000) })).status, 202);
    const tooLarge = await start(api, { sql: literal(1_100_000) });
    assert.equal(tooLarge.status, 413);
    // body-parser's own message, without its stack trace or Express's HTML error page
    assert.deepEqual(tooLarge.body, { error: 'request entity too large' });
  });

  it('responds to malformed JSON with a JSON 400, not an HTML page', async () => {
    const { api, log } = await setup();

    const res = await api.post('/api/runs').set('Content-Type', 'application/json').send('{"sql": ');

    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(typeof res.body.error, 'string');
    assert.equal(log.entries[0].fields?.fault, 'client');
  });
});

describe('GET /api/runs/:id', () => {
  it('answers 404 for an unknown run', async () => {
    const { api } = await setup();

    const res = await api.get('/api/runs/no-such-run').set(alice);

    assert.equal(res.status, 404);
  });

  // Results were fetched with the grants of whoever started the run, so a leaked run id isn't enough
  it("hides a run from anyone who didn't start it, including the same user with another password", async () => {
    const { api } = await setup();
    const { id } = (await start(api, { sql: 'SELECT 1' })).body;

    for (const headers of [
      {},
      { 'X-ClickHouse-User': 'bob' },
      { 'X-ClickHouse-User': 'alice', 'X-ClickHouse-Key': 'guess' }
    ]) {
      const res = await api.get(`/api/runs/${id}`).set(headers);
      assert.equal(res.status, 404, JSON.stringify(headers));
    }
  });

  // Polling a run that hasn't changed costs almost nothing
  it('answers 304 when the run is unchanged since the last poll', async () => {
    const { api } = await setup();
    const { id } = (await start(api, { sql: 'SELECT 1' })).body;
    await finished(api, id);

    const first = await api.get(`/api/runs/${id}`).set(alice);
    const second = await api.get(`/api/runs/${id}`).set(alice).set('If-None-Match', first.headers.etag);

    assert.ok(first.headers.etag);
    assert.equal(second.status, 304);
  });

  // The ETag is the run's version, so answering "unchanged" costs the same for any size of result
  it('answers an unchanged run without serializing it', async () => {
    const { api } = await setup();
    const { id } = (await start(api, { sql: 'SELECT 1' })).body;
    await finished(api, id);
    const { etag } = (await api.get(`/api/runs/${id}`).set(alice)).headers;

    const stringify = mock.method(JSON, 'stringify');
    const poll = await api.get(`/api/runs/${id}`).set(alice).set('If-None-Match', etag);
    const serialized = stringify.mock.callCount();
    stringify.mock.restore();

    assert.equal(poll.status, 304);
    assert.equal(serialized, 0);
  });

  it('gives a run a new ETag when it changes, so the next poll gets it', async () => {
    const { api, ch } = await setup({ holdSql: 'SELECT 1' });
    const { id } = (await start(api, { sql: 'SELECT 1' })).body;
    const running = await api.get(`/api/runs/${id}`).set(alice);

    ch.release();
    await finished(api, id);
    const poll = await api.get(`/api/runs/${id}`).set(alice).set('If-None-Match', running.headers.etag);

    assert.equal(poll.status, 200);
    assert.equal(poll.body.status, 'finished');
  });
});

describe('POST /api/runs/:id/cancel', () => {
  it('kills the running statement and skips the rest', async () => {
    const { api, ch } = await setup({ holdSql: 'SELECT slow' });
    const { id } = (await start(api, { sql: 'SELECT slow; SELECT 2' })).body;

    const res = await api.post(`/api/runs/${id}/cancel`).set(alice);
    const run = await finished(api, id);

    assert.equal(res.status, 202);
    assert.equal(run.status, 'cancelled');
    assert.deepEqual(
      run.statements.map((s) => s.status),
      ['cancelled', 'skipped']
    );
    assert.ok(ch.calls.some((c) => c.params.query.startsWith('KILL QUERY')));
  });

  it("can't be done by someone who didn't start the run", async () => {
    const { api, ch } = await setup({ holdSql: 'SELECT slow' });
    const { id } = (await start(api, { sql: 'SELECT slow' })).body;

    const res = await api.post(`/api/runs/${id}/cancel`).set({ 'X-ClickHouse-User': 'bob' });

    assert.equal(res.status, 404);
    assert.ok(!ch.calls.some((c) => c.params.query.startsWith('KILL QUERY')));
    ch.release();
    assert.equal((await finished(api, id)).status, 'finished');
  });
});
