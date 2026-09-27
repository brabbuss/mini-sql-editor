import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouseError } from '@clickhouse/client';
import { ROW_CAP } from '../shared/api';
import { splitStatements, Statement } from '../shared/splitStatements';
import { RequestError } from './errors';
import { executeStatement, MAX_EXECUTION_SECONDS, StatementOptions } from './statement';
import { fakeRunClickHouse } from './testHelpers';

function statement(sql: string): Statement {
  const result = splitStatements(sql);
  assert.ok(result.ok && result.statements.length === 1);
  return result.statements[0];
}

const options: StatementOptions = {
  queryId: 'q-1',
  requestOptions: { auth: { username: 'alice', password: 's3cret' }, http_headers: { 'x-clickhouse-database': 'db' } },
  tag: { endpoint: 'test' }
};

describe('executeStatement', () => {
  it('sends a statement that returns rows through query, as JSONCompact, and returns its result', async () => {
    const meta = [{ name: 'n', type: 'UInt64' }];
    const ch = fakeRunClickHouse({ 'SELECT n FROM t': { meta, data: [['1'], ['2']] } });

    const output = await executeStatement(ch.client, statement('SELECT n FROM t'), options);

    assert.deepEqual(ch.calls, [
      {
        method: 'query',
        params: {
          query: 'SELECT n FROM t',
          format: 'JSONCompact',
          query_id: 'q-1',
          clickhouse_settings: {
            log_comment: JSON.stringify({ app: 'sql-editor', endpoint: 'test' }),
            // ClickHouse stops the statement itself at the time limit, so it can't outlive a reported failure
            max_execution_time: MAX_EXECUTION_SECONDS,
            // An error partway through a result would otherwise arrive as a 200 with partial rows
            wait_end_of_query: 1,
            max_result_rows: String(ROW_CAP + 1),
            result_overflow_mode: 'break'
          },
          auth: { username: 'alice', password: 's3cret' },
          http_headers: { 'x-clickhouse-database': 'db' }
        }
      }
    ]);
    assert.deepEqual(output, {
      columns: meta,
      rows: [['1'], ['2']],
      truncated: false,
      stats: { rowsRead: 2, bytesRead: 16 }
    });
  });

  it('sends a statement that returns no rows through command, as written, and returns nothing', async () => {
    const ch = fakeRunClickHouse();

    const output = await executeStatement(ch.client, statement("INSERT INTO t VALUES (1, 'a')"), options);

    assert.equal(output, undefined);
    assert.deepEqual(ch.calls, [
      {
        method: 'command',
        params: {
          query: "INSERT INTO t VALUES (1, 'a')",
          query_id: 'q-1',
          clickhouse_settings: {
            log_comment: JSON.stringify({ app: 'sql-editor', endpoint: 'test' }),
            // Writes too: a write that outlived its reported failure is the worst case
            max_execution_time: MAX_EXECUTION_SECONDS
          },
          auth: { username: 'alice', password: 's3cret' },
          http_headers: { 'x-clickhouse-database': 'db' }
        }
      }
    ]);
  });

  it('runs in the given ClickHouse session, and in none otherwise', async () => {
    const ch = fakeRunClickHouse();

    await executeStatement(ch.client, statement('USE db'), { ...options, sessionId: 'run-1' });
    await executeStatement(ch.client, statement('USE db'), options);

    assert.equal(ch.calls[0].params.session_id, 'run-1');
    assert.ok(!('session_id' in ch.calls[1].params));
  });

  it(`keeps the first ${ROW_CAP.toLocaleString()} rows and says when there were more`, async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => [i]);
    const ch = fakeRunClickHouse({
      'SELECT big': { data: rows(ROW_CAP + 5) },
      'SELECT exact': { data: rows(ROW_CAP) }
    });

    const big = await executeStatement(ch.client, statement('SELECT big'), options);
    const exact = await executeStatement(ch.client, statement('SELECT exact'), options);

    assert.equal(big?.rows.length, ROW_CAP);
    assert.equal(big?.truncated, true);
    assert.equal(exact?.rows.length, ROW_CAP);
    assert.equal(exact?.truncated, false);
  });

  // client.query would append its own FORMAT, which clashes with the user's
  it('rejects a statement with its own FORMAT clause without sending it', async () => {
    const ch = fakeRunClickHouse();

    await assert.rejects(executeStatement(ch.client, statement('SELECT 1 FORMAT CSV'), options), (error) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.status, 400);
      assert.match(error.message, /FORMAT/);
      return true;
    });
    assert.equal(ch.calls.length, 0);
  });

  it('turns an error in the response body into a ClickHouseError, not a result', async () => {
    const exception =
      "Code: 395. DB::Exception: Value passed to 'throwIf' function is non-zero. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO)";
    const ch = fakeRunClickHouse({ 'SELECT 1': { exception } });

    await assert.rejects(executeStatement(ch.client, statement('SELECT 1'), options), (error) => {
      assert.ok(error instanceof ClickHouseError);
      assert.equal(error.code, '395');
      assert.equal(error.type, 'FUNCTION_THROW_IF_VALUE_IS_NON_ZERO');
      return true;
    });
  });

  it("passes ClickHouse's errors on to the caller", async () => {
    const syntaxError = new ClickHouseError({ message: 'Syntax error', code: '62', type: 'SYNTAX_ERROR' });
    const ch = fakeRunClickHouse({ 'SELEC 1': { error: syntaxError } });

    await assert.rejects(executeStatement(ch.client, statement('SELEC 1'), options), syntaxError);
  });
});
