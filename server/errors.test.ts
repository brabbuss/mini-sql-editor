import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouseError } from '@clickhouse/client';
import { logHttpError, RequestError, toHttpError } from './errors';
import { LogFields, Logger } from './logger';

function networkError(code: string) {
  return Object.assign(new Error(''), { code });
}

describe('toHttpError', () => {
  it('maps our own request validation errors to their status as a client fault', () => {
    assert.deepEqual(toHttpError(new RequestError(400, "'query' is required")), {
      status: 400,
      fault: 'client',
      body: { error: "'query' is required" }
    });
  });

  it('includes extra details from our own request errors in the body', () => {
    assert.deepEqual(toHttpError(new RequestError(400, 'Unterminated string', { position: 7 })).body, {
      error: 'Unterminated string',
      position: 7
    });
  });

  it("maps body-parser's client errors to their status", () => {
    // Shaped like http-errors, which body-parser uses for an oversized body
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, expose: true });

    assert.deepEqual(toHttpError(tooLarge), {
      status: 413,
      fault: 'client',
      body: { error: 'request entity too large' }
    });
  });

  it("doesn't expose errors that aren't marked safe to show", () => {
    const internal = Object.assign(new Error('secret detail'), { status: 500, expose: false });

    assert.deepEqual(toHttpError(internal).body, { error: 'Internal server error' });
  });

  it('maps a ClickHouse error to 400 with its message, code and type', () => {
    const error = new ClickHouseError({ message: 'Syntax error', code: '62', type: 'SYNTAX_ERROR' });

    assert.deepEqual(toHttpError(error), {
      status: 400,
      fault: 'client',
      body: { error: 'Syntax error', code: '62', type: 'SYNTAX_ERROR' }
    });
  });

  it('maps failed authentication to 401', () => {
    const error = new ClickHouseError({ message: 'Authentication failed', code: '516', type: 'AUTHENTICATION_FAILED' });

    assert.equal(toHttpError(error).status, 401);
    assert.equal(toHttpError(error).fault, 'client');
  });

  it('maps missing privileges to 403', () => {
    const error = new ClickHouseError({ message: 'Not enough privileges', code: '497', type: 'ACCESS_DENIED' });

    assert.equal(toHttpError(error).status, 403);
    assert.equal(toHttpError(error).fault, 'client');
  });

  it('omits the type when ClickHouse gives none', () => {
    const error = new ClickHouseError({ message: 'Something failed', code: '1' });

    assert.deepEqual(toHttpError(error).body, { error: 'Something failed', code: '1' });
  });

  it('maps an unreachable ClickHouse to 502 with a readable message', () => {
    // A refused connection to localhost arrives with an empty message (IPv4 and IPv6 attempts combined)
    assert.deepEqual(toHttpError(networkError('ECONNREFUSED')), {
      status: 502,
      fault: 'upstream',
      body: { error: 'ClickHouse is unreachable' }
    });
    assert.equal(toHttpError(networkError('ENOTFOUND')).status, 502);
  });

  it("maps the client's request timeout to 504", () => {
    assert.deepEqual(toHttpError(new Error('Timeout error.')), {
      status: 504,
      fault: 'upstream',
      body: { error: 'ClickHouse did not respond in time' }
    });
  });

  it('maps a connection attempt that timed out to 504', () => {
    assert.equal(toHttpError(networkError('ETIMEDOUT')).status, 504);
    assert.equal(toHttpError(networkError('ETIMEDOUT')).fault, 'upstream');
  });

  it('maps anything else to 500 without exposing its message', () => {
    assert.deepEqual(toHttpError(new TypeError('x is undefined')), {
      status: 500,
      fault: 'server',
      body: { error: 'Internal server error' }
    });
    assert.equal(toHttpError('a thrown string').status, 500);
  });
});

describe('logHttpError', () => {
  function recordingLogger() {
    const entries: { level: string; message: string; fields?: LogFields }[] = [];
    const logger: Logger = {
      info: (message, fields) => entries.push({ level: 'info', message, fields }),
      warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
      error: (message, fields) => entries.push({ level: 'error', message, fields })
    };
    return { logger, entries };
  }
  const context = { method: 'POST', path: '/api/runs' };

  it('logs caller mistakes at info with their fault', () => {
    const { logger, entries } = recordingLogger();
    const error = new ClickHouseError({ message: 'Syntax error', code: '62', type: 'SYNTAX_ERROR' });

    logHttpError(logger, error, toHttpError(error), context);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, 'info');
    assert.deepEqual(entries[0].fields, {
      method: 'POST',
      path: '/api/runs',
      status: 400,
      fault: 'client',
      code: '62',
      type: 'SYNTAX_ERROR',
      message: 'Syntax error'
    });
  });

  it('logs server faults at error with the stack', () => {
    const { logger, entries } = recordingLogger();
    const error = new TypeError('x is undefined');

    logHttpError(logger, error, toHttpError(error), context);

    assert.equal(entries[0].level, 'error');
    assert.equal(entries[0].fields?.fault, 'server');
    assert.equal(entries[0].fields?.message, 'x is undefined');
    assert.match(String(entries[0].fields?.stack), /TypeError: x is undefined/);
  });

  it('logs an unreachable ClickHouse at error as an upstream fault', () => {
    const { logger, entries } = recordingLogger();
    const error = networkError('ECONNREFUSED');

    logHttpError(logger, error, toHttpError(error), context);

    assert.equal(entries[0].level, 'error');
    assert.equal(entries[0].fields?.fault, 'upstream');
    assert.equal(entries[0].fields?.status, 502);
    assert.equal(entries[0].fields?.code, 'ECONNREFUSED');
  });
});
