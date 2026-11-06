import { t as translate, type Lang, type DictKey } from '../i18n/dictionary.js';

interface Props {
  lang: Lang;
  ruleCode?: string;
  onClose: () => void;
}

export function BlockedSheet({ lang, ruleCode, onClose }: Props) {
  const tr = (key: DictKey) => translate(lang, key);

  return (
    <dialog open className="blocked-sheet" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet-content">
        <div className="sheet-handle" aria-hidden="true" />
        <p className="blocked-title">{tr('blockedTitle')}</p>
        <p className="blocked-body">{tr('blockedBody')}</p>
        {ruleCode ? (
          <p className="blocked-rule">{tr('blockedRuleLabel')}: <code>{ruleCode}</code></p>
        ) : null}
        <button type="button" className="btn btn-primary" style={{ marginTop: 'var(--sp-4)' }} onClick={onClose}>
          {tr('close')}
        </button>
      </div>
    </dialog>
  );
}
