import { tokenize } from '../../shared/sqlLexer';

/** A span of text, as offsets */
export interface TextRange {
  from: number;
  to: number;
}

/**
 * Where a statement's SQL is within its text, without the comments (and whitespace) before or after it. A statement's
 * text starts at its first token and comments are tokens, so a comment above a statement is part of it: sent to
 * ClickHouse as written (harmless, and it shows up in the query log), but not shown or highlighted as the statement
 */
export function statementBody(sql: string): TextRange {
  const lexed = tokenize(sql);
  const code = lexed.ok ? lexed.tokens.filter((token) => token.kind !== 'comment' && token.kind !== 'whitespace') : [];
  return code.length === 0 ? { from: 0, to: sql.length } : { from: code[0].start, to: code[code.length - 1].end };
}

/** A statement as shown: without the comments before or after it */
export function statementDisplayText(sql: string): string {
  const { from, to } = statementBody(sql);
  return sql.slice(from, to);
}

// ClickHouse counts positions in UTF-8 bytes; JavaScript strings count UTF-16 code units. Undefined past the end
function charIndexOfByte(text: string, byteOffset: number): number | undefined {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    if (bytes === byteOffset) {
      return index;
    }
    const codePoint = text.codePointAt(index) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return undefined;
}

/**
 * The token a ClickHouse syntax error points at ("failed at position N", 1-based, in bytes), within the statement's
 * text. Its extent comes from our lexer, not the quoted text in the message (not always there, and escaped). Undefined
 * when the message has no position, or it's at or past the end: "(end of query)", or the FORMAT the client appends to
 * a statement that returns rows
 */
export function syntaxErrorToken(sql: string, message: string): TextRange | undefined {
  const position = /failed at position (\d+)/.exec(message)?.[1];
  const offset = position === undefined ? undefined : charIndexOfByte(sql, Number(position) - 1);
  if (offset === undefined) {
    return undefined;
  }
  const lexed = tokenize(sql);
  const token = lexed.ok
    ? lexed.tokens.find((t) => t.start <= offset && offset < t.end && t.kind !== 'whitespace')
    : undefined;
  return token && { from: token.start, to: token.end };
}
