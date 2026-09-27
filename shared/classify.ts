import { Token } from './sqlLexer';

export type StatementKind = 'read' | 'write' | 'ddl' | 'destructive' | 'other';

export interface Classification {
  kind: StatementKind;
  /** Whether ClickHouse returns a result, even an empty one. Decides client.query vs client.command */
  returnsRows: boolean;
  /** A user-written FORMAT clause, which clashes with the one client.query appends */
  hasFormatClause: boolean;
}

// Verified on ClickHouse 24.6: these return a result. Everything else returns none (see the tests)
const RETURNS_ROWS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'EXISTS', 'CHECK']);
const DDL = new Set(['CREATE', 'ALTER', 'RENAME', 'EXCHANGE', 'ATTACH', 'DETACH', 'UNDROP']);
// Statements that delete or overwrite data. DELETE is the lightweight DELETE FROM; REPLACE is REPLACE TABLE
const DESTRUCTIVE = new Set(['DROP', 'TRUNCATE', 'DELETE', 'REPLACE']);
// ALTER actions that delete or overwrite data, e.g. ALTER TABLE t DELETE WHERE …, ALTER TABLE t DROP COLUMN …
const DESTRUCTIVE_ALTER_ACTIONS = new Set(['DELETE', 'UPDATE', 'DROP', 'CLEAR']);

interface Word {
  text: string;
  /** How many brackets it's inside: 0 is the statement itself, not a subquery or function call */
  depth: number;
  /** Position among the statement's words and brackets */
  index: number;
}

const OTHER: Classification = { kind: 'other', returnsRows: false, hasFormatClause: false };

/**
 * Classifies one statement from its keywords. splitStatements calls this while it has the statement's tokens,
 * so the script is lexed once and every statement comes out already classified. Words inside strings,
 * comments and heredocs don't count, because the lexer has already set those apart.
 *
 * @param source the text the tokens' positions point into (the whole script)
 * @param tokens the statement's tokens, without the terminating semicolon
 */
export function classify(source: string, tokens: Token[]): Classification {
  // The statement's words and brackets, with the bracket depth of each word
  const significant = tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'comment');
  const words: Word[] = [];
  let depth = 0;
  significant.forEach((token, index) => {
    if (token.kind === 'openParen') {
      depth++;
    } else if (token.kind === 'closeParen') {
      depth--;
    } else if (token.kind === 'word') {
      words.push({ text: source.slice(token.start, token.end).toUpperCase(), depth, index });
    }
  });

  // The first keyword, past any opening brackets: (SELECT 1) is a SELECT
  const firstNonBracket = significant.findIndex((t) => t.kind !== 'openParen');
  const first = words.find((w) => w.index === firstNonBracket);
  if (!first) {
    return OTHER;
  }
  const keyword = first.text;
  const topLevelWords = words.filter((w) => w.depth === 0);

  return {
    kind: kindOf(keyword, words),
    returnsRows: RETURNS_ROWS.has(keyword),
    hasFormatClause: hasFormatClause(topLevelWords, significant.length)
  };
}

function kindOf(keyword: string, words: Word[]): StatementKind {
  if (RETURNS_ROWS.has(keyword)) {
    return 'read';
  }
  if (keyword === 'INSERT') {
    return 'write';
  }
  if (DESTRUCTIVE.has(keyword)) {
    return 'destructive';
  }
  if (keyword === 'CREATE' && words[1]?.text === 'OR' && words[2]?.text === 'REPLACE') {
    return 'destructive';
  }
  if (keyword === 'ALTER' && words.some((w) => w.depth === 0 && DESTRUCTIVE_ALTER_ACTIONS.has(w.text))) {
    return 'destructive';
  }
  if (DDL.has(keyword)) {
    return 'ddl';
  }
  return 'other';
}

/**
 * FORMAT <name> at the top level, either last or followed only by SETTINGS (verified: the only places ClickHouse
 * accepts it). Anything else named "format" is a column, alias or function, e.g. SELECT format FROM t.
 */
function hasFormatClause(topLevelWords: Word[], tokenCount: number): boolean {
  return topLevelWords.some((word, i) => {
    const name = topLevelWords[i + 1];
    const after = topLevelWords[i + 2];
    const nameIsNextToken = name?.index === word.index + 1;
    const isLast = name?.index === tokenCount - 1;
    return word.text === 'FORMAT' && nameIsNextToken && (isLast || after?.text === 'SETTINGS');
  });
}
