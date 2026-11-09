/**
 * DotGrid (prompt 21): the one shared dot-matrix component — SVG circles,
 * no chart library. Layouts: 'strip' (rows of dots) and 'ring' (dots on a
 * circle for donuts). Hard cap 600 rendered circles: larger totals are
 * aggregated so the DOM never grows past the cap, while the aria-label
 * keeps the real numbers. Colours ride CSS (.dotgrid circle / .filled) so
 * heroes can invert them.
 */

export interface DotGridProps {
  /** Accessible description carrying the REAL numbers ("29 visits, 1 done"). */
  label: string;
  /** The real quantity the dots stand for (before aggregation). */
  total: number;
  /** How many of those are "filled" (prefix-filled from the first dot). */
  filled: number;
  layout?: 'strip' | 'ring';
  /** strip: dots per row (default: one row, wrapped past 24). */
  cols?: number;
  /** Dot diameter in px. */
  dot?: number;
  /** Gap between dots in px. */
  gap?: number;
  /** Extra class for colour context (e.g. dotgrid-hero on gradients). */
  className?: string;
  /** Pure decoration inside a parent that already carries the label. */
  decorative?: boolean;
}

const MAX_CIRCLES = 600;

export function DotGrid({ label, total, filled, layout = 'strip', cols, dot = 6, gap = 4, className, decorative = false }: DotGridProps) {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeFilled = Math.min(Math.max(0, Math.floor(filled)), safeTotal);

  // Cap: aggregate n real items into one dot past MAX_CIRCLES.
  let count = safeTotal;
  let filledCount = safeFilled;
  if (count > MAX_CIRCLES) {
    const step = Math.ceil(count / MAX_CIRCLES);
    count = Math.ceil(count / step);
    filledCount = Math.round(safeFilled / step);
  }

  const circles: { cx: number; cy: number; r: number; filled: boolean }[] = [];
  let width: number;
  let height: number;

  if (layout === 'ring') {
    // Dots on a circle: radius grows with the count so the dots never touch.
    const r = Math.max((count * (dot + gap)) / (2 * Math.PI), dot * 2);
    const size = 2 * (r + dot / 2);
    width = size;
    height = size;
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * 2 * Math.PI;
      circles.push({
        cx: size / 2 + r * Math.sin(angle),
        cy: size / 2 - r * Math.cos(angle),
        r: dot / 2,
        filled: i < filledCount
      });
    }
  } else {
    const perRow = cols ?? Math.min(Math.max(count, 1), 24);
    const rows = Math.ceil(count / perRow);
    width = perRow * dot + (perRow - 1) * gap;
    height = rows * dot + (rows - 1) * gap;
    for (let i = 0; i < count; i += 1) {
      const pos = i % perRow;
      const row = Math.floor(i / perRow);
      circles.push({
        cx: pos * (dot + gap) + dot / 2,
        cy: row * (dot + gap) + dot / 2,
        r: dot / 2,
        filled: i < filledCount
      });
    }
  }

  const w = Math.max(width, dot);
  const h = Math.max(height, dot);

  return (
    <svg
      className={`dotgrid${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: '100%', maxWidth: w, height: 'auto', display: 'block' }}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
    >
      {circles.map((c, i) => (
        <circle key={i} cx={c.cx} cy={c.cy} r={c.r} className={c.filled ? 'filled' : undefined} />
      ))}
    </svg>
  );
}
