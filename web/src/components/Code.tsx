import { useMemo, type ReactNode } from 'react';
import { CopyButton } from './Bits';

export type Lang = 'solidity' | 'ts' | 'bash' | 'json' | 'text';

const KEYWORDS: Record<Lang, string[]> = {
  solidity: [
    'pragma','solidity','import','contract','interface','library','abstract','is','function','external','public','internal','private','view','pure','payable','returns','return','struct','enum','event','emit','mapping','memory','storage','calldata','immutable','constant','constructor','require','if','else','for','while','new','using','override','virtual','modifier','indexed','address','bool','string','bytes','bytes32','uint8','uint32','uint64','uint256','int256','true','false','this',
  ],
  ts: [
    'import','from','export','const','let','var','function','async','await','return','if','else','for','while','new','class','extends','implements','interface','type','enum','try','catch','finally','throw','typeof','instanceof','as','of','in','void','null','undefined','true','false','this','default','static','readonly','public','private','satisfies',
  ],
  bash: ['npx','npm','node','cd','export','curl','cast','forge','git','echo','set','if','then','fi','for','do','done'],
  json: ['true', 'false', 'null'],
  text: [],
};

const TYPE_RE = /\b([A-Z][A-Za-z0-9_]{2,})\b/g;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Placeholders for masked-out comments/strings live in the Unicode Private
// Use Area. Every other regex in this file is ASCII-only (`\d`, `\w`, `\b`),
// so a PUA codepoint can never be re-matched by a later pass. The original
// implementation used a bare digit wrapped in spaces as the placeholder, and
// the number-highlighting regex — which runs after masking — re-wrapped that
// digit in its own <span>, breaking the final restore step whenever a
// comment or string was masked out (any bash line with a trailing
// `# comment`, for instance).
const PLACEHOLDER_BASE = 0xe000;

/**
 * A deliberately small tokenizer. Comments, strings, numbers, keywords, types —
 * five classes, warm muted hues only. Pulling in a full highlighter would drag
 * a foreign palette into a page built on five colours.
 */
function highlight(source: string, lang: Lang): string {
  const keywords = new Set(KEYWORDS[lang]);
  const placeholders: string[] = [];

  // Pull comments and strings out first so keyword matching cannot reach inside.
  const masked = source.replace(
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g,
    (match) => {
      const cls = /^(\/\/|\/\*|#)/.test(match) ? 'tok-comment' : 'tok-string';
      placeholders.push(`<span class="${cls}">${escapeHtml(match)}</span>`);
      return String.fromCodePoint(PLACEHOLDER_BASE + placeholders.length - 1);
    },
  );

  let html = escapeHtml(masked);

  if (lang !== 'text') {
    html = html.replace(/\b(0x[0-9a-fA-F]+|\d[\d_.]*(?:e-?\d+)?)\b/g, '<span class="tok-number">$1</span>');
    if (keywords.size) {
      html = html.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (m) =>
        keywords.has(m) ? `<span class="tok-keyword">${m}</span>` : m,
      );
    }
    if (lang === 'solidity' || lang === 'ts') {
      html = html.replace(TYPE_RE, (m) => (keywords.has(m) ? m : `<span class="tok-type">${m}</span>`));
    }
  }

  return html.replace(/[-]/g, (ch) => placeholders[ch.codePointAt(0)! - PLACEHOLDER_BASE] ?? ch);
}

export default function Code({
  children,
  lang = 'text',
  label,
  copy = true,
  extra,
}: {
  children: string;
  lang?: Lang;
  label?: string;
  copy?: boolean;
  extra?: ReactNode;
}) {
  const source = children.replace(/\n+$/, '');
  const html = useMemo(() => highlight(source, lang), [source, lang]);
  return (
    <div className="code">
      {label || copy || extra ? (
        <div className="code-head">
          <span>{label ?? lang}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            {extra}
            {copy ? <CopyButton value={source} /> : null}
          </span>
        </div>
      ) : null}
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
