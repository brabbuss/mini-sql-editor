import { memo, useMemo, useState } from 'react';
import { Alert, ButtonGroup, Icon, IconName, Tabs, Text } from '@clickhouse/click-ui';
import { ROW_CAP, Run, StatementError, StatementResult, StatementStatus } from '../../../shared/api';
import { ApiError } from '../api';
import { statementDisplayText } from '../statementText';
import { suggestChart } from './chart';
import { ChartState, initialChartState, ResultsChart } from './ResultsChart';
import { ResultsGrid } from './ResultsGrid';
import { defaultStatementIndex, errorSummary, formatDuration, statementLabel } from './results';
import { RunView } from '../useRun';

interface ResultsPanelProps {
  view: RunView;
  /** The Run shortcut, for the idle hint */
  shortcut: string;
}

/**
 * Memoized: every keystroke re-renders App, but not this, unless the run changed. Measured in Chrome with a
 * 50-statement script and 10,000 rows on screen: about half the main-thread work per keystroke (9 ms → 5 ms)
 */
export const ResultsPanel = memo(function ResultsPanel({ view, shortcut }: ResultsPanelProps) {
  switch (view.phase) {
    case 'idle':
      return <Text color="muted">Write a query or a script and press Run ({shortcut}) to see its results here.</Text>;
    case 'starting':
      return <Text color="muted">Starting…</Text>;
    case 'confirming':
      return <Text color="muted">Waiting for you to confirm the destructive statements.</Text>;
    case 'failed':
      return <ErrorAlert title={startErrorTitle(view.error)} message={view.error.message} />;
    case 'following':
      return (
        <div className="results">
          {view.connectionError && (
            <Alert
              state="warning"
              title="Lost contact with the server"
              text={`${view.connectionError.message} Still trying; the run carries on on the server.`}
            />
          )}
          {view.run.notice && <Alert state="warning" title="Notice" text={view.run.notice} />}
          <RunResults run={view.run} />
        </div>
      );
  }
});

/** How a statement's result is shown, as the user left it */
interface OutputState {
  view: 'table' | 'chart';
  /** Once the chart has been shown */
  chart?: ChartState;
}

interface OutputProps {
  /** Undefined until the user changes something: a table, and the suggested chart */
  output: OutputState | undefined;
  onOutputChange: (output: OutputState) => void;
}

/** One statement: its result directly. Several: a tab each, showing the one that matters most until the user picks */
function RunResults({ run }: { run: Run }) {
  // The user's pick applies to the run it was made in; a new run starts again from the default
  const [picked, setPicked] = useState<{ runId: string; index: number }>();
  // How each result is shown. Kept here rather than in the result, which is only rendered while its tab is open:
  // switching tabs and back would otherwise reset it to the table. Per run, like the pick
  const [shown, setShown] = useState<{ runId: string; outputs: Record<number, OutputState> }>();
  const outputs = shown?.runId === run.id ? shown.outputs : {};
  const setOutput = (index: number, output: OutputState) =>
    setShown((previous) => ({
      runId: run.id,
      outputs: { ...(previous?.runId === run.id ? previous.outputs : {}), [index]: output }
    }));
  const viewOf = (statement: StatementResult) => (
    <StatementView
      statement={statement}
      run={run}
      output={outputs[statement.index]}
      onOutputChange={(output) => setOutput(statement.index, output)}
    />
  );

  if (run.statements.length === 1) {
    return viewOf(run.statements[0]);
  }
  const selected = picked?.runId === run.id ? picked.index : defaultStatementIndex(run);
  return (
    <Tabs
      className="results__tabs"
      value={String(selected)}
      onValueChange={(value) => setPicked({ runId: run.id, index: Number(value) })}
      ariaLabel="Statements"
    >
      <Tabs.TriggersList>
        {run.statements.map((statement) => (
          <Tabs.Trigger
            key={statement.index}
            value={String(statement.index)}
            title={statementDisplayText(statement.sql)}
          >
            <span className="results__tab-label">
              <StatusIcon status={statement.status} />
              {statementLabel(statement)}
            </span>
          </Tabs.Trigger>
        ))}
      </Tabs.TriggersList>
      <Tabs.Content className="results__tab-content" value={String(selected)}>
        {viewOf(run.statements[selected])}
      </Tabs.Content>
    </Tabs>
  );
}

// click-ui's IconState, which its package root doesn't export
type IconState = 'success' | 'warning' | 'danger' | 'info';

const STATUS_ICONS: Record<StatementStatus, { name: IconName; state?: IconState; label: string }> = {
  pending: { name: 'clock', label: 'Waiting' },
  running: { name: 'loading-animated', state: 'info', label: 'Running' },
  ok: { name: 'check-in-circle', state: 'success', label: 'Succeeded' },
  error: { name: 'warning', state: 'danger', label: 'Failed' },
  cancelled: { name: 'stop', state: 'warning', label: 'Cancelled' },
  skipped: { name: 'dots-horizontal', label: 'Not run' }
};

