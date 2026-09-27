import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements } from '../shared/splitStatements';
import { prepareRun } from './runner';
import { ownerOf, RunStore } from './runStore';

function prepared(id: string) {
  const split = splitStatements('SELECT 1');
  assert.ok(split.ok);
  return prepareRun(id, split.statements);
}

const alice = ownerOf({ auth: { username: 'alice', password: 's3cret' }, http_headers: {} });
const bob = ownerOf({ auth: { username: 'bob', password: 's3cret' }, http_headers: {} });

/** A store whose clock the test moves by hand */
function storeWithClock(options: { maxRuns?: number; maxRunningPerOwner?: number; retentionMs?: number } = {}) {
  let time = 0;
  const store = new RunStore({ ...options, now: () => time });
  return { store, advance: (ms: number) => (time += ms) };
}

describe('ownerOf', () => {
  it('gives the same credentials the same fingerprint, and different ones a different one', () => {
    const again = ownerOf({ auth: { username: 'alice', password: 's3cret' }, http_headers: {} });
    const otherPassword = ownerOf({ auth: { username: 'alice', password: 'other' }, http_headers: {} });

    assert.equal(alice, again);
    assert.notEqual(alice, otherPassword);
    assert.notEqual(alice, bob);
  });

  // "ab" + "c" and "a" + "bc" would be the same text without the separator
  it("doesn't confuse where the username ends and the password starts", () => {
    assert.notEqual(
      ownerOf({ auth: { username: 'ab', password: 'c' }, http_headers: {} }),
      ownerOf({ auth: { username: 'a', password: 'bc' }, http_headers: {} })
    );
  });

  // Without credentials, queries run as the client's default login: user default, empty password
  it('treats a request without credentials as the default user', () => {
    assert.equal(
      ownerOf({ http_headers: {} }),
      ownerOf({ auth: { username: 'default', password: '' }, http_headers: {} })
    );
  });

  it("doesn't contain the password", () => {
    assert.ok(!alice.includes('s3cret'));
  });
});

describe('RunStore', () => {
  it('returns a run to its owner, and to no one else', () => {
    const { store } = storeWithClock();
    const added = store.add(prepared('run-1'), alice);

    assert.ok(added.ok);
    assert.equal(store.get('run-1', alice), added.stored);
    assert.equal(store.get('run-1', bob), undefined);
    assert.equal(store.get('no-such-run', alice), undefined);
  });

  it('forgets a finished run after the retention period', () => {
    const { store, advance } = storeWithClock({ retentionMs: 1000 });
    store.add(prepared('run-1'), alice);
    store.markFinished('run-1');

    advance(999);
    assert.ok(store.get('run-1', alice));
    advance(2);
    assert.equal(store.get('run-1', alice), undefined);
  });

  it('never forgets a run that is still running', () => {
    const { store, advance } = storeWithClock({ retentionMs: 1000 });
    store.add(prepared('run-1'), alice);

    advance(60_000);
    assert.ok(store.get('run-1', alice));
  });

  it('makes room by dropping the oldest finished run first', () => {
    const { store, advance } = storeWithClock({ maxRuns: 2 });
    store.add(prepared('older'), alice);
    store.add(prepared('newer'), alice);
    store.markFinished('newer');
    advance(10);
    store.markFinished('older');

    store.add(prepared('third'), alice);

    // "newer" finished first, so it goes first
    assert.equal(store.get('newer', alice), undefined);
    assert.ok(store.get('older', alice));
    assert.ok(store.get('third', alice));
  });

  it('refuses a new run when every slot holds a running run', () => {
    const { store } = storeWithClock({ maxRuns: 2 });
    store.add(prepared('run-1'), alice);
    store.add(prepared('run-2'), alice);

    assert.deepEqual(store.add(prepared('run-3'), bob), { ok: false, reason: 'full' });
    assert.ok(store.get('run-1', alice));
    assert.ok(store.get('run-2', alice));
  });

  // So one login can't take every slot and lock everyone else out
  it("limits each owner's runs in progress, without affecting other owners", () => {
    const { store } = storeWithClock({ maxRunningPerOwner: 2 });
    store.add(prepared('run-1'), alice);
    store.add(prepared('run-2'), alice);

    assert.deepEqual(store.add(prepared('run-3'), alice), { ok: false, reason: 'ownerBusy' });
    assert.ok(store.add(prepared('bobs'), bob).ok);

    store.markFinished('run-1');
    assert.ok(store.add(prepared('run-4'), alice).ok);
  });

  it("doesn't drop a finished run to make room for a run it then refuses", () => {
    const { store } = storeWithClock({ maxRuns: 2, maxRunningPerOwner: 1 });
    store.add(prepared('finished'), alice);
    store.markFinished('finished');
    store.add(prepared('running'), alice);

    assert.deepEqual(store.add(prepared('refused'), alice), { ok: false, reason: 'ownerBusy' });
    assert.ok(store.get('finished', alice));
  });
});
