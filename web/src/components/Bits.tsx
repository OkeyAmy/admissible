import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { truncateHash } from '../lib/format';

/** Copies text and confirms it in place. No toast, no animation. */
export function CopyButton({ value, label = 'copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard
      .writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [value]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button type="button" className="copy-btn" onClick={onCopy} data-copied={copied}>
      {copied ? 'copied' : label}
    </button>
  );
}

/** Every hash, UID and address on screen goes through here. Always mono. */
export function Hash({
  value,
  href,
  truncate = true,
  head = 10,
  tail = 8,
  dim = false,
  copy = false,
}: {
  value: string | null | undefined;
  href?: string;
  truncate?: boolean;
  head?: number;
  tail?: number;
  dim?: boolean;
  copy?: boolean;
}) {
  if (!value) return <span className={`hash${dim ? ' hash-dim' : ''}`}>—</span>;
  const text = truncate ? truncateHash(value, head, tail) : value;
  const body = href ? (
    <a className="hash hash-link" href={href} target="_blank" rel="noreferrer" title={value}>
      {text}
    </a>
  ) : (
    <span className={`hash${dim ? ' hash-dim' : ''}`} title={value}>
      {text}
    </span>
  );
  if (!copy) return body;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline' }}>
      {body}
      <CopyButton value={value} />
    </span>
  );
}

export function ScrollTable({ children }: { children: ReactNode }) {
  return <div className="scroll-x">{children}</div>;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Notice({ children, warm = false }: { children: ReactNode; warm?: boolean }) {
  return <div className={`notice${warm ? ' notice-warm' : ''}`}>{children}</div>;
}

export function Working({ children }: { children: ReactNode }) {
  return <span className="working">{children}</span>;
}

export function Stat({
  label,
  value,
  sub,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${mono ? ' mono-value' : ''}`}>{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export default function ScrollToTopMarker() {
  return null;
}

export function useHashOnMount() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);
}
