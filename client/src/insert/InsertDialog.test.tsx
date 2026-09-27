import '../testSetup';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_INSERT_BYTES, TableRef } from '../../../shared/api';
import { App } from '../App';

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  sessionStorage.clear();
});

interface SentRequest {
  url: string;
  method: string;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
}

/** Plays the server: the table list, and `insert` answering uploads. Records every request */
function serve(tables: TableRef[], insert: (request: SentRequest) => Promise<Response> | Response) {
  const sent: SentRequest[] = [];
  globalThis.fetch = async (input, init) => {
    const request = { url: String(input), method: init?.method ?? 'GET', body: init?.body, signal: init?.signal };
    sent.push(request);
    return request.url === '/api/tables' ? json(200, tables) : insert(request);
  };
  return sent;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const events: TableRef = { database: 'default', name: 'events' };

/** Opens the dialog from the toolbar and waits for the tables to load */
async function openDialog() {
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: 'Insert file' }));
  return screen.findByRole('dialog');
}

async function chooseTable(dialog: HTMLElement, label: string) {
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Table' }));
  await userEvent.click(await screen.findByText(label));
}

async function chooseFile(dialog: HTMLElement, file: File) {
  await userEvent.upload(within(dialog).getByLabelText('File to insert'), file);
}

describe('Insert a file', () => {
  it('inserts the chosen file into the chosen table, and says how many rows', async () => {
    const sent = serve([events], () => json(200, { rows: 40, elapsedMs: 12 }));
    const file = new File(['time,host\n2026-01-05 09:00:00,web-1\n'], 'events.csv');
    const dialog = await openDialog();

    await chooseTable(dialog, 'default.events');
    await chooseFile(dialog, file);
    assert.ok(within(dialog).getByText('CSV with a header row'), 'the format is guessed from the extension');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Insert' }));

    assert.ok(await within(dialog).findByText('Inserted 40 rows'));
    assert.ok(within(dialog).getByText('Into default.events in 12 ms.'));
    const upload = sent.find((request) => request.method === 'POST');
    assert.equal(upload?.url, '/api/insert?database=default&table=events&format=CSVWithNames');
    // The File itself: the browser streams it from disk
    assert.equal(upload?.body, file);
  });

  it('guesses JSON from a .ndjson file', async () => {
    serve([events], () => json(200, { rows: 1, elapsedMs: 1 }));
    const dialog = await openDialog();

    await chooseFile(dialog, new File(['{"id":1}\n'], 'events.ndjson'));

    assert.ok(within(dialog).getByText('JSON: one object per line, or an array of objects'));
  });

  it('says so when there are no tables to insert into', async () => {
    serve([], () => json(500, {}));
    const dialog = await openDialog();

    assert.ok(await within(dialog).findByText(/There are no tables your ClickHouse user can insert into/));
  });

  it('refuses a file over the size limit before uploading anything', async () => {
    const sent = serve([events], () => json(200, { rows: 1, elapsedMs: 1 }));
    const file = new File(['x'], 'huge.csv');
    Object.defineProperty(file, 'size', { value: MAX_INSERT_BYTES + 1 });
    const dialog = await openDialog();

    await chooseTable(dialog, 'default.events');
    await chooseFile(dialog, file);

    assert.ok(within(dialog).getByText(/the most this app inserts from the browser is 100 MB/));
    assert.equal((within(dialog).getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled, true);
    assert.ok(sent.every((request) => request.method === 'GET'));
  });

  it("shows ClickHouse's error with the row, and warns that earlier rows may be in the table", async () => {
    const message = "Cannot parse input: expected ',' before: 'oops,x': (at row 1500002)";
    serve([events], () => json(400, { error: message, code: '27', type: 'CANNOT_PARSE_INPUT_ASSERTION_FAILED' }));
    const dialog = await openDialog();

    await chooseTable(dialog, 'default.events');
    await chooseFile(dialog, new File(['id\n1\n'], 'big.csv'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Insert' }));

    assert.ok(await within(dialog).findByText("The file couldn't be read at row 1,500,002"));
    assert.ok(within(dialog).getByText(/Rows before it may already be in the table/));
  });

  // The server then stops the insert in ClickHouse (see server/integration/insert.test.ts)
  it('cancels the upload when the dialog is closed during it', async () => {
    let uploadSignal: AbortSignal | null | undefined;
    serve([events], (request) => {
      uploadSignal = request.signal;
      // Never answers: the upload is still going when the dialog closes
      return new Promise<Response>(() => undefined);
    });
    const dialog = await openDialog();
    await chooseTable(dialog, 'default.events');
    await chooseFile(dialog, new File(['id\n1\n'], 'events.csv'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Insert' }));
    await within(dialog).findByText(/Uploading events.csv/);

    await userEvent.keyboard('{Escape}');

    await waitFor(() => assert.equal(uploadSignal?.aborted, true));
  });
});
