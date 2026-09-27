import { Run, StatementResult } from '../../../shared/api';
import { tokenize } from '../../../shared/sqlLexer';

/** How a value appears in a results cell. */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'object') {
    // Arrays, tuples, maps and JSON columns
    return JSON.stringify(value);
  }
  return String(value);
}

const SUMMARY_MAX_LENGTH = 300;

/**
 * The part of an error message worth showing up front. ClickHouse syntax errors continue with a list
 * of every statement type it expected, which belongs behind a "details" toggle.
 */
export function errorSummary(message: string): string {
  const firstLine = message.split('\n', 1)[0].trim();
  return firstLine.length > SUMMARY_MAX_LENGTH ? `${firstLine.slice(0, SUMMARY_MAX_LENGTH)}…` : firstLine;
}

/** A statement's tab label: its number and first keyword, e.g. "2 · INSERT" */
export function statementLabel({ index, sql }: StatementResult): string {
  // The shared lexer skips comments the same way the splitter does, so a leading comment isn't mistaken for a keyword
  const lexed = tokenize(sql);
  const word = lexed.ok ? lexed.tokens.find((token) => token.kind === 'word') : undefined;
  const keyword = word && sql.slice(word.start, word.end);
  // Numbers lex as words too; a keyword starts with a letter
  return keyword && /^[a-z]/i.test(keyword) ? `${index + 1} · ${keyword.toUpperCase()}` : `Statement ${index + 1}`;
}

/**
 * Which statement to show when a run's results appear: the one that failed, is running or was cancelled (where the
 * run stopped), else the last one that returned rows (a script usually ends with the SELECT it was building up to),
 * else the last one.
 */
export function defaultStatementIndex({ statements }: Run): number {
  for (const status of ['error', 'running', 'cancelled'] as const) {
    const match = statements.find((s) => s.status === status);
    if (match) {
      return match.index;
    }
  }
  const withRows = statements.filter((s) => s.columns !== undefined);
  return withRows.length > 0 ? withRows[withRows.length - 1].index : statements.length - 1;
}

/** Quick polls at first, so short queries feel instant; then once a second, so long runs don't flood the server */
export function nextPollDelay(elapsedMs: number): number {
  return elapsedMs < 2000 ? 250 : 1000;
}

/** "120 ms", or "3.2 s" from a second up */
export function formatDuration(ms: number): string {
  // Rounded first, so 999.6 ms reads "1.0 s", not "1000 ms"
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded} ms` : `${(rounded / 1000).toFixed(1)} s`;
}
