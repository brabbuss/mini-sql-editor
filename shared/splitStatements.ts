import { Classification, classify } from './classify';
import { LexError, Token, tokenize } from './sqlLexer';

export interface Statement {
  /** The statement's exact text from the script, without the terminating semicolon */
  sql: string;
  /** Where the statement starts and ends in the script, so errors can point back into the editor */
  start: number;
  end: number;
  /** How to run it: query vs command, whether it's destructive, whether it has its own FORMAT */
  classification: Classification;
}

export type SplitResult = { ok: true; statements: Statement[] } | { ok: false; error: LexError };

const isBlank = (token: Token) => token.kind === 'whitespace';
const isContent = (token: Token) => token.kind !== 'whitespace' && token.kind !== 'comment';

/**
 * Splits a script into statements at semicolons that aren't inside a string, identifier, comment or heredoc.
 * SQL is never rewritten: each statement is a slice of the script, trimmed of surrounding whitespace.
 * Statements that are only comments are dropped, because ClickHouse rejects them ("Empty query").
 */
export function splitStatements(script: string): SplitResult {
  const lexed = tokenize(script);
  if (!lexed.ok) {
    return lexed;
  }

  const statements: Statement[] = [];
  let segment: Token[] = [];
  const endSegment = () => {
    if (segment.some(isContent)) {
      const first = segment.find((token) => !isBlank(token)) as Token;
      const last = [...segment].reverse().find((token) => !isBlank(token)) as Token;
      // classify while we have the statement's tokens: the script is lexed once, and they're dropped after this
      statements.push({
        sql: script.slice(first.start, last.end),
        start: first.start,
        end: last.end,
        classification: classify(script, segment)
      });
    }
    segment = [];
  };

  for (const token of lexed.tokens) {
    if (token.kind === 'semicolon') {
      endSegment();
    } else {
      segment.push(token);
    }
  }
  endSegment();

  return { ok: true, statements };
}
