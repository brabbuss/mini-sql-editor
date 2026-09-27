import { SQLDialect } from '@codemirror/lang-sql';

/**
 * Editor highlighting for ClickHouse's lexical rules (the splitter in shared/sqlLexer.ts follows them exactly;
 * highlighting is close enough). CodeMirror already handles nested block comments.
 */
export const ClickHouseDialect = SQLDialect.define({
  // "# " and "#!" comments. CodeMirror treats any # as a comment, so a bare "#x" (a ClickHouse syntax error) also looks like one
  hashComments: true,
  // $$…$$ and $tag$…$tag$ heredocs; CodeMirror only allows word characters in the tag
  doubleDollarQuotedStrings: true,
  // 'it\'s' is one string
  backslashEscapes: true,
  // "identifier" and `identifier`
  identifierQuotes: '"`'
});
