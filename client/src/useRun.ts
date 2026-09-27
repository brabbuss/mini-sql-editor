import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Run, StatementRef } from '../../shared/api';
import { ApiError, cancelRun, getRun, isAbort, startRun } from './api';
import { nextPollDelay } from './results/results';
import { readStored, removeStored, writeStored } from './storage';

/** The run on screen survives a reload: its id and offset, so the page can pick it up again */
const RUN_KEY = 'sql-editor.run';

// `offset` (below): where the run's text starts in the editor, i.e. 0, or the start of the selection that was run.
// Positions in a run (statements, errors) count from the start of what was run, so the editor adds this to them

export type RunView =
  | { phase: 'idle' }
  | { phase: 'starting'; script: string; offset: number }
  /** The server found destructive statements; nothing has run */
  | { phase: 'confirming'; script: string; offset: number; destructive: StatementRef[] }
  /**
   * The run couldn't start (e.g. an unterminated string, too many runs), or was lost (the server restarted). `script`
   * is what was sent, if anything was: picking up a run after a reload sends none
   */
  | { phase: 'failed'; script?: string; offset: number; error: ApiError }
  | {
      phase: 'following';
      run: Run;
      offset: number;
      /** When the run started, by this browser's clock, for the elapsed-time display */
      startedAtMs: number;
      cancelling: boolean;
      /** The last poll or cancel request failed; polling carries on, so this clears once the server answers */
      connectionError?: ApiError;
    };

function asApiError(error: unknown) {
  return error instanceof ApiError ? error : new ApiError(String(error), 0);
}

function storedRun(): { id: string; offset: number } | undefined {
  const stored = readStored(RUN_KEY);
  if (typeof stored === 'object' && stored !== null) {
    const { id, offset } = stored as Record<string, unknown>;
    if (typeof id === 'string' && typeof offset === 'number') {
      return { id, offset };
    }
  }
  return undefined;
}

/**
 * Starts scripts as runs on the server and follows them until they finish: polls their progress, cancels them, asks
 * for confirmation before destructive statements, and picks the last run back up after a reload.
 */
