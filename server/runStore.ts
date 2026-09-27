import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ClickHouseRequestOptions } from './clickhouseRequestOptions';
import { PreparedRun } from './runner';

/** Most runs kept at once. When full, the oldest finished run makes room; running runs are never dropped */
export const MAX_RUNS = 50;
/** Most runs one owner can have in progress, so one login can't fill every slot and lock everyone else out */
const MAX_RUNNING_PER_OWNER = 5;
/** How long a finished run stays available, e.g. for a page reloaded after it finished */
const RETENTION_MS = 15 * 60 * 1000;

export interface StoredRun {
  /** Per statement: SQL, position and classification, never tokens (they take ~26x the text's size in memory) */
  prepared: PreparedRun;
  /** Aborted to cancel the run */
  controller: AbortController;
  /** Fingerprint of the credentials that started the run (see ownerOf) */
  owner: string;
  /** When the run finished, by the store's clock */
  finishedAt?: number;
}

/** The stored run, or why there's no room for it */
export type AddResult = { ok: true; stored: StoredRun } | { ok: false; reason: 'ownerBusy' | 'full' };

// Per process: fingerprints mean nothing outside this server, and aren't reversible to passwords
const SALT = randomBytes(16);

/**
 * Who a run belongs to: a salted hash of the ClickHouse login that started it. Results were fetched with that
 * login's grants, so only the same credentials may read or cancel the run; a leaked run id isn't enough. The
 * server never checks passwords itself (ClickHouse does), so this compares credentials, not just the username.
 */
export function ownerOf({ auth }: ClickHouseRequestOptions): string {
  // Without credentials, queries run as the client's default login: user default, empty password
  const username = auth?.username ?? 'default';
  const password = auth?.password ?? '';
  // update('\0') adds a separator between username/password in hashed input
  // without it, different logins could hash the same, because the two parts would just run together
  // and '\0' can't occur in either since Node rejects header values containing NUL (\0)
  return createHash('sha256').update(SALT).update(username).update('\0').update(password).digest('hex');
}

/**
 * Runs in memory, in this server process: lost on restart and invisible to other instances. A deployment with
 * several servers would keep runs in a shared store with expiry, such as Redis (see docs).
 */
export class RunStore {
  private readonly runs = new Map<string, StoredRun>();
  private readonly maxRuns: number;
  /** Public so the API can state the limit in its error */
  readonly maxRunningPerOwner: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(
    options: { maxRuns?: number; maxRunningPerOwner?: number; retentionMs?: number; now?: () => number } = {}
  ) {
    this.maxRuns = options.maxRuns ?? MAX_RUNS;
    this.maxRunningPerOwner = options.maxRunningPerOwner ?? MAX_RUNNING_PER_OWNER;
    this.retentionMs = options.retentionMs ?? RETENTION_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Adds a run. Refused when its owner already has maxRunningPerOwner runs in progress ('ownerBusy'), or when every
   * slot holds a run that's still running ('full'). Checked in that order, so a refused run never evicts anything.
   */
  add(prepared: PreparedRun, owner: string): AddResult {
    if (this.runningCount(owner) >= this.maxRunningPerOwner) {
      return { ok: false, reason: 'ownerBusy' };
    }

    this.dropExpired();

    while (this.runs.size >= this.maxRuns) {
      const oldest = this.oldestFinished();
      if (!oldest) {
        return { ok: false, reason: 'full' };
      }
      this.runs.delete(oldest);
    }

    const stored: StoredRun = { prepared, controller: new AbortController(), owner };
    this.runs.set(prepared.run.id, stored);

    return { ok: true, stored };
  }

  /** The run, if it exists, hasn't expired and belongs to `owner` */
  get(id: string, owner: string): StoredRun | undefined {
    this.dropExpired();
    const stored = this.runs.get(id);
    return stored && sameOwner(stored.owner, owner) ? stored : undefined;
  }

  markFinished(id: string) {
    const stored = this.runs.get(id);
    if (stored) {
      stored.finishedAt = this.now();
    }
  }

  // At most a safe MAX_RUNS runs, so counting on each add is cheap
  private runningCount(owner: string) {
    let count = 0;
    for (const stored of this.runs.values()) {
      if (stored.finishedAt === undefined && sameOwner(stored.owner, owner)) {
        count++;
      }
    }
    return count;
  }

  private dropExpired() {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, stored] of this.runs) {
      if (stored.finishedAt !== undefined && stored.finishedAt < cutoff) {
        this.runs.delete(id);
      }
    }
  }

  private oldestFinished(): string | undefined {
    let oldest: [string, number] | undefined;
    for (const [id, { finishedAt }] of this.runs) {
      if (finishedAt !== undefined && (!oldest || finishedAt < oldest[1])) {
        oldest = [id, finishedAt];
      }
    }
    return oldest?.[0];
  }
}

// Constant-time comparison, so response timing reveals nothing about a fingerprint
function sameOwner(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
