import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { failedRow, formatBytes, formatForFile, mayHaveInsertedRows } from './files';

describe('formatForFile', () => {
  it('picks the format from the file extension, in any case', () => {
    assert.equal(formatForFile('events.csv'), 'CSVWithNames');
    assert.equal(formatForFile('events.TSV'), 'TabSeparatedWithNames');
    assert.equal(formatForFile('events.tab'), 'TabSeparatedWithNames');
    assert.equal(formatForFile('events.jsonl'), 'JSONEachRow');
    assert.equal(formatForFile('events.ndjson'), 'JSONEachRow');
    assert.equal(formatForFile('events.json'), 'JSONEachRow');
    assert.equal(formatForFile('events.parquet'), 'Parquet');
  });

  it('has no guess for other files', () => {
    assert.equal(formatForFile('events.xlsx'), undefined);
    assert.equal(formatForFile('events'), undefined);
  });
});

describe('failedRow', () => {
  it("reads the row from ClickHouse's parse error", () => {
    const message = "Cannot parse input: expected ',' before: 'notanumber,c\\n': (at row 3)\\n: Row 2: …";

    assert.equal(failedRow(message), 3);
  });

  it('is undefined for errors without a row', () => {
    assert.equal(failedRow('Table default.nope does not exist'), undefined);
  });
});

// ClickHouse writes an insert in blocks of about a million rows, so a failure past the first block can leave rows
describe('mayHaveInsertedRows', () => {
  it('is false when the failing row is within the first block', () => {
    assert.equal(mayHaveInsertedRows('… (at row 3) …'), false);
    assert.equal(mayHaveInsertedRows('… (at row 1000000) …'), false);
  });

  it('is true when the failing row is past it', () => {
    assert.equal(mayHaveInsertedRows('… (at row 1500002) …'), true);
  });

  it('is false for errors without a row', () => {
    assert.equal(mayHaveInsertedRows('Not enough privileges'), false);
  });
});

describe('formatBytes', () => {
  it('uses the largest unit that keeps the number at least 1', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
    assert.equal(formatBytes(100 * 1024 * 1024), '100 MB');
  });
});
