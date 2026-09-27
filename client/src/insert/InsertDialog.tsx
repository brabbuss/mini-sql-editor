import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Dialog, Select, Text } from '@clickhouse/click-ui';
import { INSERT_FORMATS, InsertFormat, InsertResult, MAX_INSERT_BYTES, TableRef } from '../../../shared/api';
import { ApiError, insertFile, isAbort, listTables } from '../api';
import { errorSummary, formatDuration } from '../results/results';
import {
  ACCEPTED_EXTENSIONS,
  failedRow,
  FORMAT_LABELS,
  formatBytes,
  formatForFile,
  mayHaveInsertedRows
} from './files';

type TablesState =
  { status: 'loading' } | { status: 'ready'; tables: TableRef[] } | { status: 'failed'; error: ApiError };

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; result: InsertResult; table: TableRef }
  | { status: 'failed'; error: ApiError };

// A table as a Select value. Names can contain dots, so not "database.name"
const tableKey = ({ database, name }: TableRef) => JSON.stringify([database, name]);
const tableFromKey = (key: string): TableRef => {
  const [database, name] = JSON.parse(key) as [string, string];
  return { database, name };
};

function asApiError(error: unknown) {
  return error instanceof ApiError ? error : new ApiError(String(error), 0);
}

interface InsertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Inserts a data file (CSV, TSV, JSON, Parquet) into an existing table */
export function InsertDialog({ open, onOpenChange }: InsertDialogProps) {
  const [tables, setTables] = useState<TablesState>({ status: 'loading' });
  const [tablesAttempt, setTablesAttempt] = useState(0);
  const [table, setTable] = useState<string>();
  const [file, setFile] = useState<File>();
  const [format, setFormat] = useState<InsertFormat>();
  const [upload, setUpload] = useState<UploadState>({ status: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadController = useRef<AbortController | undefined>(undefined);

  // Every time it opens (or Retry is pressed), so a table created in the meantime shows up
  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    setTables({ status: 'loading' });
    listTables(controller.signal).then(
      (list) => setTables({ status: 'ready', tables: list }),
      (error: unknown) => {
        if (!isAbort(error)) {
          setTables({ status: 'failed', error: asApiError(error) });
        }
      }
    );
    return () => controller.abort();
  }, [open, tablesAttempt]);

  const resetFile = () => {
    setFile(undefined);
    setFormat(undefined);
    setUpload({ status: 'idle' });
  };

  // Closing mid-upload cancels it; the server then stops the insert in ClickHouse
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      uploadController.current?.abort();
      resetFile();
    }
    onOpenChange(next);
  };

  const chooseFile = (chosen: File | undefined) => {
    if (!chosen) {
      return;
    }
    setFile(chosen);
    setFormat(formatForFile(chosen.name));
    setUpload({ status: 'idle' });
  };

  const tooLarge = file !== undefined && file.size > MAX_INSERT_BYTES;
  const canInsert = table !== undefined && file !== undefined && format !== undefined && !tooLarge;

  const insert = async () => {
    if (!canInsert) {
      return;
    }
    const target = tableFromKey(table);
    const controller = new AbortController();
    uploadController.current = controller;
    setUpload({ status: 'uploading' });
    try {
      const result = await insertFile(
        file,
        { database: target.database, table: target.name, format },
        controller.signal
      );
      setUpload({ status: 'done', result, table: target });
    } catch (error) {
      if (!isAbort(error)) {
        setUpload({ status: 'failed', error: asApiError(error) });
      }
    }
  };

  const uploading = upload.status === 'uploading';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content title="Insert a file into a table" showClose>
        <div className="insert-dialog">
          <TablePicker
            tables={tables}
            value={table}
            onChange={setTable}
            onRetry={() => setTablesAttempt((attempt) => attempt + 1)}
            disabled={uploading}
          />

          <div className="insert-dialog__file">
            {/* A plain file input: click-ui's FileUpload assumes the upload starts when the file is picked */}
            <input
              ref={fileInput}
              className="insert-dialog__file-input"
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              aria-label="File to insert"
              onChange={(event) => {
                chooseFile(event.target.files?.[0]);
                // So picking the same file again (e.g. after fixing it) still counts as a change
                event.target.value = '';
              }}
            />
            <Button
              label={file ? 'Choose another file' : 'Choose file'}
              iconLeft="upload"
              type="secondary"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            />
            {file ? (
              <Text size="sm">
                {file.name} <span className="insert-dialog__muted">{formatBytes(file.size)}</span>
              </Text>
            ) : (
              <Text size="sm" color="muted">
                CSV, TSV, JSON or Parquet, up to {formatBytes(MAX_INSERT_BYTES)}
              </Text>
            )}
          </div>
          {tooLarge && (
            <Text size="sm" color="danger">
              This file is {formatBytes(file.size)}; the most this app inserts from the browser is{' '}
              {formatBytes(MAX_INSERT_BYTES)}.
            </Text>
          )}

          {file && (
            <Select
              label="Format"
              value={format}
              placeholder="Choose the file's format"
              onSelect={(value) => setFormat(value as InsertFormat)}
              options={INSERT_FORMATS.map((value) => ({ value, label: FORMAT_LABELS[value] }))}
              disabled={uploading}
            />
          )}

          <UploadOutcome upload={upload} fileName={file?.name} />

          <div className="insert-dialog__actions">
            {upload.status === 'done' ? (
              <Button label="Insert another file" type="secondary" onClick={resetFile} />
            ) : (
              <Button
                label="Insert"
                loading={uploading}
                disabled={!canInsert || uploading}
                onClick={() => void insert()}
              />
            )}
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

