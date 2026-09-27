import http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { RequestError } from '../errors';
import { insertFile } from '../insert';
import { Logger } from '../logger';
import { createServer } from '../server';
import { closeTestServers, startTestServer, TestApi } from '../testHelpers';

// Requires ClickHouse from docker-compose.yml (`docker compose up -d`).
const CLICKHOUSE_URL = 'http://localhost:8123';
const TABLE = 'sql_editor_insert_test';
// Throwaway user without grants, created before and dropped after these tests
const NO_GRANTS_USER = 'sql_editor_insert_test_user';
const NO_GRANTS_PASSWORD = 'test-password';
const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('POST /api/insert against ClickHouse', () => {
  const client = createClient({ url: CLICKHOUSE_URL, log: { level: ClickHouseLogLevel.OFF } });
  let api: TestApi;

  const insert = (format: string, body: string | Buffer, headers: Record<string, string> = {}) =>
    api
      .post(`/api/insert?database=default&table=${TABLE}&format=${format}`)
      .set({ 'Content-Type': 'application/octet-stream', ...headers })
      .send(body);
  const rows = async () =>
    (
      await (
        await client.query({ query: `SELECT id, name FROM default.${TABLE} ORDER BY id`, format: 'JSONCompact' })
      ).json()
    ).data;

  before(async () => {
    const { success } = await client.ping();
    assert.ok(success, `ClickHouse is not reachable at ${CLICKHOUSE_URL}. Start it with: docker compose up -d`);
    api = await startTestServer(createServer(client, silentLogger));
    await client.command({
      query: `CREATE OR REPLACE TABLE default.${TABLE} (id UInt32, name String) ENGINE = MergeTree ORDER BY id`
    });
    await client.command({ query: `DROP USER IF EXISTS ${NO_GRANTS_USER}` });
    await client.command({ query: `CREATE USER ${NO_GRANTS_USER} IDENTIFIED BY '${NO_GRANTS_PASSWORD}'` });
  });

  beforeEach(async () => {
    await client.command({ query: `TRUNCATE TABLE default.${TABLE}` });
  });

  after(async () => {
    await closeTestServers();
    await client.command({ query: `DROP TABLE IF EXISTS default.${TABLE}` });
    await client.command({ query: `DROP USER IF EXISTS ${NO_GRANTS_USER}` });
    await client.close();
  });

  describe('inserts each format', () => {
    it('CSV with a header', async () => {
      const res = await insert('CSVWithNames', 'id,name\n1,a\n2,b\n3,c\n');

      assert.equal(res.status, 200);
      assert.equal(res.body.rows, 3);
      assert.deepEqual(await rows(), [
        [1, 'a'],
        [2, 'b'],
        [3, 'c']
      ]);
    });

    it('TSV with a header', async () => {
      const res = await insert('TabSeparatedWithNames', 'id\tname\n1\ta\n2\tb\n');

      assert.equal(res.body.rows, 2);
    });

    it('JSON lines, even sent as application/json', async () => {
      const res = await insert('JSONEachRow', '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n', {
        'Content-Type': 'application/json'
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.rows, 2);
    });

    it('Parquet', async () => {
      // A real Parquet file, written by ClickHouse itself
      const result = await client.exec({
        query: 'SELECT toUInt32(number) AS id, toString(number) AS name FROM numbers(5) FORMAT Parquet'
      });
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk as Buffer);
      }

      const res = await insert('Parquet', Buffer.concat(chunks));

      assert.equal(res.status, 200);
      assert.equal(res.body.rows, 5);
    });
  });

  // ClickHouse reads the header row (input_format_with_names_use_header, on by default)
  it('matches columns by the header row, not by position', async () => {
    await insert('CSVWithNames', 'name,id\na,1\n');

    assert.deepEqual(await rows(), [[1, 'a']]);
  });

  it('reports a bad row with its row number, and inserts nothing from a small file', async () => {
    const res = await insert('CSVWithNames', 'id,name\n1,a\n2,b\nnotanumber,c\n4,d\n');

    assert.equal(res.status, 400);
    assert.match(res.body.error, /at row 3/);
    assert.deepEqual(await rows(), []);
  });

  it('reports an unknown table', async () => {
    const res = await api
      .post('/api/insert?database=default&table=sql_editor_no_such_table&format=CSVWithNames')
      .send('id\n1\n');

    assert.equal(res.status, 400);
    assert.equal(res.body.type, 'UNKNOWN_TABLE');
  });

  // Inserts run with the caller's grants, not the server's
  it('refuses a user without the INSERT privilege', async () => {
    const res = await insert('CSVWithNames', 'id,name\n1,a\n', {
      'X-ClickHouse-User': NO_GRANTS_USER,
      'X-ClickHouse-Key': NO_GRANTS_PASSWORD
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.type, 'ACCESS_DENIED');
    assert.deepEqual(await rows(), []);
  });

  it('refuses a file over the size limit, inserting nothing', async () => {
    const small = await startTestServer(createServer(client, silentLogger, { maxInsertBytes: 10 }));

    const res = await small
      .post(`/api/insert?database=default&table=${TABLE}&format=CSVWithNames`)
      .send('id,name\n1,a\n2,b\n');

    assert.equal(res.status, 413);
    assert.deepEqual(await rows(), []);
  });

  // A small upload is read in full before ClickHouse starts (it reads ahead up to max_query_size, 256 KB, to parse the
  // query), so this sends megabytes, checks the insert is really running, then cuts the upload off
  it('stops the insert in ClickHouse when an upload is abandoned halfway', async () => {
    const server = http.createServer(createServer(client, silentLogger));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const inserts = async () =>
      (
        await (
          await client.query({
            // Only inserts, so this probe (a SELECT mentioning the table) never counts itself
            query: `SELECT count() AS n FROM system.processes WHERE query_kind = 'Insert' AND position(query, '${TABLE}') > 0`,
            format: 'JSONEachRow'
          })
        ).json<{ n: string }>()
      )[0].n;
    try {
      const upload = http.request({
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        method: 'POST',
        path: `/api/insert?database=default&table=${TABLE}&format=CSVWithNames`,
        headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' }
      });
      upload.on('error', () => undefined);
      upload.write('id,name\n');
      let id = 0;
      // ~64 KB of rows every 50 ms
      const sending = setInterval(() => {
        let chunk = '';
        while (chunk.length < 65536) {
          id++;
          chunk += `${id},name-${id}\n`;
        }
        upload.write(chunk);
      }, 50);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.equal(await inserts(), '1', 'the insert should be running in ClickHouse while the upload streams');

      clearInterval(sending);
      upload.destroy();
      let stopped = false;
      for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        stopped = (await inserts()) === '0';
      }

      assert.ok(stopped, 'the insert should stop within 2 s of the upload being cut');
      assert.deepEqual(await rows(), []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // The byte counter's 413 must come back out of the real client unchanged (it rejects exec with its body stream's own
  // error): if a client upgrade ever wraps it, this fails, instead of uploads getting a 500
  it('stops a file that turns out larger than the limit while streaming, with a 413 and nothing inserted', async () => {
    // 28 bytes against a limit of 15, in chunks, as an upload that declares no size arrives
    const file = Readable.from(['id,name\n', '1,a\n', '2,b\n', '3,c\n', '4,d\n']);

    await assert.rejects(
      insertFile(
        client,
        file,
        { database: 'default', table: TABLE, format: 'CSVWithNames' },
        {
          queryId: randomUUID(),
          requestOptions: { http_headers: {} },
          signal: new AbortController().signal,
          maxBytes: 15
        }
      ),
      (error) => {
        assert.ok(error instanceof RequestError, `expected our RequestError, got ${String(error)}`);
        assert.equal(error.status, 413);
        return true;
      }
    );
    assert.deepEqual(await rows(), []);
  });

  describe('GET /api/tables', () => {
    it('lists tables a file can go into, without system tables', async () => {
      const res = await api.get('/api/tables');

      assert.equal(res.status, 200);
      assert.ok(res.body.some((t: { database: string; name: string }) => t.database === 'default' && t.name === TABLE));
      assert.ok(res.body.every((t: { database: string }) => t.database !== 'system'));
    });

    // ClickHouse only lists tables the user has some grant on
    it("hides tables the caller can't access", async () => {
      const res = await api
        .get('/api/tables')
        .set({ 'X-ClickHouse-User': NO_GRANTS_USER, 'X-ClickHouse-Key': NO_GRANTS_PASSWORD });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });
  });
});
