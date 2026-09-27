import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { Run } from '../../shared/api';
import { Logger } from '../logger';
import { createServer } from '../server';
import { closeTestServers, startTestServer, TestApi } from '../testHelpers';

// Requires ClickHouse from docker-compose.yml (`docker compose up -d`).
const CLICKHOUSE_URL = 'http://localhost:8123';
// ~10 s: 20 one-row blocks, each sleeping 0.5 s
const SLOW_QUERY = 'SELECT sum(sleepEachRow(0.5)) FROM numbers(20) SETTINGS max_block_size = 1';
// Throwaway users, created before and dropped after these tests
const TEST_USER = 'sql_editor_test_user';
const TEST_PASSWORD = 'test-password';
const OTHER_USER = 'sql_editor_other_user';
const OTHER_PASSWORD = 'other-password';
// Only created if the privilege check fails; dropped after the tests either way
const DENIED_TABLE = 'default.sql_editor_denied';
// Error tests are expected to log; keep the test output clean
const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('/api/runs against ClickHouse', () => {
  const client = createClient({ url: CLICKHOUSE_URL, log: { level: ClickHouseLogLevel.OFF } });
  let api: TestApi;

  /** Polls the run the way the UI does, until it's no longer running. Runs belong to the credentials that started them */
  async function finished(id: string, app = api, headers: Record<string, string> = {}): Promise<Run> {
    for (let attempt = 0; attempt < 300; attempt++) {
      const res = await app.get(`/api/runs/${id}`).set(headers);
      assert.equal(res.status, 200);
      if (res.body.status !== 'running') {
        return res.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`run ${id} didn't finish`);
  }

  /** Runs a script the way the UI does: start it, then poll until it's done */
  async function run(sql: string, headers: Record<string, string> = {}, app = api): Promise<Run> {
    const started = await app.post('/api/runs').set(headers).send({ sql });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return finished(started.body.id, app, headers);
  }

  before(async () => {
    const { success } = await client.ping();
    assert.ok(success, `ClickHouse is not reachable at ${CLICKHOUSE_URL}. Start it with: docker compose up -d`);
    api = await startTestServer(createServer(client, silentLogger));
    for (const [user, password] of [
      [TEST_USER, TEST_PASSWORD],
      [OTHER_USER, OTHER_PASSWORD]
    ]) {
      await client.command({ query: `DROP USER IF EXISTS ${user}` });
      await client.command({ query: `CREATE USER ${user} IDENTIFIED BY '${password}'` });
    }
  });

  after(async () => {
    await closeTestServers();
    await client.command({ query: `DROP USER IF EXISTS ${TEST_USER}` });
    await client.command({ query: `DROP USER IF EXISTS ${OTHER_USER}` });
    await client.command({ query: `DROP TABLE IF EXISTS ${DENIED_TABLE}` });
    await client.close();
  });

  describe('the requests.http examples', () => {
    it('runs SELECT 1', async () => {
      const [statement] = (await run('SELECT 1')).statements;

      assert.deepEqual(statement.columns, [{ name: '1', type: 'UInt8' }]);
      assert.deepEqual(statement.rows, [[1]]);
    });

    it('lists system tables', async () => {
      const [statement] = (await run('SELECT * from system.tables;')).statements;

      assert.ok((statement.rows ?? []).length > 0);
      assert.ok(statement.columns?.some((column) => column.name === 'name'));
    });
  });

  describe("reports ClickHouse's errors on the statement, as the caller's fault", () => {
    it('a syntax error', async () => {
      const result = await run('SELEC 1');

      assert.equal(result.status, 'failed');
      assert.match(result.statements[0].error?.error ?? '', /Syntax error/);
      assert.equal(result.statements[0].error?.code, '62');
      assert.equal(result.statements[0].error?.type, 'SYNTAX_ERROR');
      assert.equal(result.statements[0].error?.fault, 'client');
    });

    // ClickHouse's own HTTP status for this is 500; it's still the query's mistake, not an outage
    it('a type error', async () => {
      const [statement] = (await run("SELECT 1 + 'a'")).statements;

      assert.equal(statement.error?.type, 'ILLEGAL_TYPE_OF_ARGUMENT');
      assert.equal(statement.error?.fault, 'client');
    });
  });

  describe("runs as the caller's ClickHouse user", () => {
    const currentUser = async (headers: Record<string, string>) =>
      (await run('SELECT currentUser() AS user', headers)).statements[0];

    it('runs as default without auth headers', async () => {
      assert.deepEqual((await currentUser({})).rows, [['default']]);
    });

    it('runs as the user given by X-ClickHouse-User and X-ClickHouse-Key', async () => {
      assert.deepEqual(
        (await currentUser({ 'X-ClickHouse-User': TEST_USER, 'X-ClickHouse-Key': TEST_PASSWORD })).rows,
        [[TEST_USER]]
      );
    });

    // The local default user has no password (docker/users.xml): a user without a key logs in with an empty password
    it('runs as a passwordless user given only X-ClickHouse-User', async () => {
      assert.deepEqual((await currentUser({ 'X-ClickHouse-User': 'default' })).rows, [['default']]);
    });

    it('fails the statement for a wrong key', async () => {
      const statement = await currentUser({ 'X-ClickHouse-User': TEST_USER, 'X-ClickHouse-Key': 'wrong' });

      assert.equal(statement.error?.type, 'AUTHENTICATION_FAILED');
      assert.equal(statement.error?.fault, 'client');
    });

    it('fails the statement for a password-protected user without a key', async () => {
      assert.equal((await currentUser({ 'X-ClickHouse-User': TEST_USER })).error?.type, 'AUTHENTICATION_FAILED');
    });

    // Proves statements run with the caller's privileges, not the server's: the test user has no grants, so
    // ClickHouse refuses the CREATE. If runs fell back to `default` (which may create tables), it would succeed
    it('fails a statement the user has no privileges for', async () => {
      const result = await run(`CREATE TABLE ${DENIED_TABLE} (a UInt8) ENGINE = Memory`, {
        'X-ClickHouse-User': TEST_USER,
        'X-ClickHouse-Key': TEST_PASSWORD
      });

      assert.equal(result.statements[0].error?.type, 'ACCESS_DENIED');
    });

    it('forwards other X-ClickHouse-* headers', async () => {
      const result = await run('SELECT currentDatabase() AS db', { 'X-ClickHouse-Database': 'system' });

      assert.deepEqual(result.statements[0].rows, [['system']]);
    });

    // One ClickHouse client serves every request; each query carries its own login
    it("doesn't carry one run's login into the next", async () => {
      const testUser = { 'X-ClickHouse-User': TEST_USER, 'X-ClickHouse-Key': TEST_PASSWORD };
      await currentUser(testUser);
      assert.deepEqual((await currentUser({})).rows, [['default']]);

      await currentUser(testUser);
      const other = await currentUser({ 'X-ClickHouse-User': OTHER_USER, 'X-ClickHouse-Key': OTHER_PASSWORD });
      assert.deepEqual(other.rows, [[OTHER_USER]]);
    });

    it('keeps logins separate for concurrent runs', async () => {
      const testUser = { 'X-ClickHouse-User': TEST_USER, 'X-ClickHouse-Key': TEST_PASSWORD };
      // 5 each: the most runs one login may have in progress
      const statements = await Promise.all(
        Array.from({ length: 10 }, (_, i) => currentUser(i % 2 === 0 ? testUser : {}))
      );

      statements.forEach((statement, i) => {
        assert.deepEqual(statement.rows, [[i % 2 === 0 ? TEST_USER : 'default']]);
      });
    });
  });

  // Also guards the client's timeout message, which errors.ts matches on. (Unreachable: see runner.test.ts)
  it('fails the statement as an outage when ClickHouse takes longer than the request timeout', async () => {
    const impatient = createClient({
      url: CLICKHOUSE_URL,
      request_timeout: 200,
      log: { level: ClickHouseLogLevel.OFF }
    });
    try {
      const result = await run('SELECT sleep(1)', {}, await startTestServer(createServer(impatient, silentLogger)));

      assert.deepEqual(result.statements[0].error, { error: 'ClickHouse did not respond in time', fault: 'upstream' });
    } finally {
      await impatient.close();
    }
  });

  it('runs a script end to end: started, polled, finished with results', async () => {
    const started = await api.post('/api/runs').send({
      sql: 'USE system;\nCREATE TEMPORARY TABLE runs_tmp (a UInt8);\nINSERT INTO runs_tmp VALUES (7);\nSELECT currentDatabase() AS db, a FROM runs_tmp'
    });
    assert.equal(started.status, 202);

    const run = await finished(started.body.id);

    assert.equal(run.status, 'finished');
    assert.deepEqual(
      run.statements.map((s) => s.status),
      ['ok', 'ok', 'ok', 'ok']
    );
    assert.deepEqual(run.statements[3].columns, [
      { name: 'db', type: 'String' },
      { name: 'a', type: 'UInt8' }
    ]);
    assert.deepEqual(run.statements[3].rows, [['system', 7]]);
  });

  it('cancels a slow statement through the endpoint', async () => {
    const started = await api.post('/api/runs').send({ sql: `${SLOW_QUERY}; SELECT 2` });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const cancelledAt = Date.now();
    await api.post(`/api/runs/${started.body.id}/cancel`);
    const run = await finished(started.body.id);

    assert.equal(run.status, 'cancelled');
    assert.deepEqual(
      run.statements.map((s) => s.status),
      ['cancelled', 'skipped']
    );
    assert.ok(Date.now() - cancelledAt < 3000, 'the statement should stop soon after cancelling');
  });

  // A statement holds its connection until it ends. If KILLs shared the statements' pool, a cancel would wait for a
  // free connection until a running statement finished, i.e. arrive too late
  it('cancels promptly even when every connection is busy with running statements', async () => {
    const busy = createClient({ url: CLICKHOUSE_URL, max_open_connections: 2, log: { level: ClickHouseLogLevel.OFF } });
    const control = createClient({ url: CLICKHOUSE_URL, log: { level: ClickHouseLogLevel.OFF } });
    const app = await startTestServer(createServer(busy, silentLogger, { controlClient: control }));
    try {
      const first = await app.post('/api/runs').send({ sql: SLOW_QUERY });
      const second = await app.post('/api/runs').send({ sql: SLOW_QUERY });
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const cancelledAt = Date.now();
      await app.post(`/api/runs/${first.body.id}/cancel`);
      const run = await finished(first.body.id, app);

      assert.equal(run.status, 'cancelled');
      assert.ok(Date.now() - cancelledAt < 3000, 'the statement should stop soon after cancelling');

      await app.post(`/api/runs/${second.body.id}/cancel`);
      await finished(second.body.id, app);
    } finally {
      await busy.close();
      await control.close();
    }
  });

  it('asks for confirmation before a destructive statement, then runs it', async () => {
    const sql = 'DROP TABLE IF EXISTS default.runs_never_existed';

    const unconfirmed = await api.post('/api/runs').send({ sql });
    const confirmed = await api.post('/api/runs').send({ sql, confirmDestructive: true });

    assert.equal(unconfirmed.status, 409);
    assert.equal(confirmed.status, 202);
    assert.equal((await finished(confirmed.body.id)).status, 'finished');
  });
});
