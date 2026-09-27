/**
 * Breaks SQL into coarse tokens: just enough to know where strings, identifiers, comments and statement
 * boundaries are. Not a parser: syntax and meaning are ClickHouse's job.
 *
 * Follows ClickHouse 24.6:
 * - strings '…' escape with '' or \' ; identifiers "…" and `…` escape by doubling or with a backslash
 * - comments: --, "# " and "#!" to the end of the line (other uses of # are not comments), and nested /* … *\/
 * - heredocs $tag$…$tag$: the tag is anything but $ (even ; or spaces), and $ only starts one at the start of
 *   a token; inside a word it's part of the identifier (a$b)
 */

export type TokenKind =
  | 'word'
  | 'string'
  | 'quotedIdentifier'
  | 'heredoc'
  | 'comment'
  | 'semicolon'
  | 'openParen'
  | 'closeParen'
  | 'whitespace'
  | 'other';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

export interface LexError {
  message: string;
  /** Offset in the input where the unclosed string, identifier, comment or heredoc starts */
  position: number;
}

export type LexResult = { ok: true; tokens: Token[] } | { ok: false; error: LexError };

const WHITESPACE = /\s/; // any whitespace character
const WORD_START = /[A-Za-z0-9_]/; // any char that can begin a word
const WORD_CHAR = /[A-Za-z0-9_$]/; // that can continue a word
// The only single characters the splitter and classifier care about; any other character is 'other'
const PUNCTUATION: Partial<Record<string, TokenKind>> = { ';': 'semicolon', '(': 'openParen', ')': 'closeParen' };

export function tokenize(sql: string): LexResult {
  const tokens: Token[] = [];
  let i = 0;

  const fail = (message: string, position: number): LexResult => ({ ok: false, error: { message, position } });

  while (i < sql.length) {
    const start = i;
    const c = sql[i];
    const next = sql[i + 1];
    // A $ may open a heredoc; its opening delimiter runs to the next $ (-1: there is none, so it can't be one)
    const tagEnd = c === '$' ? sql.indexOf('$', i + 1) : -1;

    if (WHITESPACE.test(c)) {
      // iterate over whitespace
      while (i < sql.length && WHITESPACE.test(sql[i])) {
        i++;
      }
      tokens.push({ kind: 'whitespace', start, end: i });
    } else if ((c === '-' && next === '-') || (c === '#' && (next === ' ' || next === '!'))) {
      const newline = sql.indexOf('\n', i); // first line after end of comment
      i = newline === -1 ? sql.length : newline; // if no newline, end of script
      tokens.push({ kind: 'comment', start, end: i });
    } else if (c === '/' && next === '*') {
      let depth = 0; // representing nested comments
      while (i < sql.length) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          // we can't just sql.find('*/') because we need to handle nested comments
          // eg 'SELECT /* disabled: WHERE x = 1 /* old filter */; */ 1'
          depth--;
          i += 2;
          if (depth === 0) {
            // when depth reaches 0, every /* has its */
            // w/o break, everything after /* */ would be treated as a comment
            break;
          }
        } else {
          // just a character part of the comment
          i++;
        }
      }
      if (depth > 0) {
        return fail('Unterminated comment', start);
      }
      tokens.push({ kind: 'comment', start, end: i });
    } else if (c === "'" || c === '"' || c === '`') {
      // 'string', "identifier" or `identifier`: all escape the same way, and only the opening quote closes it
      i++; // past the opening quote
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          // backslash escape: skip it and the character it escapes, so \' doesn't close the string
          i += 2;
        } else if (sql[i] === c && sql[i + 1] === c) {
          // doubled quote ('it''s') is an escaped quote; checked before the closing quote below
          i += 2;
        } else if (sql[i] === c) {
          // the closing quote
          i++;
          closed = true;
          break;
        } else {
          // just a character inside the quotes, including ; -- and /*
          i++;
        }
      }
      // reached the end of the script without a closing quote (ClickHouse rejects it too)
      if (!closed) {
        return fail(c === "'" ? 'Unterminated string' : 'Unterminated quoted identifier', start);
      }
      tokens.push({ kind: c === "'" ? 'string' : 'quotedIdentifier', start, end: i });
    } else if (tagEnd !== -1) {
      // $tag$ … $tag$: the heredoc closes at the next copy of its opening delimiter
      const opener = sql.slice(i, tagEnd + 1);
      const close = sql.indexOf(opener, i + opener.length);
      if (close === -1) {
        return fail('Unterminated heredoc', start);
      }
      i = close + opener.length;
      tokens.push({ kind: 'heredoc', start, end: i });
    } else if (WORD_START.test(c)) {
      // keywords, identifiers, function names, numbers: the classifier reads the first word of a statement
      while (i < sql.length && WORD_CHAR.test(sql[i])) {
        // while allowable word characters are found
        i++;
      }
      tokens.push({ kind: 'word', start, end: i });
    } else {
      // one character: ; ends a statement
      // brackets let the classifier see through (SELECT …), anything else is left for ClickHouse to judge
      i++;
      tokens.push({ kind: PUNCTUATION[c] ?? 'other', start, end: i });
    }
  }

  return { ok: true, tokens };
}
