import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { ROW_CAP } from '../../shared/api';
import { splitStatements } from '../../shared/splitStatements';
import { ClickHouseRequestOptions } from '../clickhouseRequestOptions';
import { Logger } from '../logger';
import { executeRun, prepareRun } from '../runner';

// Requires ClickHouse from docker-compose.yml (`docker compose up -d`).
const CLICKHOUSE_URL = 'http://localhost:8123';
// Throwaway users, created before and dropped after these tests. Killing your own query only needs to see it
// in system.processes; the first user can't, the second can
const NO_GRANTS_USER = 'sql_editor_runner_test_user';
const NO_GRANTS_PASSWORD = 'test-password';
const SEES_OWN_QUERIES_USER = 'sql_editor_runner_cancel_user';
const SEES_OWN_QUERIES_PASSWORD = 'test-password';
// ~10 s: 20 one-row blocks, each sleeping 0.5 s
const SLOW_QUERY = 'SELECT sum(sleepEachRow(0.5)) FROM numbers(20) SETTINGS max_block_size = 1';
// Created by the time limit test, dropped after these tests
const TIMEOUT_TABLE = 'default.sql_editor_runner_timeout';
const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('executeRun against ClickHouse', () => {
  const client = createClient({ url: CLICKHOUSE_URL, log: { level: ClickHouseLogLevel.OFF } });
  let runCount = 0;

  /** Splits and runs a script the way the server will, returning the finished run */
  async function run(
    script: string,
    options: { requestOptions?: ClickHouseRequestOptions; cancelAfterMs?: number; maxExecutionSeconds?: number } = {}
  ) {
    const split = splitStatements(script);
    assert.ok(split.ok);
    const runId = `test-run-${Date.now()}-${runCount++}`;
    const prepared = prepareRun(runId, split.statements);
    const controller = new AbortController();
    if (options.cancelAfterMs !== undefined) {
      setTimeout(() => controller.abort(), options.cancelAfterMs);
    }
    await executeRun(client, prepared, {
      runId,
      requestOptions: options.requestOptions ?? { http_headers: {} },
      signal: controller.signal,
      logger: silentLogger,
      maxExecutionSeconds: options.maxExecutionSeconds
    });
    return prepared.run;
  }

  async function count(from: string) {
    const result = await client.query({ query: `SELECT count() FROM ${from}`, format: 'JSONCompact' });
    return Number(((await result.json()) as { data: unknown[][] }).data[0][0]);
  }

  before(async () => {
    const { success } = await client.ping();
    assert.ok(success, `ClickHouse is not reachable at ${CLICKHOUSE_URL}. Start it with: docker compose up -d`);
    await client.command({ query: `DROP USER IF EXISTS ${NO_GRANTS_USER}` });
    await client.command({ query: `CREATE USER ${NO_GRANTS_USER} IDENTIFIED BY '${NO_GRANTS_PASSWORD}'` });
    await client.command({ query: `DROP USER IF EXISTS ${SEES_OWN_QUERIES_USER}` });
    await client.command({
      query: `CREATE USER ${SEES_OWN_QUERIES_USER} IDENTIFIED BY '${SEES_OWN_QUERIES_PASSWORD}'`
    });
    await client.command({
      query: `GRANT SELECT(query_id, user, query) ON system.processes TO ${SEES_OWN_QUERIES_USER}`
    });
  });

  after(async () => {
    await client.command({ query: `DROP USER IF EXISTS ${NO_GRANTS_USER}` });
    await client.command({ query: `DROP USER IF EXISTS ${SEES_OWN_QUERIES_USER}` });
    await client.command({ query: `DROP TABLE IF EXISTS ${TIMEOUT_TABLE}` });
    await client.close();
  });

  // Each HTTP request is its own session unless session_id is set
  it('runs a script in one session, so USE and temporary tables carry over', async () => {
    const result = await run(
      'USE system; SELECT currentDatabase(); CREATE TEMPORARY TABLE runner_tmp (a UInt8); INSERT INTO runner_tmp VALUES (7); SELECT a FROM runner_tmp'
    );

    assert.equal(result.status, 'finished');
    assert.deepEqual(result.statements[1].rows, [['system']]);
    assert.deepEqual(result.statements[4].rows, [[7]]);
  });

  // Through client.query, DDL and writes run and then report "Unexpected end of JSON input"
  it('reports DDL and writes as successful, without a false error', async () => {
    const result = await run('CREATE TEMPORARY TABLE runner_ddl (a UInt8); INSERT INTO runner_ddl SELECT 1');

    assert.deepEqual(
      result.statements.map((s) => s.status),
      ['ok', 'ok']
    );
  });

  it('returns column names and ClickHouse types, even for an empty result', async () => {
    const result = await run("SELECT toUInt64(1) AS n, 'a' AS s WHERE 0");

    assert.deepEqual(result.statements[0].columns, [
      { name: 'n', type: 'UInt64' },
      { name: 's', type: 'String' }
    ]);
    assert.deepEqual(result.statements[0].rows, []);
  });

  it('stops at the first error, with ClickHouse’s code and type, and skips the rest', async () => {
    const result = await run('SELECT 1; SELECT * FROM runner_missing_table; SELECT 3');

    assert.deepEqual(
      result.statements.map((s) => s.status),
      ['ok', 'error', 'skipped']
    );
    assert.equal(result.statements[1].error?.type, 'UNKNOWN_TABLE');
    assert.equal(result.status, 'failed');
  });

  // Without wait_end_of_query, the client returns the rows before the error as a success.
  // The error must come before the row cap, or the query legitimately stops before reaching it.
  it('reports an error partway through a result as an error, not partial rows', async () => {
    const result = await run(
      'SELECT number, throwIf(number = 5000) FROM numbers(1000000) SETTINGS max_block_size = 1000'
    );

    assert.equal(result.statements[0].status, 'error');
    assert.equal(result.statements[0].error?.type, 'FUNCTION_THROW_IF_VALUE_IS_NON_ZERO');
    assert.equal(result.statements[0].rows, undefined);
  });

  it(`caps results at ${ROW_CAP.toLocaleString()} rows and says when there were more`, async () => {
    const result = await run(`SELECT number FROM numbers(${ROW_CAP + 1}); SELECT number FROM numbers(${ROW_CAP})`);

    assert.equal(result.statements[0].rows?.length, ROW_CAP);
    assert.equal(result.statements[0].truncated, true);
    assert.equal(result.statements[1].rows?.length, ROW_CAP);
    assert.equal(result.statements[1].truncated, false);
  });

  // With max_result_rows = ROW_CAP, blocks ending exactly at the cap returned exactly ROW_CAP rows
  // and a truncated result looked complete
  it('still says there were more rows when blocks end exactly at the cap', async () => {
    const result = await run('SELECT number FROM numbers(1000000) SETTINGS max_block_size = 1000');

    assert.equal(result.statements[0].rows?.length, ROW_CAP);
    assert.equal(result.statements[0].truncated, true);
  });

  // With only the client's request timeout, the client gave up and reported a failure while the statement kept
  // running, and a write finished after the error (verified). ClickHouse enforcing the limit ends the statement itself
  describe('time limit', () => {
    it('stops a write in ClickHouse, reporting its error, with nothing left running or written', async () => {
      await client.command({ query: `CREATE OR REPLACE TABLE ${TIMEOUT_TABLE} (n UInt64) ENGINE = Memory` });

      const result = await run(
        `INSERT INTO ${TIMEOUT_TABLE} SELECT number + sleepEachRow(0.5) FROM numbers(20) SETTINGS max_block_size = 1; SELECT 2`,
        { maxExecutionSeconds: 1 }
      );

      assert.deepEqual(
        result.statements.map((s) => s.status),
        ['error', 'skipped']
      );
      assert.equal(result.statements[0].error?.type, 'TIMEOUT_EXCEEDED');
      assert.equal(await count(`system.processes WHERE query_id = '${result.id}-0'`), 0);
      assert.equal(await count(TIMEOUT_TABLE), 0);
    });

    it('stops a statement that returns rows the same way', async () => {
      const result = await run(SLOW_QUERY, { maxExecutionSeconds: 1 });

      assert.equal(result.statements[0].error?.type, 'TIMEOUT_EXCEEDED');
      assert.equal(await count(`system.processes WHERE query_id = '${result.id}-0'`), 0);
    });
  });

  it("says a statement failed because ClickHouse couldn't be reached, not because of the SQL", async () => {
    // Nothing listens on port 1
    const unreachable = createClient({ url: 'http://localhost:1', log: { level: ClickHouseLogLevel.OFF } });
    const split = splitStatements('SELECT 1');
    assert.ok(split.ok);
    const prepared = prepareRun('test-run-unreachable', split.statements);

    await executeRun(unreachable, prepared, {
      runId: 'test-run-unreachable',
      requestOptions: { http_headers: {} },
      signal: new AbortController().signal,
      logger: silentLogger
    });
    await unreachable.close();

    assert.equal(prepared.run.status, 'failed');
    assert.deepEqual(prepared.run.statements[0].error, { error: 'ClickHouse is unreachable', fault: 'upstream' });
  });

  it("tags each query with the run in ClickHouse's query log", async () => {
    const result = await run('SELECT 1; SELECT 2');
    await client.command({ query: 'SYSTEM FLUSH LOGS' });

    const logged = await client.query({
      query: `SELECT JSONExtractUInt(log_comment, 'index') AS i FROM system.query_log
              WHERE JSONExtractString(log_comment, 'runId') = {runId:String} AND type = 'QueryFinish' ORDER BY i`,
      query_params: { runId: result.id },
      format: 'JSONCompact'
    });
    assert.deepEqual(((await logged.json()) as { data: unknown[][] }).data, [['0'], ['1']]);
  });

  describe('cancelling', () => {
    it('stops the running query in ClickHouse and skips the rest', async () => {
      const started = Date.now();
      const result = await run(`${SLOW_QUERY}; SELECT 2`, { cancelAfterMs: 1000 });

      assert.deepEqual(
        result.statements.map((s) => s.status),
        ['cancelled', 'skipped']
      );
      assert.equal(result.status, 'cancelled');
      assert.ok(Date.now() - started < 5000, 'the ~10 s query should have been stopped early');
    });

    // The KILL QUERY privilege is only needed for other users' queries
    it('lets a user who can see their own running queries cancel them', async () => {
      const started = Date.now();
      const result = await run(`${SLOW_QUERY}; SELECT 2`, {
        requestOptions: {
          auth: { username: SEES_OWN_QUERIES_USER, password: SEES_OWN_QUERIES_PASSWORD },
          http_headers: {}
        },
        cancelAfterMs: 1000
      });

      assert.deepEqual(
        result.statements.map((s) => s.status),
        ['cancelled', 'skipped']
      );
      assert.equal(result.notice, undefined);
      assert.ok(Date.now() - started < 5000, 'the ~10 s query should have been stopped early');
    });

    it("says so when the user can't kill queries", async () => {
      const result = await run(`${SLOW_QUERY}; SELECT 2`, {
        requestOptions: { auth: { username: NO_GRANTS_USER, password: NO_GRANTS_PASSWORD }, http_headers: {} },
        cancelAfterMs: 1000
      });

      assert.equal(result.status, 'cancelled');
      assert.equal(result.statements[1].status, 'skipped');
      assert.match(result.notice ?? '', /SELECT on system\.processes/);
    });
  });
});