export function useRun() {
  const [view, setView] = useState<RunView>({ phase: 'idle' });
  // The committed view, for callbacks that must not change identity (the editor's keymap) and to ignore Run while a
  // run is going. Updated after each commit: writing a ref during render isn't safe in React
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  }, [view]);
  // The last ETag of the run being followed, so unchanged polls get a bodiless 304
  const etagRef = useRef<string | undefined>(undefined);

  const follow = useCallback((run: Run, offset: number, startedAtMs: number, etag?: string) => {
    etagRef.current = etag;
    setView({ phase: 'following', run, offset, startedAtMs, cancelling: false });
  }, []);

  // After a reload: show the last run again, still running or finished, until the server forgets it (15 minutes)
  useEffect(() => {
    const stored = storedRun();
    if (!stored) {
      return;
    }
    const controller = new AbortController();
    getRun(stored.id, { signal: controller.signal })
      .then((result) => {
        // Unless the user has already started something else
        if (result && viewRef.current.phase === 'idle') {
          follow(result.run, stored.offset, Date.parse(result.run.startedAt), result.etag);
        }
      })
      .catch((error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        // Expired, or started with other credentials: nothing to show, and nothing wrong
        if (error instanceof ApiError && error.status === 404) {
          removeStored(RUN_KEY);
        } else if (viewRef.current.phase === 'idle') {
          setView({ phase: 'failed', offset: stored.offset, error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [follow]);

  const start = useCallback(
    async (script: string, offset: number, confirmDestructive: boolean) => {
      setView({ phase: 'starting', script, offset });
      try {
        const result = await startRun(script, { confirmDestructive });
        if (!result.started) {
          setView({ phase: 'confirming', script, offset, destructive: result.destructive });
          return;
        }
        writeStored(RUN_KEY, { id: result.run.id, offset });
        follow(result.run, offset, Date.now());
      } catch (error) {
        setView({ phase: 'failed', script, offset, error: asApiError(error) });
      }
    },
    [follow]
  );

  /**
   * Runs a script (the editor's text, or the selected part of it, starting at `offset`), unless a run is already
   * starting or running (the user cancels that first)
   */
  const run = useCallback(
    (script: string, offset = 0) => {
      const current = viewRef.current;
      const busy = current.phase === 'starting' || (current.phase === 'following' && current.run.status === 'running');
      if (!busy && script.trim() !== '') {
        void start(script, offset, false);
      }
    },
    [start]
  );

  /** Runs the script waiting for confirmation, destructive statements included */
  const confirm = useCallback(() => {
    const current = viewRef.current;
    if (current.phase === 'confirming') {
      void start(current.script, current.offset, true);
    }
  }, [start]);

  // click-ui's dialog also calls this after Confirm (its confirm button closes the dialog), so it only applies while
  // still confirming; the updater form sees the 'starting' that confirm() has just set
  const dismiss = useCallback(() => {
    setView((current) => (current.phase === 'confirming' ? { phase: 'idle' } : current));
  }, []);

  const cancel = useCallback(async () => {
    const current = viewRef.current;
    if (current.phase !== 'following' || current.run.status !== 'running') {
      return;
    }
    const { id } = current.run;
    const update = (changes: Partial<Extract<RunView, { phase: 'following' }>>) =>
      setView((v) => (v.phase === 'following' && v.run.id === id ? { ...v, ...changes } : v));
    update({ cancelling: true });
    try {
      // The poll picks up the outcome: cancelled, or a notice when the statement couldn't be stopped
      await cancelRun(id);
    } catch (error) {
      update({ cancelling: false, connectionError: asApiError(error) });
    }
  }, []);

  // Poll the run while it's running. Keyed on the id and running-ness, so each update doesn't restart the loop
  const followedId = view.phase === 'following' ? view.run.id : undefined;
  const running = view.phase === 'following' && view.run.status === 'running';
  useEffect(() => {
    if (!followedId || !running) {
      return;
    }
    const controller = new AbortController();
    const pollingSince = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (changes: Partial<Extract<RunView, { phase: 'following' }>>) =>
      setView((v) => (v.phase === 'following' && v.run.id === followedId ? { ...v, ...changes } : v));

    const poll = async () => {
      try {
        const result = await getRun(followedId, { etag: etagRef.current, signal: controller.signal });
        if (result) {
          etagRef.current = result.etag;
          update({ run: result.run, connectionError: undefined });
          if (result.run.status !== 'running') {
            return;
          }
        } else {
          // 304: nothing new. Only a pending connection warning needs clearing; otherwise the state stays the same
          // object, so an unchanged poll doesn't even re-render
          setView((v) =>
            v.phase === 'following' && v.run.id === followedId && v.connectionError
              ? { ...v, connectionError: undefined }
              : v
          );
        }
      } catch (error) {
        if (isAbort(error)) {
          return;
        }
        // The server restarted (runs live in its memory) or the run expired: it can't be followed any further
        if (error instanceof ApiError && error.status === 404) {
          removeStored(RUN_KEY);
          setView((v) =>
            v.phase === 'following' && v.run.id === followedId
              ? {
                  phase: 'failed',
                  offset: v.offset,
                  error: new ApiError('The server no longer has this run: it restarted, or the run expired.', 404)
                }
              : v
          );
          return;
        }
        // Anything else may be passing (e.g. the network): say so, and keep trying
        update({ connectionError: asApiError(error) });
      }
      timer = setTimeout(poll, nextPollDelay(Date.now() - pollingSince));
    };

    timer = setTimeout(poll, nextPollDelay(0));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [followedId, running]);

  return { view, run, confirm, dismiss, cancel };
}
