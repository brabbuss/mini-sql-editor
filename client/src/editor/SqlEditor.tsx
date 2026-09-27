import { useMemo, useRef } from 'react';
import CodeMirror, { Decoration, EditorState, EditorView, keymap, Prec, ViewUpdate } from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { TextRange } from '../statementText';
import { ClickHouseDialect } from './clickhouseDialect';

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Mod-Enter, with what to run: the selected text if there is a selection, else the whole text, and where it starts.
   * Keep it stable (useCallback): a new function rebuilds the keymap
   */
  onRun: (text: string, offset: number) => void;
  /** The selected range, or undefined when nothing is selected. Called only when that changes, not on every cursor move */
  onSelectionChange?: (selection: TextRange | undefined) => void;
  /** The statement that failed: a light red background */
  errorStatement?: TextRange;
  /** Exactly where: a wavy underline (the token a syntax error points at, or where an unterminated string starts) */
  errorToken?: TextRange;
}

// Only valid, non-empty ranges can be marked; offsets past the end (text changed since) are clamped
function mark(className: 'cm-error-statement' | 'cm-error-token', range: TextRange | undefined, length: number) {
  if (!range) {
    return [];
  }
  const start = Math.max(0, Math.min(range.from, length));
  const end = Math.max(start, Math.min(range.to, length));
  return start < end ? [Decoration.mark({ class: className }).range(start, end)] : [];
}

/** What Run runs: the selection, or everything when nothing is selected */
function runTarget(state: EditorState): { text: string; offset: number } {
  const { from, to } = state.selection.main;
  return from < to ? { text: state.sliceDoc(from, to), offset: from } : { text: state.doc.toString(), offset: 0 };
}

export function SqlEditor({ value, onChange, onRun, onSelectionChange, errorStatement, errorToken }: SqlEditorProps) {
  // The last selection reported, so onSelectionChange only fires when it actually changes
  const reported = useRef<TextRange | undefined>(undefined);
  const handleUpdate = (update: ViewUpdate) => {
    if (!onSelectionChange || !(update.selectionSet || update.docChanged)) {
      return;
    }
    const { from, to } = update.state.selection.main;
    const selection = from < to ? { from, to } : undefined;
    if (selection?.from !== reported.current?.from || selection?.to !== reported.current?.to) {
      reported.current = selection;
      onSelectionChange(selection);
    }
  };

  // Mod-Enter runs the editor's current text; highest precedence so it wins over CodeMirror's own Enter handling
  const base = useMemo(
    () => [
      sql({ dialect: ClickHouseDialect }),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              const { text, offset } = runTarget(view.state);
              onRun(text, offset);
              return true;
            }
          }
        ])
      )
    ],
    [onRun]
  );
  // Keyed on the numbers, not the range objects (new ones on every render), so the editor only reconfigures on a change
  const [statementFrom, statementTo] = [errorStatement?.from, errorStatement?.to];
  const [tokenFrom, tokenTo] = [errorToken?.from, errorToken?.to];
  const length = value.length;
  const extensions = useMemo(() => {
    const statement =
      statementFrom === undefined || statementTo === undefined ? undefined : { from: statementFrom, to: statementTo };
    const token = tokenFrom === undefined || tokenTo === undefined ? undefined : { from: tokenFrom, to: tokenTo };
    const marks = [...mark('cm-error-statement', statement, length), ...mark('cm-error-token', token, length)];
    // Sorted by Decoration.set (the token sits inside the statement)
    return marks.length === 0 ? base : [...base, EditorView.decorations.of(Decoration.set(marks, true))];
  }, [base, statementFrom, statementTo, tokenFrom, tokenTo, length]);

  return (
    <div className="app__editor">
      <CodeMirror
        value={value}
        onChange={onChange}
        onUpdate={handleUpdate}
        extensions={extensions}
        height="100%"
        autoFocus
      />
    </div>
  );
}
