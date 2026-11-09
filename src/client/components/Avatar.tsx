/**
 * Avatar (prompt 21): a circular initials avatar. Tints ride the pastel
 * chip pairs so a borrower's avatar and bucket chip always agree. Purely
 * decorative (the name is always rendered beside it) — aria-hidden.
 */

export type AvatarTint = 'blue' | 'amber' | 'red' | 'plum' | 'neutral';

export function Avatar({ name, size = 44, tint = 'neutral' }: { name: string; size?: 32 | 44 | 56; tint?: AvatarTint }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join('')
    .toUpperCase();
  return (
    <span
      className={`avatar avatar-tint-${tint}`}
      style={{ width: size, height: size, fontSize: size >= 56 ? 18 : size >= 44 ? 16 : 14 }}
      aria-hidden="true"
    >
      {initials || '—'}
    </span>
  );
}

/** The pastel tint matching a DPD bucket index (1-4, clamped). */
export function bucketTint(bucketIndex: number): AvatarTint {
  switch (bucketIndex) {
    case 1:
      return 'blue';
    case 2:
      return 'amber';
    case 3:
      return 'red';
    default:
      return 'plum';
  }
}
