export function formatSize(bytes: number | null | undefined, locale = 'en'): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return [hours, minutes, remaining].map(value => String(value).padStart(2, '0')).join(':');
}

export function formatDurationWords(
  seconds: number | null | undefined,
  locale: 'en' | 'uk' = 'en'
) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} ${locale === 'uk' ? 'год' : 'hr'}`);
  if (minutes || hours) parts.push(`${minutes} ${locale === 'uk' ? 'хв' : 'min'}`);
  if (remaining || !parts.length) parts.push(`${remaining} ${locale === 'uk' ? 'с' : 'sec'}`);
  return parts.join(' ');
}

export function formatElapsed(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return '00:00:00';
  return formatDuration(milliseconds / 1000);
}

export function formatFps(value: number | null | undefined, locale = 'en'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

export function formatBitrate(bitsPerSecond: number | null | undefined, locale = 'en'): string {
  if (bitsPerSecond === null || bitsPerSecond === undefined || !Number.isFinite(bitsPerSecond)) {
    return '—';
  }
  if (bitsPerSecond >= 1_000_000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(bitsPerSecond / 1_000_000)} Mbps`;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bitsPerSecond / 1000)} kbps`;
}

export function formatCodec(value: string | null | undefined): string {
  if (!value) return '—';
  const codecs: Record<string, string> = {
    h264: 'H.264',
    hevc: 'HEVC',
    h265: 'H.265',
    av1: 'AV1',
    vp9: 'VP9',
    mpeg4: 'MPEG-4'
  };
  return codecs[value.toLowerCase()] ?? value.toUpperCase();
}

export function compactPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 3) return value;
  return `…/${segments.slice(-3).join('/')}`;
}
