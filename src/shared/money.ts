/** Indian-grouping money formatters. All money is integer paise (SPEC 4);
 * these take rupees/paise and never float arithmetic on money values. */

export function formatLakhCrore(rupees: number): string {
  if (!Number.isFinite(rupees)) return '-';
  const sign = rupees < 0 ? '-' : '';
  let rest = String(Math.trunc(Math.abs(rupees)));
  if (rest.length <= 3) return sign + rest;
  const last3 = rest.slice(-3);
  rest = rest.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);
  return `${sign}${groups.join(',')},${last3}`;
}

export function formatRupeePaise(paise: number): string {
  if (!Number.isFinite(paise)) return '-';
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.trunc(abs / 100);
  const sub = abs % 100;
  return `${sign}₹${formatLakhCrore(rupees)}.${String(sub).padStart(2, '0')}`;
}
