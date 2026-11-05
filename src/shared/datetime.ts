export const IST_OFFSET_MIN = 330;

export function istMinutesOfDay(utcMs: number): number {
  return (Math.floor(utcMs / 60000) + IST_OFFSET_MIN) % 1440;
}

export interface IstDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function istDateParts(utcMs: number): IstDateParts {
  const shifted = new Date(utcMs + IST_OFFSET_MIN * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay()
  };
}

export function formatIstTime(utcMs: number): string {
  const p = istDateParts(utcMs);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function istDateKey(utcMs: number): string {
  const p = istDateParts(utcMs);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
