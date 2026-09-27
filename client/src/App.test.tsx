import './testSetup';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { Run, StatementResult } from '../../shared/api';
import { App } from './App';

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  sessionStorage.clear();
});

interface SentRequest {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/**
 * Plays the server's part: `route` answers each request (undefined fails the test), and every request is recorded.
 * A route may also throw, as fetch does when the server can't be reached.
 */
function serve(route: (request: SentRequest, sent: SentRequest[]) => Response | undefined) {
  const sent: SentRequest[] = [];
  globalThis.fetch = async (input, init) => {
    const request: SentRequest = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    sent.push(request);
    const response = route(request, sent);
    if (!response) {
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }
    return response;
  };
  return sent;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function statement(index: number, overrides: Partial<StatementResult> = {}): StatementResult {
  return { index, sql: 'SELECT 1', start: 0, end: 8, kind: 'read', status: 'ok', elapsedMs: 5, ...overrides };
}

function runWith(statements: StatementResult[], overrides: Partial<Run> = {}): Run {
  const finished = statements.every((s) => !['pending', 'running'].includes(s.status));
  return {
    id: 'run-1',
    status: finished ? 'finished' : 'running',
    statements,
    startedAt: '2026-01-01T00:00:00.000Z',
    ...(finished && { finishedAt: '2026-01-01T00:00:00.120Z' }),
    ...overrides
  };
}

/** Replaces the editor's text through CodeMirror, as typing would */
function editorView() {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement);
  assert.ok(view, 'the editor should be mounted');
  return view;
}

function setEditorText(text: string) {
  const view = editorView();
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

/** Selects `text`, which must appear in the editor, as dragging over it would */
function selectInEditor(text: string) {
  const view = editorView();
  const from = view.state.doc.toString().indexOf(text);
  assert.ok(from !== -1, `"${text}" should be in the editor`);
  view.focus();
  view.dispatch({ selection: { anchor: from, head: from + text.length } });
}

const runButton = () => screen.getByRole('button', { name: 'Run' });

/**
 * Asserts an element isn't in the page. Not assert.equal(element, null): when that fails, Node's assert builds a text
 * diff of the jsdom element, whose printed form reaches the whole document; it never finishes, so the test hangs
 * (and inside waitFor, the first attempt often fails while React hasn't re-rendered yet)
 */
function assertGone(element: Element | null, what: string) {
  assert.ok(element === null, `expected ${what} to be gone`);
}

describe('App', () => {
  it("runs a query and shows its rows, with each column's type", async () => {
    const running = runWith([statement(0, { status: 'running' })]);
    const done = runWith([
      statement(0, {
        columns: [
          { name: 'n', type: 'UInt64' },
          { name: 's', type: 'String' }
        ],
        rows: [
          ['1', 'a'],
          ['2', 'b']
        ]
      })
    ]);
    const sent = serve(({ method, url }) =>
      method === 'POST' && url === '/api/runs'
        ? json(202, running)
        : url === '/api/runs/run-1'
          ? json(200, done)
          : undefined
    );
    render(<App />);
    setEditorText('SELECT n, s FROM t');

    await userEvent.click(runButton());

    assert.ok(await screen.findByText(/^2 rows/));
    assert.ok(screen.getByText('UInt64'));
    assert.ok(screen.getByText('Finished in 120 ms'));
    // One statement: its result directly, no tabs
    assertGone(screen.queryByRole('tablist'), 'tabs');
    assert.deepEqual(sent[0].body, { sql: 'SELECT n, s FROM t' });
  });

  it('shows each statement of a script in a tab, opens the one that failed, and marks it and its bad token', async () => {
    const script = 'CREATE TABLE t (n UInt8);\n-- typo below\nSELEC 1;\nSELECT 2';
    const failed = runWith(
      [
        statement(0, { sql: 'CREATE TABLE t (n UInt8)', start: 0, end: 24, kind: 'ddl' }),
        // A comment above a statement is part of its text (sent as written); ClickHouse's position counts from there
        statement(1, {
          sql: '-- typo below\nSELEC 1',
          start: 26,
          end: 47,
          kind: 'other',
          status: 'error',
          error: {
            error: "Syntax error: failed at position 15 ('SELEC')",
            code: '62',
            type: 'SYNTAX_ERROR',
            fault: 'client'
          }
        }),
        statement(2, { sql: 'SELECT 2', start: 49, end: 57, status: 'skipped', elapsedMs: undefined })
      ],
      { status: 'failed' }
    );
    serve(({ method }) => (method === 'POST' ? json(202, { ...failed, status: 'running' }) : json(200, failed)));
    render(<App />);
    setEditorText(script);

    await userEvent.click(runButton());

    assert.ok(await screen.findByText('Query failed: SYNTAX_ERROR'));
    const tabs = screen.getAllByRole('tab');
    assert.deepEqual(
      tabs.map((tab) => tab.textContent),
      ['1 · CREATE', '2 · SELEC', '3 · SELECT']
    );
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    // The statement without its comment, and exactly the token ClickHouse points at
    assert.equal(document.querySelector('.cm-error-statement')?.textContent, 'SELEC 1');
    assert.equal(document.querySelector('.cm-error-token')?.textContent, 'SELEC');

    await userEvent.click(tabs[2]);
    assert.ok(screen.getByText('Not run: an earlier statement failed.'));
  });

  it('asks before running destructive statements, and runs them once confirmed', async () => {
    // As the server reports it: the comment above the statement is part of its text
    const destructive = [{ index: 0, sql: '-- clean up\nDROP TABLE t', start: 0, end: 24 }];
    const done = runWith([statement(0, { sql: 'DROP TABLE t', kind: 'destructive' })]);
    const sent = serve(({ method, body }) => {
      if (method === 'POST') {
        return body?.confirmDestructive ? json(202, done) : json(409, { error: 'confirm', destructive });
      }
      return json(200, done);
    });
    render(<App />);
    setEditorText('-- clean up\nDROP TABLE t');

    await userEvent.click(runButton());
    const dialog = await screen.findByRole('dialog');
    // Listed without the comment
    assert.ok(within(dialog).getByText('DROP TABLE t'));
    assertGone(within(dialog).queryByText(/clean up/), 'the comment');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run anyway' }));

    // The dialog's confirm button also closes it, which calls the cancel handler: the run must still go ahead
    assert.ok(await screen.findByText('Ran successfully in 5 ms.'));
    assert.deepEqual(
      sent.filter((r) => r.method === 'POST').map((r) => r.body),
      [{ sql: '-- clean up\nDROP TABLE t' }, { sql: '-- clean up\nDROP TABLE t', confirmDestructive: true }]
    );
  });

  it('runs nothing when the confirmation is declined', async () => {
    const destructive = [{ index: 0, sql: 'DROP TABLE t', start: 0, end: 12 }];
    const sent = serve(() => json(409, { error: 'confirm', destructive }));
    render(<App />);
    setEditorText('DROP TABLE t');

    await userEvent.click(runButton());
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => assertGone(screen.queryByRole('dialog'), 'the dialog'));
    assert.ok(screen.getByText(/Write a query or a script/));
    assert.equal(sent.length, 1);
  });

  it('cancels a running query', async () => {
    const running = runWith([statement(0, { status: 'running', elapsedMs: undefined })]);
    const cancelled = runWith([statement(0, { status: 'cancelled', elapsedMs: 1500 })], { status: 'cancelled' });
    const sent = serve(({ method, url }, all) => {
      if (method === 'POST' && url === '/api/runs') {
        return json(202, running);
      }
      if (url === '/api/runs/run-1/cancel') {
        return json(202, running);
      }
      const cancelRequested = all.some((r) => r.url.endsWith('/cancel'));
      return json(200, cancelRequested ? cancelled : running);
    });
    render(<App />);

    await userEvent.click(runButton());
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    assert.ok(await screen.findByText('Cancelled in 1.5 s.'));
    assert.ok(sent.some((r) => r.method === 'POST' && r.url === '/api/runs/run-1/cancel'));
    // Back to Run once the run has stopped
    assert.ok(runButton());
  });

  describe('running the selected text', () => {
    // As the server answers a run of just "SELEC 2": its positions count from the start of what was run
    const failedSelection = runWith(
      [
        statement(0, {
          sql: 'SELEC 2',
          start: 0,
          end: 7,
          kind: 'other',
          status: 'error',
          error: {
            error: "Syntax error: failed at position 1 ('SELEC')",
            code: '62',
            type: 'SYNTAX_ERROR',
            fault: 'client'
          }
        })
      ],
      { status: 'failed' }
    );

    it('runs only the selection, and the button says so', async () => {
      const sent = serve(({ method }) =>
        method === 'POST' ? json(202, { ...failedSelection, status: 'running' }) : json(200, failedSelection)
      );
      render(<App />);
      setEditorText('SELECT 1;\nSELEC 2');
      selectInEditor('SELEC 2');

      await userEvent.click(await screen.findByRole('button', { name: 'Run selection' }));

      await screen.findByText('Query failed: SYNTAX_ERROR');
      assert.deepEqual(sent[0].body, { sql: 'SELEC 2' });
    });

    it('marks an error in the selection at its place in the editor', async () => {
      serve(({ method }) =>
        method === 'POST' ? json(202, { ...failedSelection, status: 'running' }) : json(200, failedSelection)
      );
      render(<App />);
      setEditorText('SELECT 1;\nSELEC 2');
      selectInEditor('SELEC 2');

      await userEvent.click(await screen.findByRole('button', { name: 'Run selection' }));

      await screen.findByText('Query failed: SYNTAX_ERROR');
      assert.equal(document.querySelector('.cm-error-statement')?.textContent, 'SELEC 2');
      assert.equal(document.querySelector('.cm-error-token')?.textContent, 'SELEC');
    });

    it('runs the selection with the keyboard shortcut too', async () => {
      const sent = serve(({ method }) =>
        method === 'POST' ? json(202, { ...failedSelection, status: 'running' }) : json(200, failedSelection)
      );
      render(<App />);
      setEditorText('SELECT 1;\nSELEC 2');
      selectInEditor('SELEC 2');

      // Mod-Enter: testSetup pins navigator.platform to "MacIntel", so CodeMirror's Mod is ⌘ (Meta), as on a Mac
      await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

      await screen.findByText('Query failed: SYNTAX_ERROR');
      assert.deepEqual(sent[0].body, { sql: 'SELEC 2' });
    });

    it('underlines where an unterminated string starts inside the selection', async () => {
      serve(() => json(400, { error: 'Unterminated string', position: 7 }));
      render(<App />);
      setEditorText("SELECT 1;\nSELECT 'oops\nFROM t");
      selectInEditor("SELECT 'oops\nFROM t");

      await userEvent.click(await screen.findByRole('button', { name: 'Run selection' }));

      assert.ok(await screen.findByText("Can't run this script"));
      assert.equal(document.querySelector('.cm-error-token')?.textContent, "'oops");
    });
  });

  it('underlines where an unterminated string starts', async () => {
    serve(() => json(400, { error: 'Unterminated string', position: 7 }));
    render(<App />);
    setEditorText("SELECT 'oops\nFROM t");

    await userEvent.click(runButton());

    assert.ok(await screen.findByText("Can't run this script"));
    assert.equal(document.querySelector('.cm-error-token')?.textContent, "'oops");
  });

  it("says ClickHouse is unavailable when a statement couldn't reach it", async () => {
    const failed = runWith(
      [statement(0, { status: 'error', error: { error: 'ClickHouse is unreachable', fault: 'upstream' } })],
      { status: 'failed' }
    );
    serve(({ method }) => (method === 'POST' ? json(202, { ...failed, status: 'running' }) : json(200, failed)));
    render(<App />);

    await userEvent.click(runButton());

    assert.ok(await screen.findByText('ClickHouse is unavailable'));
  });

  it('shows a result as a chart: numbers over time as a line, with the axes it picked', async () => {
    const done = runWith([
      statement(0, {
        columns: [
          { name: 'day', type: 'Date' },
          { name: 'hits', type: 'UInt64' }
        ],
        rows: [
          ['2024-01-01', '10'],
          ['2024-01-02', '25']
        ]
      })
    ]);
    serve(({ method }) => (method === 'POST' ? json(202, { ...done, status: 'running' }) : json(200, done)));
    render(<App />);
    await userEvent.click(runButton());
    await screen.findByText(/^2 rows/);

    await userEvent.click(screen.getByRole('button', { name: 'Chart' }));

    assert.ok(document.querySelector('.recharts-line'), 'expected a line chart');
    assert.equal(screen.getByRole('checkbox', { name: 'hits' }).getAttribute('aria-checked'), 'true');
    assert.ok(screen.getByText('day', { selector: '.results-chart__x *' }));
  });

  // jsdom can't measure the plot, so this is the count used until it's measured; Chrome checks the width-based count
  it('draws as many bars as fit, and says how many of the rows those are', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => [`k${i}`, i + 1]);
    const done = runWith([
      statement(0, {
        columns: [
          { name: 'k', type: 'String' },
          { name: 'v', type: 'UInt32' }
        ],
        rows
      })
    ]);
    serve(({ method }) => (method === 'POST' ? json(202, { ...done, status: 'running' }) : json(200, done)));
    render(<App />);
    await userEvent.click(runButton());
    await screen.findByText(/^250 rows/);

    await userEvent.click(screen.getByRole('button', { name: 'Chart' }));

    assert.ok(screen.getByText(/Showing the first 200 of 250 rows as bars \(in the query's order\): as many as fit/));
    assert.equal(document.querySelectorAll('.recharts-bar-rectangle').length, 200);
  });

  it("doesn't offer a chart when the result has no numeric columns", async () => {
    const done = runWith([statement(0, { columns: [{ name: 'name', type: 'String' }], rows: [['a']] })]);
    serve(({ method }) => (method === 'POST' ? json(202, { ...done, status: 'running' }) : json(200, done)));
    render(<App />);
    await userEvent.click(runButton());
    await screen.findByText(/^1 row/);

    const chart = screen.getByRole('button', { name: 'Chart' });
    assert.equal((chart as HTMLButtonElement).disabled, true);
    assert.match(chart.getAttribute('title') ?? '', /no numeric columns/);
  });

  // Only the open tab's result is rendered, so how each result is shown has to be kept above the tabs
  it("keeps each result's table or chart, and the chart's settings, when switching tabs and back", async () => {
    const result = {
      columns: [
        { name: 'host', type: 'String' },
        { name: 'hits', type: 'UInt32' }
      ],
      rows: [
        ['web-1', 3],
        ['web-2', 5]
      ]
    };
    const done = runWith([statement(0, result), statement(1, { ...result, sql: 'SELECT 2' })]);
    serve(({ method }) => (method === 'POST' ? json(202, { ...done, status: 'running' }) : json(200, done)));
    render(<App />);
    await userEvent.click(runButton());
    const tabs = await screen.findAllByRole('tab');
    // The second is open: the last result with rows. A category x suggests bars; switch it to a line
    await userEvent.click(screen.getByRole('button', { name: 'Chart' }));
    await userEvent.click(screen.getByRole('button', { name: 'Line' }));

    await userEvent.click(tabs[0]);
    assert.equal(document.querySelector('.recharts-surface'), null, 'the first result is still a table');
    await userEvent.click(tabs[1]);

    assert.ok(document.querySelector('.recharts-line'), 'the second result is still a line chart');
  });

  it('says so when results were cut off at the row cap', async () => {
    const done = runWith([statement(0, { columns: [{ name: 'n', type: 'UInt64' }], rows: [['0']], truncated: true })]);
    serve(({ method }) => (method === 'POST' ? json(202, { ...done, status: 'running' }) : json(200, done)));
    render(<App />);

    await userEvent.click(runButton());

    assert.ok(await screen.findByText('Showing the first 10,000 rows'));
  });

  it('says the server is busy when it has too many runs', async () => {
    serve(() => json(429, { error: 'You already have 5 runs in progress. Wait for one to finish, or cancel one' }));
    render(<App />);

    await userEvent.click(runButton());

    assert.ok(await screen.findByText('The server is busy'));
    assert.ok(screen.getByText(/You already have 5 runs in progress/));
  });

  it('keeps following a run when a poll fails, and says so until the server answers again', async () => {
    const running = runWith([statement(0, { status: 'running' })]);
    const done = runWith([statement(0, { columns: [{ name: 'n', type: 'UInt8' }], rows: [[1]] })]);
    let polls = 0;
    serve(({ method }) => {
      if (method === 'POST') {
        return json(202, running);
      }
      polls++;
      if (polls === 1) {
        throw new TypeError('fetch failed');
      }
      return json(200, polls === 2 ? running : done);
    });
    render(<App />);

    await userEvent.click(runButton());

    assert.ok(await screen.findByText('Lost contact with the server'));
    assert.ok(await screen.findByText(/^1 row/));
    assertGone(screen.queryByText('Lost contact with the server'), 'the connection warning');
  });

  it('picks the last run back up after a reload', async () => {
    sessionStorage.setItem('sql-editor.run', JSON.stringify({ id: 'run-9', offset: 0 }));
    const done = runWith([statement(0, { columns: [{ name: 'n', type: 'UInt8' }], rows: [[1]] })], { id: 'run-9' });
    const sent = serve(({ url }) => (url === '/api/runs/run-9' ? json(200, done) : undefined));

    render(<App />);

    assert.ok(await screen.findByText(/^1 row/));
    assert.ok(sent.every((r) => r.method === 'GET'));
  });

  // The run's statements carry their text and offsets, so the check needs nothing stored beyond the run's id
  it('still underlines the failed statement after a reload, until it is edited', async () => {
    const script = 'SELECT 1;\nSELEC 2';
    sessionStorage.setItem('sql-editor.draft', JSON.stringify(script));
    sessionStorage.setItem('sql-editor.run', JSON.stringify({ id: 'run-1', offset: 0 }));
    const failed = runWith(
      [
        statement(0, { sql: 'SELECT 1', start: 0, end: 8 }),
        statement(1, {
          sql: 'SELEC 2',
          start: 10,
          end: 17,
          kind: 'other',
          status: 'error',
          error: { error: 'Syntax error', type: 'SYNTAX_ERROR', fault: 'client' }
        })
      ],
      { status: 'failed' }
    );
    serve(() => json(200, failed));
    render(<App />);

    await screen.findByText('Query failed: SYNTAX_ERROR');
    assert.equal(document.querySelector('.cm-error-statement')?.textContent, 'SELEC 2');

    setEditorText('SELECT 1;\nSELECT 2');
    await waitFor(() => assertGone(document.querySelector('.cm-error-statement'), 'the highlight'));
  });

  it('forgets a stored run the server no longer has, and shows the start screen', async () => {
    sessionStorage.setItem('sql-editor.run', JSON.stringify({ id: 'expired', offset: 0 }));
    serve(() => json(404, { error: 'Run not found' }));

    render(<App />);

    await waitFor(() => assert.equal(sessionStorage.getItem('sql-editor.run'), null));
    assert.ok(screen.getByText(/Write a query or a script/));
  });
});
