import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clickhouseRequestOptions } from './clickhouseRequestOptions';

describe('clickhouseRequestOptions', () => {
  it('sets no login when there are no ClickHouse auth headers', () => {
    assert.deepEqual(clickhouseRequestOptions({ foo: 'bar' }), { http_headers: {} });
  });

  it('turns user and key headers into the login instead of forwarding them', () => {
    const options = clickhouseRequestOptions({ 'x-clickhouse-user': 'Scott', 'x-clickhouse-key': '123' });

    assert.deepEqual(options, { auth: { username: 'Scott', password: '123' }, http_headers: {} });
  });

  it('uses an empty password when only the user is given', () => {
    const options = clickhouseRequestOptions({ 'x-clickhouse-user': 'Adlai' });

    assert.deepEqual(options.auth, { username: 'Adlai', password: '' });
  });

  it('logs in as default when only the key is given', () => {
    const options = clickhouseRequestOptions({ 'x-clickhouse-key': '123' });

    assert.deepEqual(options.auth, { username: 'default', password: '123' });
  });

  it('forwards other x-clickhouse-* headers and ignores unrelated ones', () => {
    const options = clickhouseRequestOptions({
      'x-clickhouse-user': 'Lijah',
      'x-clickhouse-database': 'gold',
      'x-unrelated': 'baz'
    });

    assert.deepEqual(options, {
      auth: { username: 'Lijah', password: '' },
      http_headers: { 'x-clickhouse-database': 'gold' }
    });
  });
});
