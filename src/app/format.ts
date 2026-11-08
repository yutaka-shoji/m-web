import { DISPLAY_DECIMALS, type Channel } from '../core/device/quantities';
import { t } from './i18n';

/** Live display value with the official app's precision; '—' for missing. */
export function formatValue(ch: Channel, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(DISPLAY_DECIMALS[ch]);
}

export function formatVoltage(mv: number | null | undefined): string {
  if (mv === null || mv === undefined) return '—';
  return `${(mv / 1000).toFixed(2)} V`;
}

/** "12 秒前" / "12 s ago" relative to `now` (both in ms). */
export function formatAgo(thenMs: number, nowMs: number): string {
  if (!thenMs) return t('time.never');
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 3) return t('time.justNow');
  if (s < 60) return t('time.secondsAgo', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('time.minutesAgo', { n: m });
  return t('time.hoursAgo', { n: Math.floor(m / 60) });
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
