/**
 * Phone masking (A32): no server response may carry a full phone number.
 * Digits only are considered; the mask keeps the first two and last two
 * digits and replaces the remainder with X, preserving length. Fewer than
 * five digits cannot be masked meaningfully and produce null.
 */
export function maskPhone(mobile: string | null | undefined): string | null {
  if (typeof mobile !== 'string') {
    return null;
  }
  const digits = mobile.replace(/\D/g, '');
  if (digits.length < 5) {
    return null;
  }
  return `${digits.slice(0, 2)}${'X'.repeat(digits.length - 4)}${digits.slice(-2)}`;
}