function TablePicker({
  tables,
  value,
  onChange,
  onRetry,
  disabled
}: {
  tables: TablesState;
  value: string | undefined;
  onChange: (key: string) => void;
  onRetry: () => void;
  disabled: boolean;
}) {
  switch (tables.status) {
    case 'loading':
      return <Text color="muted">Loading tables…</Text>;
    case 'failed':
      return (
        <Alert
          state="danger"
          title="Couldn't load the tables"
          text={
            <>
              {errorSummary(tables.error.message)}{' '}
              <button type="button" className="insert-dialog__link" onClick={onRetry}>
                Try again
              </button>
            </>
          }
        />
      );
    case 'ready':
      return tables.tables.length === 0 ? (
        <Text color="muted">
          There are no tables your ClickHouse user can insert into. Create one first, e.g.{' '}
          <code>CREATE TABLE events (time DateTime, status UInt16) ENGINE = MergeTree ORDER BY time</code>
        </Text>
      ) : (
        <Select
          label="Table"
          value={value}
          placeholder="Choose a table"
          onSelect={onChange}
          options={tables.tables.map((table) => ({ value: tableKey(table), label: `${table.database}.${table.name}` }))}
          disabled={disabled}
        />
      );
  }
}

function UploadOutcome({ upload, fileName }: { upload: UploadState; fileName: string | undefined }) {
  switch (upload.status) {
    case 'idle':
      return null;
    case 'uploading':
      return <Text color="muted">Uploading {fileName}… Closing this cancels the insert.</Text>;
    case 'done': {
      const { rows, elapsedMs } = upload.result;
      return (
        <Alert
          state="success"
          title={`Inserted ${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}`}
          text={`Into ${upload.table.database}.${upload.table.name} in ${formatDuration(elapsedMs)}.`}
        />
      );
    }
    case 'failed': {
      const { message, status } = upload.error;
      const row = failedRow(message);
      return (
        <Alert
          state="danger"
          title={
            status === 0
              ? "Can't reach the server"
              : row
                ? `The file couldn't be read at row ${row.toLocaleString()}`
                : 'Insert failed'
          }
          text={
            <>
              <span className="results__error-summary">{errorSummary(message)}</span>
              {mayHaveInsertedRows(message) && (
                <span className="results__error-summary">
                  Rows before it may already be in the table: ClickHouse writes large inserts in blocks of about a
                  million rows.
                </span>
              )}
              {errorSummary(message) !== message.trim() && (
                <details className="results__error-details">
                  <summary>Full error</summary>
                  <pre>{message}</pre>
                </details>
              )}
            </>
          }
        />
      );
    }
  }
}
