import { useEffect, useState } from 'react';
import { readStored, writeStored } from '../storage';

const DRAFT_KEY = 'sql-editor.draft';
// Saving a large script on every keystroke would be wasteful; saving after a pause loses at most that pause
const SAVE_DELAY_MS = 300;

/** The editor's text, kept across reloads */
export function useDraft(initial: string) {
  const [text, setText] = useState(() => {
    const stored = readStored(DRAFT_KEY);
    return typeof stored === 'string' ? stored : initial;
  });

  useEffect(() => {
    const timer = setTimeout(() => writeStored(DRAFT_KEY, text), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return [text, setText] as const;
}
