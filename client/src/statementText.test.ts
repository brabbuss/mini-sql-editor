import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statementBody, statementDisplayText, syntaxErrorToken } from './statementText';

describe('statementBody', () => {
  it('leaves out comments before the statement', () => {
    assert.deepEqual(statementBody('-- totals\nSELECT 1'), { from: 10, to: 18 });
  });

  it('leaves out comments after it', () => {
    assert.deepEqual(statementBody('SELECT 1 -- note'), { from: 0, to: 8 });
    assert.deepEqual(statementBody('/* a */ SELECT 1 /* b */'), { from: 8, to: 16 });
  });

  it('is the whole text when there are no comments around it', () => {
    assert.deepEqual(statementBody('SELECT 1'), { from: 0, to: 8 });
  });
});

describe('statementDisplayText', () => {
  it('is the statement without the comment lines above it', () => {
    assert.equal(statementDisplayText('-- A table for the samples\n-- Starts empty\nDROP TABLE t'), 'DROP TABLE t');
  });
});

describe('syntaxErrorToken', () => {
  const error = (position: string) => `Syntax error: failed at position ${position}: …`;

  it('finds the token ClickHouse points at', () => {
    assert.deepEqual(syntaxErrorToken('SELEC 1', error("1 ('SELEC') (line 1, col 1)")), { from: 0, to: 5 });
  });

  // ClickHouse counts UTF-8 bytes (verified: FORM here is at byte 18, character 17)
  it('counts positions in bytes, so text with multi-byte characters still points at the right token', () => {
    const sql = "SELECT 'é' AS x FORM t";

    assert.deepEqual(syntaxErrorToken(sql, error("18 ('FORM')")), { from: 16, to: 20 });
  });

  it('finds tokens on later lines', () => {
    assert.deepEqual(syntaxErrorToken('SELECT 1,\n  2 +, 3', error("18 ('3') (line 2, col 8)")), { from: 17, to: 18 });
  });

  it('has no token at the end of the statement', () => {
    assert.equal(syntaxErrorToken('SELECT 1 +', error('11 (end of query)')), undefined);
  });

  // For statements that return rows, the client appends FORMAT JSONCompact, which ClickHouse may blame
  it('has no token past the end of the statement', () => {
    assert.equal(syntaxErrorToken('SELECT 1 +', error("12 ('FORMAT')")), undefined);
  });

  it('has no token when the error names no position', () => {
    assert.equal(syntaxErrorToken('SELECT 1', 'Unknown table expression identifier'), undefined);
  });
});
