import { InsertFormat } from '../../../shared/api';

/** How each format is named in the dialog */
export const FORMAT_LABELS: Record<InsertFormat, string> = {
  CSVWithNames: 'CSV with a header row',
  TabSeparatedWithNames: 'TSV with a header row',
  JSONEachRow: 'JSON: one object per line, or an array of objects',
  Parquet: 'Parquet'
};

const EXTENSION_FORMATS: Record<string, InsertFormat> = {
  csv: 'CSVWithNames',
  tsv: 'TabSeparatedWithNames',
  tab: 'TabSeparatedWithNames',
  jsonl: 'JSONEachRow',
  ndjson: 'JSONEachRow',
  // JSONEachRow also reads a single JSON array of objects (verified on 24.6), so a .json file works either way
  json: 'JSONEachRow',
  parquet: 'Parquet'
};

/** For the file picker: the extensions a format can be guessed from */
export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSION_FORMATS)
  .map((extension) => `.${extension}`)
  .join(',');

/** The format a file's extension suggests, if any */
export function formatForFile(name: string): InsertFormat | undefined {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  return extension ? EXTENSION_FORMATS[extension] : undefined;
}

/** The row a ClickHouse parse error points at ("… (at row 3) …"), if it names one */
export function failedRow(message: string): number | undefined {
  const row = /\(at row (\d+)\)/.exec(message)?.[1];
  return row === undefined ? undefined : Number(row);
}

// ClickHouse writes an insert in blocks of about a million rows (min_insert_block_size_rows, 1,048,449 by default)
const ROWS_PER_BLOCK = 1_000_000;

/**
 * Whether a failed insert may have left rows in the table. Inserts aren't all-or-nothing: a bad row after the first
 * block leaves the rows before it (verified on 24.6). Within the first block, nothing is written
 */
export function mayHaveInsertedRows(message: string): boolean {
  const row = failedRow(message);
  return row !== undefined && row > ROWS_PER_BLOCK;
}

/** "512 B", "1.5 KB", "3.0 MB", "100 MB" */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) {
    return `${value} B`;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
