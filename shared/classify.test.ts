import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Classification, StatementKind } from './classify';
import { splitStatements } from './splitStatements';

/** Classifies a one-statement script the way the app does: through the splitter */
function classify(sql: string): Classification {
  const result = splitStatements(sql);
  assert.ok(result.ok && result.statements.length === 1, `expected exactly one statement in ${JSON.stringify(sql)}`);
  return result.statements[0].classification;
}

describe('classify', () => {
  // Verified on ClickHouse 24.6: these return a result (possibly empty), so they must go through client.query
  describe('statements that return rows', () => {
    const cases = [
      'SELECT 1',
      '(SELECT 1)',
      'WITH 1 AS x SELECT x',
      'SELECT 1 UNION ALL SELECT 2',
      'SHOW TABLES',
      'SHOW PROCESSLIST',
      'DESCRIBE TABLE t',
      'DESC t',
      'EXPLAIN SELECT 1',
      'EXISTS TABLE t',
      'CHECK TABLE t'
    ];
    for (const sql of cases) {
      it(`knows ${JSON.stringify(sql)} returns rows`, () => {
        assert.equal(classify(sql).returnsRows, true);
      });
    }
  });

  // Verified: these return no result, and through client.query they either fail after running
  // (DDL and writes) or fail with a syntax error at the appended FORMAT (SET, USE, SYSTEM, INSERT … VALUES)
  describe('statements that return no rows', () => {
    const cases = [
      "INSERT INTO t VALUES (1, 'a')",
      'INSERT INTO t SELECT 1',
      'CREATE TABLE t (a UInt8) ENGINE = Memory',
      'ALTER TABLE t ADD COLUMN b UInt8',
      'DELETE FROM t WHERE a = 1',
      'OPTIMIZE TABLE t FINAL',
      'SET max_threads = 2',
      'USE db',
      'SYSTEM FLUSH LOGS',
      'RENAME TABLE a TO b',
      'EXCHANGE TABLES a AND b',
      'TRUNCATE TABLE t',
      'DETACH TABLE t',
      'ATTACH TABLE t',
      'DROP TABLE t',
      'UNDROP TABLE t',
      // Returns rows only when it kills something; with no match it returns an empty body even with FORMAT
      "KILL QUERY WHERE query_id = 'x' SYNC",
      'GRANT SELECT ON db.* TO u'
    ];
    for (const sql of cases) {
      it(`knows ${JSON.stringify(sql)} returns no rows`, () => {
        assert.equal(classify(sql).returnsRows, false);
      });
    }
  });

  it('reads the first keyword past comments, brackets and letter case', () => {
    assert.equal(classify('-- the answer\n/* really */ (  select 42)').returnsRows, true);
    assert.equal(classify('insert into t values (1)').kind, 'write');
  });

  it('treats an unknown statement as returning no rows', () => {
    assert.deepEqual(classify('FROBNICATE everything'), { kind: 'other', returnsRows: false, hasFormatClause: false });
  });

  describe('kind', () => {
    const cases: [string, StatementKind][] = [
      ['SELECT 1', 'read'],
      ['SHOW TABLES', 'read'],
      ['INSERT INTO t SELECT 1', 'write'],
      ['CREATE TABLE t (a UInt8) ENGINE = Memory', 'ddl'],
      ['ALTER TABLE t ADD COLUMN b UInt8', 'ddl'],
      ['RENAME TABLE a TO b', 'ddl'],
      ['SET max_threads = 2', 'other'],
      ['SYSTEM FLUSH LOGS', 'other'],
      ['KILL QUERY WHERE 1', 'other']
    ];
    for (const [sql, kind] of cases) {
      it(`classifies ${JSON.stringify(sql)} as ${kind}`, () => {
        assert.equal(classify(sql).kind, kind);
      });
    }
  });

  // Statements that delete or overwrite data
  describe('destructive statements', () => {
    const cases = [
      'DROP TABLE t',
      'DROP DATABASE db',
      'TRUNCATE TABLE t',
      'DELETE FROM t WHERE a = 1',
      'ALTER TABLE t DELETE WHERE a = 1',
      'ALTER TABLE t UPDATE a = 2 WHERE 1',
      'ALTER TABLE t DROP COLUMN b',
      'ALTER TABLE t DROP PARTITION 202401',
      'ALTER TABLE t CLEAR COLUMN b',
      'CREATE OR REPLACE TABLE t (a UInt8) ENGINE = Memory',
      'REPLACE TABLE t (a UInt8) ENGINE = Memory'
    ];
    for (const sql of cases) {
      it(`flags ${JSON.stringify(sql)}`, () => {
        assert.equal(classify(sql).kind, 'destructive');
      });
    }

    it('ignores destructive words inside strings and comments', () => {
      assert.equal(classify("SELECT 'DROP TABLE t'").kind, 'read');
      assert.equal(classify("ALTER TABLE t COMMENT COLUMN b 'delete me'").kind, 'ddl');
      assert.equal(classify('-- DROP TABLE t\nSELECT 1').kind, 'read');
    });
  });

  // A user-written FORMAT clashes with the one client.query appends. Verified: the clause is last or followed
  // only by SETTINGS, it isn't allowed in a subquery, and "format" is also a valid column and function name.
  describe('FORMAT clause', () => {
    const withFormat = [
      'SELECT 1 FORMAT CSV',
      'SELECT 1 format JSONEachRow',
      'SELECT 1 FORMAT CSV SETTINGS max_threads = 1',
      'SELECT 1 SETTINGS max_threads = 1 FORMAT CSV',
      "SHOW TABLES FROM system LIKE 'one' FORMAT CSV",
      'SELECT 1 FORMAT CSV;'
    ];
    for (const sql of withFormat) {
      it(`detects it in ${JSON.stringify(sql)}`, () => {
        assert.equal(classify(sql).hasFormatClause, true);
      });
    }

    const withoutFormat = [
      'SELECT 1',
      'SELECT format FROM t',
      'SELECT x AS format FROM t',
      "SELECT format('{}-{}', 1, 2)",
      "SELECT 'FORMAT CSV'",
      'SELECT 1 -- FORMAT CSV',
      'SELECT * FROM (SELECT 1 FORMAT CSV) AS sub WHERE 1'
    ];
    for (const sql of withoutFormat) {
      it(`does not detect it in ${JSON.stringify(sql)}`, () => {
        assert.equal(classify(sql).hasFormatClause, false);
      });
    }
  });
});
