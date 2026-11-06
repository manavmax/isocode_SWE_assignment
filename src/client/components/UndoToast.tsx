import { useEffect, useState } from 'react';
import { t as translate, type Lang, type DictKey } from '../i18n/dictionary.js';

interface Props {
  lang: Lang;
  itemId: string;
  onUndo: (id: string) => void;
  /** Called after the toast hides (either Undo tapped or timer expired). */
  onDone: () => void;
  /** How long the toast stays before auto-hiding (ms). Default 5 000. */
  durationMs?: number;
}

export function UndoToast({ lang, itemId, onUndo, onDone, durationMs = 5_000 }: Props) {
  const [visible, setVisible] = useState(true);
  const tr = (key: DictKey) => translate(lang, key);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDone();
    }, durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, onDone]);

  function handleUndo() {
    setVisible(false);
    onUndo(itemId);
    onDone();
  }

  if (!visible) return null;

  return (
    <div className="undo-toast" role="status" aria-live="polite">
      <span className="undo-text">{tr('undoMessage')}</span>
      <button type="button" className="undo-action" onClick={handleUndo}>
        {tr('undo')}
      </button>
    </div>
  );
}
