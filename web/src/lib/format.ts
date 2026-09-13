export function truncateHash(value: string | undefined | null, head = 10, tail = 8): string {
  if (!value) return '—';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatInt(n: number | bigint | undefined | null): string {
  if (n === undefined || n === null) return '—';
  return Number(n).toLocaleString('en-US');
}

export function formatMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatUnixSeconds(seconds: number | undefined | null): string {
  if (!seconds) return '—';
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function formatIso(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function elapsedLabel(startedAt: number, now: number): string {
  const s = Math.max(0, (now - startedAt) / 1000);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}
