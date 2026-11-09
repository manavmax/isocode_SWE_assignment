/**
 * The one formatter module (prompt 20 item 10): money, dates and
 * plural-aware copy for every screen, en + hi.
 *
 * Money — integer paise in, never float arithmetic:
 *   - formatMoneyShort: lists and tiles ("₹12.4 L", "₹2.06 Cr"), 3
 *     significant digits, trailing zeros trimmed, never ".00";
 *   - formatMoneyExact: the loan-detail facts ("₹12,35,643", Indian
 *     grouping); paise appended only when non-zero.
 *
 * Dates — "Today" / "Tomorrow" / "9 Nov" on the IST day (IST has no DST,
 * so tomorrow is now + 24 h). ISO strings never reach the UI.
 */
import { istDateKey } from '../shared/datetime.js';
import { formatLakhCrore } from '../shared/money.js';
import { t as translate, type DictKey, type Lang } from './i18n/dictionary.js';

const MONTHS_SHORT: Record<Lang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  hi: ['जन', 'फ़र', 'मार्च', 'अप्रै', 'मई', 'जून', 'जुल', 'अग', 'सित', 'अक्टू', 'नव', 'दिस']
};

/** 3 significant digits, trailing zeros and a trailing dot stripped
 *  ("12.35" → "12.4", "2.00" → "2", "20.6" → "20.6"). Integer zeros are
 *  never touched ("10", "100" stay whole). */
function shortNumber(value: number): string {
  if (value === 0) return '0';
  const digits = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(value))));
  let text = String(Number(value.toFixed(Math.min(digits, 20))));
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

export function formatMoneyShort(paise: number): string {
  if (!Number.isFinite(paise)) return '—';
  const sign = paise < 0 ? '-' : '';
  const rupees = Math.trunc(Math.abs(paise) / 100);
  if (rupees >= 1_00_00_000) return `${sign}₹${shortNumber(rupees / 1_00_00_000)} Cr`;
  if (rupees >= 1_00_000) return `${sign}₹${shortNumber(rupees / 1_00_000)} L`;
  return `${sign}₹${formatLakhCrore(rupees)}`;
}

export function formatMoneyExact(paise: number): string {
  if (!Number.isFinite(paise)) return '—';
  const sign = paise < 0 ? '-' : '';
  const abs = Math.trunc(Math.abs(paise));
  const rupees = Math.trunc(abs / 100);
  const sub = abs % 100;
  return `${sign}₹${formatLakhCrore(rupees)}${sub > 0 ? `.${String(sub).padStart(2, '0')}` : ''}`;
}

/** "9 Nov" / "9 नव" from an IST date key ("2026-11-09"). */
export function formatDayMonth(dateKey: string, lang: Lang): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return dateKey;
  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) return dateKey;
  return `${Number(match[3])} ${MONTHS_SHORT[lang][month]}`;
}

/** "Today" / "Tomorrow" / "9 Nov" — the promised date compared to the IST
 *  day of `nowMs` (clock injectable for tests). Unknown keys render as-is. */
export function formatDateShort(dateKey: string, nowMs: number, lang: Lang): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return dateKey;
  if (dateKey === istDateKey(nowMs)) return translate(lang, 'dateToday');
  if (dateKey === istDateKey(nowMs + 86_400_000)) return translate(lang, 'dateTomorrow');
  return formatDayMonth(dateKey, lang);
}

/** The promise card's date chip (prompt 20 item 2): "Due today" only when
 *  the promised date equals the IST day of nowMs (clock injectable);
 *  otherwise "Tomorrow" or the concrete "9 Nov". Never ISO, never a
 *  mislabelled "Due today" on a future date. */
export function promiseDueChip(dateKey: string, nowMs: number, lang: Lang): string {
  const short = formatDateShort(dateKey, nowMs, lang);
  if (short === translate(lang, 'dateToday')) return translate(lang, 'promiseStatusDue');
  return short;
}

/** Plural-aware copy: dictionary keys carry {n}; n === 1 picks the `one`
 *  form ("1 promise due" / "2 promises due"), in both languages. */
export function pluralCopy(
  lang: Lang,
  forms: { one: DictKey; other: DictKey },
  n: number,
  params?: Record<string, string | number>
): string {
  return translate(lang, n === 1 ? forms.one : forms.other, params ?? { n });
}

/** A display name from the username (prompt 21 greeting): the only name the
 *  client has without an API change. "arjun.verma" → "Arjun Verma",
 *  "demo-officer-1" → "Demo Officer 1". */
export function displayName(username: string): string {
  return username
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
