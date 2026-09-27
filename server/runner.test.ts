import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouseError } from '@clickhouse/client';
import { ROW_CAP } from '../shared/api';
import { splitStatements, Statement } from '../shared/splitStatements';
import { executeRun, PreparedRun, prepareRun } from './runner';
import { MAX_EXECUTION_SECONDS } from './statement';
import { fakeRunClickHouse, recordingLogger } from './testHelpers';

function split(script: string): Statement[] {
  const result = splitStatements(script);
  assert.ok(result.ok);
  return result.statements;
}

function setup(script: string) {
  const statements = split(script);
  const prepared = prepareRun('run-1', statements);
  const run = prepared.run;
  const controller = new AbortController();
  const log = recordingLogger();
  const options = {
    runId: 'run-1',
    requestOptions: {
      auth: { username: 'alice', password: 's3cret' },
      http_headers: { 'x-clickhouse-database': 'db' }
    },
    signal: controller.signal,
    logger: log.logger
  };
  return { prepared, run, controller, log, options };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('prepareRun', () => {
  it('starts every statement as pending, with its position and kind', () => {
    const { run } = prepareRun('run-1', split('SELECT 1;\nDROP TABLE t'));

    assert.equal(run.status, 'running');
    assert.deepEqual(
      run.statements.map(({ index, sql, start, end, kind, status }) => ({ index, sql, start, end, kind, status })),
      [
        { index: 0, sql: 'SELECT 1', start: 0, end: 8, kind: 'read', status: 'pending' },
        { index: 1, sql: 'DROP TABLE t', start: 10, end: 22, kind: 'destructive', status: 'pending' }
      ]
    );
  });

  it('keeps the statements to execute alongside the run, in the same order', () => {
    const statements = split('SELECT 1; DROP TABLE t');
    const prepared = prepareRun('run-1', statements);

    assert.equal(prepared.statements, statements);
    assert.deepEqual(
      prepared.run.statements.map((s) => s.sql),
      statements.map((s) => s.sql)
    );
  });
});

describe('executeRun', () => {
  it('sends statements that return rows through query, as JSONCompact, with the run settings', async () => {
    const { prepared, run, options } = setup('SELECT 1');
    const ch = fakeRunClickHouse();

    await executeRun(ch.client, prepared, options);

    assert.equal(ch.calls.length, 1);
    const { method, params } = ch.calls[0];
    assert.equal(method, 'query');
    assert.deepEqual(params, {
      query: 'SELECT 1',
      format: 'JSONCompact',
      query_id: 'run-1-0',
      session_id: 'run-1',
      clickhouse_settings: {
        log_comment: JSON.stringify({ app: 'sql-editor', runId: 'run-1', index: 0 }),
        // ClickHouse stops the statement itself at the time limit, so it can't outlive a reported failure
        max_execution_time: MAX_EXECUTION_SECONDS,
        // An error partway through a result would otherwise arrive as a 200 with partial rows
        wait_end_of_query: 1,
        max_result_rows: String(ROW_CAP + 1),
        result_overflow_mode: 'break'
      },
      auth: { username: 'alice', password: 's3cret' },
      http_headers: { 'x-clickhouse-database': 'db' }
    });
  });

  it('sends statements that return no rows through command, in the same session', async () => {
    const { prepared, run, options } = setup('CREATE TABLE t (a UInt8) ENGINE = Memory; USE db');
    const ch = fakeRunClickHouse();

    await executeRun(ch.client, prepared, options);

    assert.deepEqual(
      ch.calls.map((c) => [c.method, c.params.query, c.params.query_id, c.params.session_id]),
      [
        ['command', 'CREATE TABLE t (a UInt8) ENGINE = Memory', 'run-1-0', 'run-1'],
        ['command', 'USE db', 'run-1-1', 'run-1']
      ]
    );
    assert.equal(
      ch.calls[0].params.clickhouse_settings?.log_comment,
      JSON.stringify({ app: 'sql-editor', runId: 'run-1', index: 0 })
    );
    assert.deepEqual(ch.calls[0].params.auth, { username: 'alice', password: 's3cret' });
  });

  it('records each statement’s columns, rows, stats and timing', async () => {
    const { prepared, run, options } = setup('SELECT n, s FROM t; USE db');
    const meta = [
      { name: 'n', type: 'UInt64' },
      { name: 's', type: 'String' }
    ];
    const ch = fakeRunClickHouse({
      'SELECT n, s FROM t': {
        meta,
        data: [
          ['1', 'a'],
          ['2', 'b']
        ]
      }
    });

    await executeRun(ch.client, prepared, options);

    const [select, use] = run.statements;
    assert.equal(select.status, 'ok');
    assert.deepEqual(select.columns, meta);
    assert.deepEqual(select.rows, [
      ['1', 'a'],
      ['2', 'b']
    ]);
    assert.equal(select.truncated, false);
    assert.deepEqual(select.stats, { rowsRead: 2, bytesRead: 16 });
    assert.equal(typeof select.elapsedMs, 'number');
    assert.equal(use.status, 'ok');
    assert.equal(use.rows, undefined);
    assert.equal(run.status, 'finished');
    assert.ok(run.finishedAt);
  });

  it(`keeps the first ${ROW_CAP.toLocaleString()} rows and marks the result truncated when there are more`, async () => {
    const { prepared, run, options } = setup('SELECT big; SELECT exact');
    const rows = (n: number) => Array.from({ length: n }, (_, i) => [i]);
    const ch = fakeRunClickHouse({
      'SELECT big': { data: rows(ROW_CAP + 5) },
      'SELECT exact': { data: rows(ROW_CAP) }
    });

    await executeRun(ch.client, prepared, options);

    assert.equal(run.statements[0].rows?.length, ROW_CAP);
    assert.equal(run.statements[0].truncated, true);
    assert.equal(run.statements[1].rows?.length, ROW_CAP);
    assert.equal(run.statements[1].truncated, false);
  });

  it('stops at the first error and skips the rest', async () => {
    const { prepared, run, options, log } = setup('SELECT 1; SELEC 2; SELECT 3');
    const syntaxError = new ClickHouseError({ message: 'Syntax error', code: '62', type: 'SYNTAX_ERROR' });
    const ch = fakeRunClickHouse({ 'SELEC 2': { error: syntaxError } });

    await executeRun(ch.client, prepared, options);

    assert.deepEqual(
      run.statements.map((s) => s.status),
      ['ok', 'error', 'skipped']
    );
    assert.deepEqual(run.statements[1].error, {
      error: 'Syntax error',
      code: '62',
      type: 'SYNTAX_ERROR',
      fault: 'client'
    });
    assert.equal(run.status, 'failed');
    assert.equal(ch.calls.length, 2);
    // Classified as a statement that returns no rows ("SELEC" is unknown), so it went through command
    assert.equal(ch.calls[1].method, 'command');
    assert.equal(log.entries[0].fields?.fault, 'client');
    assert.equal(log.entries[0].fields?.runId, 'run-1');
    assert.equal(log.entries[0].fields?.statement, 2);
  });

  it('reports an unexpected failure as an internal error and logs it as a server fault', async () => {
    const { prepared, run, options, log } = setup('SELECT 1');
    const ch = fakeRunClickHouse({ 'SELECT 1': { error: new TypeError('x is undefined') } });

    await executeRun(ch.client, prepared, options);

    assert.deepEqual(run.statements[0].error, { error: 'Internal server error', fault: 'server' });
    assert.equal(log.entries[0].level, 'error');
    assert.equal(log.entries[0].fields?.fault, 'server');
  });

  // A run answers 200 even when a statement fails, so the fault is what tells the UI "your SQL" from "ClickHouse is down"
  it("says when a statement failed because ClickHouse couldn't be reached", async () => {
    const { prepared, run, options } = setup('SELECT 1');
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8123'), { code: 'ECONNREFUSED' });
    const ch = fakeRunClickHouse({ 'SELECT 1': { error: refused } });

    await executeRun(ch.client, prepared, options);

    assert.deepEqual(run.statements[0].error, { error: 'ClickHouse is unreachable', fault: 'upstream' });
  });

  it('treats an error in the response body as a failure, not a result', async () => {
    const { prepared, run, options } = setup('SELECT 1');
    const exception =
      "Code: 395. DB::Exception: Value passed to 'throwIf' function is non-zero. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO)";
    const ch = fakeRunClickHouse({ 'SELECT 1': { exception } });

    await executeRun(ch.client, prepared, options);

    assert.equal(run.statements[0].status, 'error');
    assert.equal(run.statements[0].error?.code, '395');
    assert.equal(run.statements[0].error?.type, 'FUNCTION_THROW_IF_VALUE_IS_NON_ZERO');
    assert.equal(run.statements[0].rows, undefined);
  });

  // client.query would append its own FORMAT, which clashes with the user's
  it('rejects a statement with its own FORMAT clause without sending it', async () => {
    const { prepared, run, options } = setup('SELECT 1 FORMAT CSV; SELECT 2');
    const ch = fakeRunClickHouse();

    await executeRun(ch.client, prepared, options);

    assert.equal(ch.calls.length, 0);
    assert.equal(run.statements[0].status, 'error');
    assert.match(run.statements[0].error?.error ?? '', /FORMAT/);
    assert.equal(run.statements[1].status, 'skipped');
  });

  it('shows the running statement while it runs', async () => {
    const { prepared, run, options } = setup('SELECT 1; SELECT 2');
    const ch = fakeRunClickHouse({}, { holdSql: 'SELECT 2' });

    const done = executeRun(ch.client, prepared, options);
    await tick();

    assert.deepEqual(
      run.statements.map((s) => s.status),
      ['ok', 'running']
    );
    assert.equal(run.status, 'running');
    ch.release();
    await done;
    assert.equal(run.status, 'finished');
  });

  describe('cancelling', () => {
    it('kills the running statement by its query_id, outside the busy session, and skips the rest', async () => {
      const { prepared, run, options, controller } = setup('SELECT 1; SELECT slow; SELECT 3');
      const ch = fakeRunClickHouse({}, { holdSql: 'SELECT slow' });

      const done = executeRun(ch.client, prepared, options);
      await tick();
      controller.abort();
      await done;

      const kill = ch.calls.find((c) => c.params.query.startsWith('KILL QUERY'));
      assert.ok(kill, 'expected a KILL QUERY');
      assert.equal(kill.method, 'command');
      assert.equal(kill.params.query_params?.queryId, 'run-1-1');
      assert.equal(kill.params.session_id, undefined);
      assert.deepEqual(kill.params.auth, { username: 'alice', password: 's3cret' });
      assert.deepEqual(
        run.statements.map((s) => s.status),
        ['ok', 'cancelled', 'skipped']
      );
      assert.equal(run.status, 'cancelled');
    });

    // A KILL that arrives before ClickHouse has registered the query matches nothing, silently
    it('repeats the KILL until the statement ends', async () => {
      const { prepared, run, options, controller } = setup('SELECT slow; SELECT 2');
      const ch = fakeRunClickHouse({}, { holdSql: 'SELECT slow', killsIgnored: 1 });

      const done = executeRun(ch.client, prepared, options);
      await tick();
      controller.abort();
      await done;

      assert.equal(ch.calls.filter((c) => c.params.query.startsWith('KILL QUERY')).length, 2);
      assert.deepEqual(
        run.statements.map((s) => s.status),
        ['cancelled', 'skipped']
      );
    });

    // A running statement holds its connection, so KILLs sharing the statements' pool could wait behind them
    it('sends the KILL through the control client when given one, not the statements’ client', async () => {
      const { prepared, run, options, controller } = setup('SELECT slow; SELECT 2');
      const ch = fakeRunClickHouse({}, { holdSql: 'SELECT slow' });
      const isKill = (c: { params: { query: string } }) => c.params.query.startsWith('KILL QUERY');

      const done = executeRun(ch.client, prepared, { ...options, controlClient: ch.controlClient });
      await tick();
      controller.abort();
      await done;

      assert.equal(ch.controlCalls.filter(isKill).length, 1);
      assert.equal(ch.calls.filter(isKill).length, 0);
      assert.deepEqual(
        run.statements.map((s) => s.status),
        ['cancelled', 'skipped']
      );
    });

    it("says so when the user isn't allowed to kill queries, and lets the statement finish", async () => {
      const { prepared, run, options, controller } = setup('SELECT slow; SELECT 2');
      const denied = new ClickHouseError({ message: 'Not enough privileges', code: '497', type: 'ACCESS_DENIED' });
      const ch = fakeRunClickHouse({}, { holdSql: 'SELECT slow', killError: denied });

      const done = executeRun(ch.client, prepared, options);
      await tick();
      controller.abort();
      await tick();
      ch.release();
      await done;

      assert.deepEqual(
        run.statements.map((s) => s.status),
        ['ok', 'skipped']
      );
      assert.equal(run.status, 'cancelled');
      assert.match(run.notice ?? '', /SELECT on system\.processes/);
    });

    it('runs nothing more once cancelled between statements', async () => {
      const { prepared, run, options, controller } = setup('SELECT 1; SELECT 2');
      controller.abort();
      const ch = fakeRunClickHouse();

      await executeRun(ch.client, prepared, options);

      assert.equal(ch.calls.length, 0);
      assert.deepEqual(
        run.statements.map((s) => s.status),
        ['skipped', 'skipped']
      );
      assert.equal(run.status, 'cancelled');
    });
  });
});

describe('version', () => {
  /**
   * Looks at a run the way polls do. The version is the ETag, so the same version must always mean the same run: a
   * change it missed would be answered "unchanged" and never reach the browser. Returns how many different runs it saw
   */
  function watch(prepared: PreparedRun) {
    const seen = new Map<number, string>();
    return () => {
      const json = JSON.stringify(prepared.run);
      const earlier = seen.get(prepared.version);
      assert.ok(earlier === undefined || earlier === json, `version ${prepared.version} stands for two different runs`);
      seen.set(prepared.version, json);
      return seen.size;
    };
  }

  it('changes whenever the run does, as its statements start and finish', async () => {
    const { prepared, options } = setup('SELECT 1; SELECT 2');
    const ch = fakeRunClickHouse({}, { holdSql: 'SELECT 2' });
    const look = watch(prepared);

    look();
    const done = executeRun(ch.client, prepared, options);
    look(); // the first statement running
    await tick();
    look(); // the first finished, the second running
    ch.release();
    await done;

    assert.equal(look(), 4);
  });

  it('changes when a cancel notice arrives', async () => {
    const { prepared, options, controller } = setup('SELECT slow');
    const denied = new ClickHouseError({ message: 'Not enough privileges', code: '497', type: 'ACCESS_DENIED' });
    const ch = fakeRunClickHouse({}, { holdSql: 'SELECT slow', killError: denied });
    const look = watch(prepared);

    const done = executeRun(ch.client, prepared, options);
    await tick();
    look();
    controller.abort();
    await tick();
    look();
    ch.release();
    await done;

    assert.ok(prepared.run.notice);
    assert.equal(look(), 3);
  });
});