function StatusIcon({ status }: { status: StatementStatus }) {
  const { name, state, label } = STATUS_ICONS[status];
  return <Icon name={name} state={state} size="sm" aria-label={label} role="img" />;
}

function StatementView({ statement, run, ...outputProps }: { statement: StatementResult; run: Run } & OutputProps) {
  const took = statement.elapsedMs === undefined ? '' : ` in ${formatDuration(statement.elapsedMs)}`;
  switch (statement.status) {
    case 'pending':
      return <Text color="muted">Waiting for the statements before it to finish.</Text>;
    case 'running':
      return <Text color="muted">Running…</Text>;
    case 'skipped':
      return (
        <Text color="muted">
          {run.status === 'cancelled' ? 'Not run: the run was cancelled.' : 'Not run: an earlier statement failed.'}
        </Text>
      );
    case 'cancelled':
      return <Text color="muted">Cancelled{took}.</Text>;
    case 'error':
      return statement.error ? (
        <ErrorAlert title={statementErrorTitle(statement.error)} message={statement.error.error} />
      ) : (
        <ErrorAlert title="Query failed" message="The statement failed without an error message." />
      );
    case 'ok':
      // Keyed, so the grid and chart start afresh for each statement (and each run)
      return (
        <StatementOutput key={`${run.id}-${statement.index}`} statement={statement} took={took} {...outputProps} />
      );
  }
}

function StatementOutput({
  statement,
  took,
  ...outputProps
}: { statement: StatementResult; took: string } & OutputProps) {
  // DDL, writes, SET, USE: nothing to show but that it worked
  if (!statement.columns) {
    return <Text color="muted">Ran successfully{took}.</Text>;
  }
  return <StatementRows statement={statement} columns={statement.columns} took={took} {...outputProps} />;
}

/** A result with columns: the row count, the truncation notice, and the rows as a table or a chart */
function StatementRows({
  statement,
  columns,
  took,
  output,
  onOutputChange
}: {
  statement: StatementResult;
  columns: NonNullable<StatementResult['columns']>;
  took: string;
} & OutputProps) {
  const view = output?.view ?? 'table';
  const rows = statement.rows ?? [];
  // Undefined when there's no numeric column: nothing to chart
  const suggested = useMemo(() => suggestChart(columns), [columns]);
  const count = `${rows.length.toLocaleString()} ${rows.length === 1 ? 'row' : 'rows'}`;
  return (
    <div className="statement-output">
      <div className="statement-output__header">
        <Text size="sm" color="muted">
          {statement.truncated ? `First ${count}` : count}
          {took}
        </Text>
        {rows.length > 0 && (
          <ButtonGroup
            aria-label="Show as"
            options={[
              { value: 'table', label: 'Table' },
              {
                value: 'chart',
                label: 'Chart',
                disabled: !suggested,
                title: suggested ? undefined : 'Nothing to chart: the result has no numeric columns'
              }
            ]}
            selected={view}
            onClick={(value) => onOutputChange({ ...output, view: value === 'chart' ? 'chart' : 'table' })}
          />
        )}
      </div>
      {statement.truncated && (
        <Alert
          state="info"
          // The default info icon is a bare "i", barely visible at this size
          customIcon="info-in-circle"
          title={`Showing the first ${ROW_CAP.toLocaleString()} rows`}
          text="The query returned more. Add a LIMIT or narrow the query to see specific rows."
        />
      )}
      {rows.length === 0 ? (
        <Text color="muted">The query ran successfully and returned no rows.</Text>
      ) : view === 'chart' && suggested ? (
        <ResultsChart
          columns={columns}
          rows={rows}
          chart={output?.chart ?? initialChartState(suggested)}
          onChange={(chart) => onOutputChange({ view: 'chart', chart })}
        />
      ) : (
        <ResultsGrid columns={columns} rows={rows} />
      )}
    </div>
  );
}

function startErrorTitle(error: ApiError) {
  switch (error.status) {
    case 0:
      return "Can't reach the server";
    case 404:
      return 'Run lost';
    case 413:
      return 'The script is too large';
    case 429:
      return 'The server is busy';
    default:
      return error.status >= 500 ? 'Something went wrong on the server' : "Can't run this script";
  }
}

function statementErrorTitle({ fault, type }: StatementError) {
  if (fault === 'upstream') {
    return 'ClickHouse is unavailable';
  }
  if (fault === 'server') {
    return 'Something went wrong on the server';
  }
  if (type === 'AUTHENTICATION_FAILED') {
    return 'Wrong ClickHouse user or password';
  }
  if (type === 'ACCESS_DENIED') {
    return 'Not allowed';
  }
  return type ? `Query failed: ${type}` : 'Query failed';
}

function ErrorAlert({ title, message }: { title: string; message: string }) {
  const summary = errorSummary(message);
  return (
    <Alert
      state="danger"
      title={title}
      text={
        <>
          <span className="results__error-summary">{summary}</span>
          {summary !== message.trim() && (
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
