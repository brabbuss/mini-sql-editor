import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ClickHouseError, ExecParams } from '@clickhouse/client';
import { INSERT_FORMATS } from '../shared/api';
import { RequestError } from './errors';
import { insertFile, quoteIdentifier, TABLES_QUERY } from './insert';
import { createServer } from './server';
import { closeTestServers, fakeRunClickHouse, recordingLogger, startTestServer } from './testHelpers';

after(closeTestServers);

const alice = { 'X-ClickHouse-User': 'alice', 'X-ClickHouse-Key': 's3cret' };
const INSERT_EVENTS = 'INSERT INTO `default`.`events` FORMAT CSVWithNames';

async function setup(outcomes: Parameters<typeof fakeRunClickHouse>[0] = {}, maxInsertBytes?: number) {
  const ch = fakeRunClickHouse(outcomes);
  const log = recordingLogger();
  const api = await startTestServer(createServer(ch.client, log.logger, { maxInsertBytes }));
  return { ch, api, log };
}

describe('quoteIdentifier', () => {
  it('backquotes a name', () => {
    assert.equal(quoteIdentifier('events'), '`events`');
  });

  // Otherwise a name could end the quoting early and add SQL of its own
  it('escapes backquotes and backslashes inside the name', () => {
    assert.equal(quoteIdentifier('we`ird\\name'), '`we\\`ird\\\\name`');
  });
});

describe('POST /api/insert', () => {
  it('streams the file into INSERT … FORMAT as the caller, and answers with the rows written', async () => {
    const { api, ch } = await setup({ [INSERT_EVENTS]: { writtenRows: 2 } });
    const file = 'id,name\n1,a\n2,b\n';

    const res = await api
      .post('/api/insert?database=default&table=events&format=CSVWithNames')
      .set(alice)
      .set('Content-Type', 'application/octet-stream')
      .send(file);

    assert.equal(res.status, 200);
    assert.equal(res.body.rows, 2);
    assert.equal(typeof res.body.elapsedMs, 'number');
    const [call] = ch.calls;
    const params = call.params as ExecParams;
    assert.equal(call.method, 'exec');
    assert.equal(params.query, INSERT_EVENTS);
    assert.equal(call.body, file);
    assert.deepEqual(params.auth, { username: 'alice', password: 's3cret' });
    assert.match(String(params.clickhouse_settings?.log_comment), /"app":"sql-editor","kind":"insert"/);
  });

  it('quotes the database and table names', async () => {
    const { api, ch } = await setup();

    await api.post('/api/insert?database=my db&table=we`ird&format=JSONEachRow').send('{}');

    assert.equal((ch.calls[0].params as ExecParams).query, 'INSERT INTO `my db`.`we\\`ird` FORMAT JSONEachRow');
  });

  // body-parser's JSON parser must not read it: the body is the file, streamed to ClickHouse untouched
  it('passes a JSON lines file through intact, even when it is sent as application/json', async () => {
    const { api, ch } = await setup();
    const file = '{"id":1}\n{"id":2}\n';

    const res = await api
      .post('/api/insert?database=default&table=events&format=JSONEachRow')
      .set('Content-Type', 'application/json')
      .send(file);

    assert.equal(res.status, 200);
    assert.equal(ch.calls[0].body, file);
  });

  describe('rejects without contacting ClickHouse', () => {
    const cases: [string, string, RegExp][] = [
      ['a missing database', 'table=events&format=CSVWithNames', /'database' is required/],
      ['a missing table', 'database=default&format=CSVWithNames', /'table' is required/],
      [
        'a repeated parameter',
        'database=default&table=a&table=b&format=CSVWithNames',
        /'table' must be a single value/
      ],
      ['an unknown format', 'database=default&table=events&format=XML', new RegExp(INSERT_FORMATS.join(', '))]
    ];
    for (const [label, query, message] of cases) {
      it(label, async () => {
        const { api, ch, log } = await setup();

        const res = await api.post(`/api/insert?${query}`).send('id\n1\n');

        assert.equal(res.status, 400);
        assert.match(res.body.error, message);
        assert.equal(ch.calls.length, 0);
        assert.equal(log.entries[0].fields?.fault, 'client');
      });
    }

    it('a file declared larger than the limit, before reading it', async () => {
      const { api, ch } = await setup({}, 10);

      const res = await api
        .post('/api/insert?database=default&table=events&format=CSVWithNames')
        .send('id\n1\n2\n3\n4\n5\n');

      assert.equal(res.status, 413);
      assert.match(res.body.error, /larger than 10 bytes/);
      assert.equal(ch.calls.length, 0);
    });
  });

  it('maps ClickHouse errors like any other, e.g. missing privileges to 403', async () => {
    const denied = new ClickHouseError({ message: 'Not enough privileges', code: '497', type: 'ACCESS_DENIED' });
    const { api } = await setup({ [INSERT_EVENTS]: { error: denied } });

    const res = await api.post('/api/insert?database=default&table=events&format=CSVWithNames').send('id\n1\n');

    assert.equal(res.status, 403);
    assert.equal(res.body.type, 'ACCESS_DENIED');
  });
});

describe('insertFile', () => {
  // An upload's declared size can be missing (chunked) or wrong, so the limit is also counted as the bytes flow
  it('stops a file that turns out larger than the limit while streaming', async () => {
    const ch = fakeRunClickHouse();
    const file = Readable.from(['id\n', '1\n', '2\n', '3\n', '4\n']);

    await assert.rejects(
      insertFile(
        ch.client,
        file,
        { database: 'default', table: 'events', format: 'CSVWithNames' },
        {
          queryId: 'q-1',
          requestOptions: { http_headers: {} },
          signal: new AbortController().signal,
          maxBytes: 6
        }
      ),
      (error) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.status, 413);
        return true;
      }
    );
  });
});

describe('GET /api/tables', () => {
  it('lists the tables the caller can see, asking ClickHouse as that caller', async () => {
    const { api, ch } = await setup({ [TABLES_QUERY]: { data: [['default', 'events']] } });

    const res = await api.get('/api/tables').set(alice);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ database: 'default', name: 'events' }]);
    assert.deepEqual(ch.calls[0].params.auth, { username: 'alice', password: 's3cret' });
  });
});
