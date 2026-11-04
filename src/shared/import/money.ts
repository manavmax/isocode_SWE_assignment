export function toPaise(raw: string): number | null {
  const digits = raw
    .trim()
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, '')
    .replace(/\u20b9/g, '')
    .replace(/\brs\.?/gi, '')
    .replace(/\binr\b/gi, '')
    .replaceAll('/-', '')
    .replace(/[\s,]/g, '');

  if (digits.startsWith('(') && digits.endsWith(')')) {
    return null;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(digits)) {
    return null;
  }

  const [rupees, paise = ''] = digits.split('.');
  const paisePart = paise.padEnd(2, '0');
  const total = Number(rupees) * 100 + Number(paisePart);
  return Number.isSafeInteger(total) ? total : null;
}
