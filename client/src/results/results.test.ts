import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Run, StatementResult } from '../../../shared/api';
import {
  defaultStatementIndex,
  errorSummary,
  formatCellValue,
  formatDuration,
  nextPollDelay,
  statementLabel
} from './results';

function statement(index: number, overrides: Partial<StatementResult> = {}): StatementResult {
  return { index, sql: 'SELECT 1', start: 0, end: 8, kind: 'read', status: 'ok', ...overrides };
}

function runOf(statements: StatementResult[]): Run {
  return { id: 'run-1', status: 'finished', statements, startedAt: '2026-01-01T00:00:00.000Z' };
}

describe('formatCell', () => {
  it('shows NULL for null', () => {
    assert.equal(formatCellValue(null), 'NULL');
  });

  it('shows single values as text', () => {
    assert.equal(formatCellValue('18446744073709551615'), '18446744073709551615');
    assert.equal(formatCellValue(42), '42');
    assert.equal(formatCellValue(false), 'false');
    assert.equal(formatCellValue(''), '');
  });

  it('shows arrays and maps as JSON', () => {
    assert.equal(formatCellValue([1, [2, 3]]), '[1,[2,3]]');
    assert.equal(formatCellValue({ k: 'v' }), '{"k":"v"}');
  });
});

describe('errorSummary', () => {
  it('keeps only the first line of a ClickHouse error', () => {
    const message =
      "Syntax error: failed at position 1 ('SELEC') (line 1, col 1): SELEC 1 \nFORMAT JSONEachRow. Expected one of: Query, ...";

    assert.equal(errorSummary(message), "Syntax error: failed at position 1 ('SELEC') (line 1, col 1): SELEC 1");
  });

  it('shortens a very long first line', () => {
    const summary = errorSummary('x'.repeat(1000));

    assert.equal(summary.length, 301);
    assert.ok(summary.endsWith('…'));
  });
});

describe('statementLabel', () => {
  it('numbers the statement and names it by its first keyword', () => {
    assert.equal(statementLabel(statement(1, { sql: 'insert into t values (1)' })), '2 · INSERT');
  });

  it('skips comments before the first keyword', () => {
    assert.equal(statementLabel(statement(0, { sql: '-- totals\n/* by day */ SELECT 1' })), '1 · SELECT');
  });

  it('falls back to the number when there is no keyword', () => {
    assert.equal(statementLabel(statement(0, { sql: '(1)' })), 'Statement 1');
  });
});

describe('defaultStatementIndex', () => {
  it('shows the statement that failed', () => {
    const run = runOf([statement(0), statement(1, { status: 'error' }), statement(2, { status: 'skipped' })]);

    assert.equal(defaultStatementIndex(run), 1);
  });

  it('shows the statement that is running', () => {
    const run = runOf([statement(0), statement(1, { status: 'running' }), statement(2, { status: 'pending' })]);

    assert.equal(defaultStatementIndex(run), 1);
  });

  it('shows the statement that was cancelled', () => {
    const run = runOf([
      statement(0, { columns: [{ name: 'n', type: 'UInt8' }], rows: [[1]] }),
      statement(1, { status: 'cancelled' }),
      statement(2, { status: 'skipped' })
    ]);

    assert.equal(defaultStatementIndex(run), 1);
  });

  // A script usually ends with the SELECT it was building up to
  it('otherwise shows the last statement that returned rows', () => {
    const run = runOf([
      statement(0, { kind: 'ddl' }),
      statement(1, { columns: [{ name: 'n', type: 'UInt8' }], rows: [[1]] }),
      statement(2, { kind: 'write' })
    ]);

    assert.equal(defaultStatementIndex(run), 1);
  });

  it('shows the last statement when none returned rows', () => {
    assert.equal(defaultStatementIndex(runOf([statement(0, { kind: 'ddl' }), statement(1, { kind: 'write' })])), 1);
  });
});

describe('nextPollDelay', () => {
  it('polls quickly at first, so short queries feel instant', () => {
    assert.equal(nextPollDelay(0), 250);
    assert.equal(nextPollDelay(1999), 250);
  });

  it('polls once a second once the run has taken a while', () => {
    assert.equal(nextPollDelay(2000), 1000);
    assert.equal(nextPollDelay(600_000), 1000);
  });
});

describe('formatDuration', () => {
  it('shows short durations in milliseconds', () => {
    assert.equal(formatDuration(0.4), '0 ms');
    assert.equal(formatDuration(999.4), '999 ms');
  });

  it('shows a second or more in seconds, to a tenth', () => {
    assert.equal(formatDuration(999.6), '1.0 s');
    assert.equal(formatDuration(1000), '1.0 s');
    assert.equal(formatDuration(12_345), '12.3 s');
  });
});
