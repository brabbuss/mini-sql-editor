import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements } from './splitStatements';

/** The statements' SQL, or fails the test with the split error */
function sqlOf(script: string): string[] {
  const result = splitStatements(script);
  assert.ok(result.ok, result.ok ? '' : `unexpected error: ${result.error.message}`);
  return result.statements.map((s) => s.sql);
}

function errorOf(script: string) {
  const result = splitStatements(script);
  assert.ok(!result.ok, 'expected a split error');
  return result.error;
}

describe('splitStatements', () => {
  describe('statement boundaries', () => {
    it('returns a single statement without a semicolon as-is', () => {
      assert.deepEqual(sqlOf('SELECT 1'), ['SELECT 1']);
    });

    it('splits on semicolons and leaves them out of the statements', () => {
      assert.deepEqual(sqlOf('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
    });

    it("keeps each statement's exact text, including internal newlines and comments", () => {
      assert.deepEqual(sqlOf('SELECT\n  1 -- one\n; SELECT /* two */ 2'), ['SELECT\n  1 -- one', 'SELECT /* two */ 2']);
    });

    it('records where each statement starts and ends in the script', () => {
      const script = 'SELECT 1;\n\n  SELECT 2';
      const result = splitStatements(script);

      assert.ok(result.ok);
      assert.deepEqual(
        result.statements.map((s) => [s.start, s.end]),
        [
          [0, 8],
          [13, 21]
        ]
      );
      assert.equal(script.slice(result.statements[1].start, result.statements[1].end), 'SELECT 2');
    });

    it('drops empty statements between semicolons', () => {
      assert.deepEqual(sqlOf('SELECT 1;; ;\n; SELECT 2'), ['SELECT 1', 'SELECT 2']);
    });

    // ClickHouse rejects a comment-only query ("Empty query")
    it('drops statements that are only comments', () => {
      assert.deepEqual(sqlOf('SELECT 1; -- done\n; /* nothing */; SELECT 2; -- trailing'), ['SELECT 1', 'SELECT 2']);
    });

    it('has no statements for an empty, blank or comment-only script', () => {
      assert.deepEqual(sqlOf(''), []);
      assert.deepEqual(sqlOf('  \n\t '), []);
      assert.deepEqual(sqlOf('-- just a note\n/* and another */'), []);
    });

    it('keeps a leading comment as part of the statement', () => {
      assert.deepEqual(sqlOf('-- the answer\nSELECT 42'), ['-- the answer\nSELECT 42']);
    });

    it('classifies each statement', () => {
      const result = splitStatements('SELECT 1; DROP TABLE t');

      assert.ok(result.ok);
      assert.deepEqual(
        result.statements.map((s) => s.classification),
        [
          { kind: 'read', returnsRows: true, hasFormatClause: false },
          { kind: 'destructive', returnsRows: false, hasFormatClause: false }
        ]
      );
    });

    it('keeps a trailing line comment without a newline', () => {
      assert.deepEqual(sqlOf('SELECT 1 -- done'), ['SELECT 1 -- done']);
    });
  });

  describe('semicolons that do not end a statement', () => {
    const cases: [string, string][] = [
      ['a single-quoted string', "SELECT 'a;b'"],
      ["a string with '' escapes", "SELECT 'it''s; fine'"],
      ['a string with \\ escapes', "SELECT 'it\\'s; fine'"],
      ['a double-quoted identifier', 'SELECT 1 AS "a;b"'],
      ['a double-quoted identifier with escapes', 'SELECT 1 AS "a""b;c\\"d"'],
      ['a backtick identifier', 'SELECT 1 AS `a;b`'],
      ['a backtick identifier with escapes', 'SELECT 1 AS `a``b;c\\`d`'],
      ['a -- comment', 'SELECT 1 -- a; b\n'],
      ['a # comment', 'SELECT 1 # a; b\n'],
      ['a #! comment', 'SELECT 1 #! a; b\n'],
      ['a block comment', 'SELECT /* a; b */ 1'],
      ['a nested block comment', 'SELECT /* a /* b; */ c; */ 1'],
      ['a heredoc', 'SELECT $$a;b$$'],
      ['a tagged heredoc', 'SELECT $x$a;b$x$'],
      // ClickHouse accepts anything but $ in the tag, including ; and spaces
      ['a heredoc whose tag contains ; and a space', 'SELECT $a; b$x;y$a; b$'],
      ['quotes inside a heredoc', 'SELECT $$it\'s "; `$$']
    ];
    for (const [where, statement] of cases) {
      it(`ignores a semicolon inside ${where}`, () => {
        assert.deepEqual(sqlOf(`${statement}; SELECT 2`), [statement.trimEnd(), 'SELECT 2']);
      });
    }

    it('ignores quotes and comment markers inside strings', () => {
      assert.deepEqual(sqlOf("SELECT '-- /* $$ \"'; SELECT 2"), ["SELECT '-- /* $$ \"'", 'SELECT 2']);
    });
  });

  describe('things that look special but are not', () => {
    // ClickHouse only treats "# " and "#!" as comments; "#x" is a syntax error it should report
    it('does not treat # without a following space or ! as a comment', () => {
      assert.deepEqual(sqlOf('SELECT 1 #x; SELECT 2'), ['SELECT 1 #x', 'SELECT 2']);
    });

    // $ inside a word is part of the identifier, not the start of a heredoc
    it('does not treat $ inside an identifier as a heredoc', () => {
      assert.deepEqual(sqlOf('SELECT 1 AS a$b; SELECT 1 AS x$$y$$; SELECT 2'), [
        'SELECT 1 AS a$b',
        'SELECT 1 AS x$$y$$',
        'SELECT 2'
      ]);
    });
  });

  describe('structural errors, reported where the unclosed part starts', () => {
    const cases: [string, string, string, number][] = [
      ['a string', "SELECT 'abc", 'Unterminated string', 7],
      ['a double-quoted identifier', 'SELECT 1 AS "abc', 'Unterminated quoted identifier', 12],
      ['a backtick identifier', 'SELECT 1 AS `abc', 'Unterminated quoted identifier', 12],
      ['a block comment', 'SELECT 1 /* abc', 'Unterminated comment', 9],
      ['a nested block comment', 'SELECT 1 /* a /* b */ c', 'Unterminated comment', 9],
      ['a heredoc', 'SELECT $$abc', 'Unterminated heredoc', 7],
      ['a tagged heredoc', 'SELECT $x$abc$y$', 'Unterminated heredoc', 7]
    ];
    for (const [what, script, message, position] of cases) {
      it(`reports an unterminated ${what}`, () => {
        assert.deepEqual(errorOf(script), { message, position });
      });
    }

    it('reports the position in the whole script, not the statement', () => {
      assert.equal(errorOf("SELECT 1;\nSELECT 'oops").position, 17);
    });
  });
});
