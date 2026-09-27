/**
 * sessionStorage, for conveniences only: the editor's draft and the id of the run on screen. It belongs to the browser
 * tab and survives a reload, so two tabs never mix their runs or drafts (localStorage is shared by every tab). It can
 * be unavailable (blocked site data) or full, so every access is guarded, and a failure just means nothing is
 * remembered.
 */

export function readStored(key: string): unknown {
  try {
    const text = sessionStorage.getItem(key);
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function writeStored(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered; nothing else depends on it
  }
}

export function removeStored(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable
  }
}
