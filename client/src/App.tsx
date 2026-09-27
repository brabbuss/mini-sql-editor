import { useEffect, useState } from 'react';
import { Button, ClickUIProvider, ConfirmationDialog, Text, Title } from '@clickhouse/click-ui';
import { RunStatus } from '../../shared/api';
import { ResultsPanel } from './results/ResultsPanel';
import { formatDuration, statementLabel } from './results/results';
import { SqlEditor } from './editor/SqlEditor';
import { InsertDialog } from './insert/InsertDialog';
import { useDraft } from './editor/useDraft';
import { statementBody, statementDisplayText, syntaxErrorToken, TextRange } from './statementText';
import { RunView, useRun } from './useRun';

const INITIAL_SQL = 'SELECT number, number * number AS squared\nFROM numbers(10)';
const OUTCOMES: Record<RunStatus, string> = {
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled'
};
const RUN_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl Enter';

export function App() {
  const [sqlText, setSqlText] = useDraft(INITIAL_SQL);
  const { view, run, confirm, dismiss, cancel } = useRun();
  const [inserting, setInserting] = useState(false);
  // The selected range in the editor, if any: Run then runs only that
  const [selection, setSelection] = useState<TextRange>();
  const running = view.phase === 'following' && view.run.status === 'running';
  const target = selection
    ? { text: sqlText.slice(selection.from, selection.to), offset: selection.from }
    : { text: sqlText, offset: 0 };

  return (
    <ClickUIProvider theme="light">
      <div className="app">
        <Title type="h1">SQL Editor</Title>
        <SqlEditor
          value={sqlText}
          onChange={setSqlText}
          onRun={run}
          onSelectionChange={setSelection}
          {...errorMarks(view, sqlText)}
        />
        <div className="app__toolbar">
          {running ? (
            <Button
              label="Cancel"
              iconLeft="stop"
              type="secondary"
              loading={view.cancelling}
              onClick={() => void cancel()}
            />
          ) : (
            <Button
              label={selection ? 'Run selection' : 'Run'}
              iconLeft="play"
              loading={view.phase === 'starting'}
              disabled={target.text.trim() === ''}
              onClick={() => run(target.text, target.offset)}
            />
          )}
          <Text color="muted" size="sm">
            {RUN_SHORTCUT}
          </Text>
          <RunSummary view={view} />
          <div className="app__toolbar-end">
            <Button label="Insert file" iconLeft="upload" type="secondary" onClick={() => setInserting(true)} />
          </div>
        </div>
        <InsertDialog open={inserting} onOpenChange={setInserting} />
        <div className="app__results">
          <ResultsPanel view={view} shortcut={RUN_SHORTCUT} />
        </div>
        <ConfirmationDialog
          open={view.phase === 'confirming'}
          title="Run destructive statements?"
          primaryActionLabel="Run anyway"
          primaryActionType="danger"
          onConfirm={confirm}
          onCancel={dismiss}
        >
          {view.phase === 'confirming' && (
            <div className="confirm-destructive">
              <Text>These statements delete or overwrite data. Nothing has run yet.</Text>
              <ul>
                {view.destructive.map((statement) => (
                  <li key={statement.index}>
                    <code>{statementDisplayText(statement.sql)}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ConfirmationDialog>
      </div>
    </ClickUIProvider>
  );
}

/**
 * What to mark in the editor: the statement that failed (without the comments around it) and, when ClickHouse says
 * where, the exact token; or where a script couldn't be split. Positions count from the start of what was run, which
 * is `view.offset` into the editor (a selection may have been run), and apply only while the editor still holds that
 * text there.
 */
function errorMarks(view: RunView, text: string): { errorStatement?: TextRange; errorToken?: TextRange } {
  if (view.phase === 'failed' && view.script !== undefined && view.error.position !== undefined) {
    const { script, offset } = view;
    if (text.slice(offset, offset + script.length) !== script) {
      return {};
    }
    // From where the unterminated string, comment or heredoc starts, to the end of that line
    const from = offset + view.error.position;
    const lineEnd = text.indexOf('\n', from);
    return { errorToken: { from, to: lineEnd === -1 ? text.length : lineEnd } };
  }
  if (view.phase === 'following') {
    // A statement's sql is exactly the run's text between its offsets, so this also works for a run picked up after a
    // reload, and stops as soon as that statement is edited
    const failed = view.run.statements.find((s) => s.status === 'error');
    const start = failed && view.offset + failed.start;
    if (!failed || start === undefined || text.slice(start, view.offset + failed.end) !== failed.sql) {
      return {};
    }
    const shift = ({ from, to }: TextRange) => ({ from: start + from, to: start + to });
    const token = failed.error && syntaxErrorToken(failed.sql, failed.error.error);
    return { errorStatement: shift(statementBody(failed.sql)), errorToken: token && shift(token) };
  }
  return {};
}

/** One line about the whole run: how long it has been going, or how it ended */
function RunSummary({ view }: { view: RunView }) {
  const running = view.phase === 'following' && view.run.status === 'running';
  const now = useNow(running);
  if (view.phase !== 'following') {
    return null;
  }
  const { run } = view;
  if (running) {
    const current = run.statements.find((s) => s.status === 'running');
    const progress =
      run.statements.length > 1 && current
        ? ` · ${statementLabel(current)} (${current.index + 1} of ${run.statements.length})`
        : '';
    return (
      <Text color="muted" size="sm">
        Running for {formatDuration(now - view.startedAtMs)}
        {progress}
      </Text>
    );
  }
  // Both timestamps are the server's, so the duration doesn't depend on this browser's clock
  const took = run.finishedAt ? ` in ${formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))}` : '';
  return (
    <Text color={run.status === 'failed' ? 'danger' : 'muted'} size="sm">
      {OUTCOMES[run.status]}
      {took}
    </Text>
  );
}

/** The current time, updated a few times a second while `active` */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
