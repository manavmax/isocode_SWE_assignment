import { useEffect, useState } from 'react';
import { isLang, t, type DictKey, type Lang } from './dictionary.js';

const STORAGE_KEY = 'fc.lang';

function storedLang(): Lang {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isLang(value) ? value : 'hi';
  } catch {
    return 'hi';
  }
}

function persistLang(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // private mode / storage disabled: language just won't survive reload
  }
}

function applyLangAttribute(lang: Lang): void {
  try {
    document.documentElement.lang = lang;
  } catch {
    // non-DOM context (tests): nothing to set
  }
}

export function useLang(): {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: DictKey, params?: Record<string, string | number>) => string;
} {
  const [lang, setLangState] = useState<Lang>(storedLang);

  useEffect(() => {
    applyLangAttribute(lang);
  }, [lang]);

  function setLang(next: Lang): void {
    setLangState(next);
    persistLang(next);
    applyLangAttribute(next);
  }

  return { lang, setLang, t: (key, params) => t(lang, key, params) };
}
