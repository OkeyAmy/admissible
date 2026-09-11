import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Marked } from 'marked';
import type { Tokens } from 'marked';
import Shell from '../components/Shell';

import quickstartRaw from '../../../docs/quickstart.md?raw';
import architectureRaw from '../../../docs/architecture.md?raw';
import registryRaw from '../../../docs/registry.md?raw';
import verifyRaw from '../../../docs/verify.md?raw';
import sdkRaw from '../../../docs/sdk.md?raw';
import attestcoinRaw from '../../../docs/attestcoin-integration.md?raw';

interface DocEntry {
  slug: string;
  title: string;
  raw: string;
}

const DOCS: DocEntry[] = [
  { slug: 'quickstart', title: 'Quickstart', raw: quickstartRaw },
  { slug: 'architecture', title: 'Architecture', raw: architectureRaw },
  { slug: 'attestcoin-integration', title: 'Attestcoin integration', raw: attestcoinRaw },
  { slug: 'registry', title: 'Registry reference', raw: registryRaw },
  { slug: 'verify', title: 'Verification', raw: verifyRaw },
  { slug: 'sdk', title: 'SDK reference', raw: sdkRaw },
];

const DEFAULT_SLUG = DOCS[0].slug;

// -------------------------------------------------------------------------
// Slugs. marked v15 dropped automatic heading ids, so both the renderer and
// the TOC extractor below assign them with the identical algorithm, walking
// headings in the identical document order — that is what keeps anchors and
// "on this page" links pointing at the same element without ever sharing a
// token reference.
// -------------------------------------------------------------------------

function slugify(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return base || 'section';
}

function dedupe(seen: Map<string, number>, base: string): string {
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function stripInlineMd(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\*([^*]*)\*/g, '$1');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Rewrites a relative `./foo.md` (optionally `#hash`) link into a site route. */
function rewriteHref(href: string): string {
  const m = href.match(/^(?:\.\/)?([a-zA-Z0-9_-]+)\.md(#.*)?$/i);
  if (!m) return href;
  return `/docs/${m[1]}${m[2] ?? ''}`;
}

const renderer = new Marked({
  gfm: true,
  renderer: {
    heading(token: Tokens.Heading) {
      const inline = this.parser.parseInline(token.tokens);
      const id = dedupe(headingSlugState, slugify(token.text));
      return `<h${token.depth} id="${id}">${inline}<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a></h${token.depth}>\n`;
    },
    link(token: Tokens.Link) {
      const inline = this.parser.parseInline(token.tokens);
      const href = rewriteHref(token.href);
      const titleAttr = token.title ? ` title="${token.title}"` : '';
      const external = /^https?:\/\//i.test(href);
      const rel = external ? ' target="_blank" rel="noreferrer"' : '';
      return `<a href="${href}"${titleAttr}${rel}>${inline}</a>`;
    },
    code(token: Tokens.Code) {
      const lang = (token.lang || 'text').trim().split(/\s+/)[0] || 'text';
      return `<div class="code docs-code"><div class="code-head"><span>${lang}</span></div><pre><code class="language-${lang}">${escapeHtml(token.text)}</code></pre></div>\n`;
    },
  },
});

// Reset before every parse() call — see the comment above.
let headingSlugState = new Map<string, number>();

function renderMarkdown(src: string): string {
  headingSlugState = new Map<string, number>();
  return renderer.parse(src, { async: false }) as string;
}

interface HeadingEntry {
  id: string;
  text: string;
  depth: number;
}

function computeHeadings(src: string): HeadingEntry[] {
  const tokens = renderer.lexer(src);
  const seen = new Map<string, number>();
  const out: HeadingEntry[] = [];
  for (const t of tokens) {
    if (t.type === 'heading') {
      const heading = t as Tokens.Heading;
      out.push({ id: dedupe(seen, slugify(heading.text)), text: heading.text, depth: heading.depth });
    }
  }
  return out;
}

export default function Docs() {
  const { slug: slugParam } = useParams<{ slug?: string }>();
  const slug = slugParam ?? DEFAULT_SLUG;
  const navigate = useNavigate();
  const doc = DOCS.find((d) => d.slug === slug) ?? DOCS[0];

  const html = useMemo(() => renderMarkdown(doc.raw), [doc.raw]);
  const headings = useMemo(() => computeHeadings(doc.raw).filter((h) => h.depth === 2 || h.depth === 3), [doc.raw]);

  const contentRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    setActiveId(null);
    setNavOpen(false);
  }, [slug]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const els = Array.from(container.querySelectorAll('h2[id], h3[id]'));
    if (!els.length) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-12% 0px -72% 0px', threshold: [0, 1] },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [slug, html]);

  const onContentClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a');
      const href = anchor?.getAttribute('href');
      if (href && href.startsWith('/docs')) {
        e.preventDefault();
        navigate(href);
      }
    },
    [navigate],
  );

  return (
    <Shell>
      <section className="page docs-page">
        <div className="page-head">
          <span className="eyebrow">Docs</span>
        </div>

        <div className="docs-layout">
          <div className="docs-sidebar">
            <button
              type="button"
              className="docs-sidebar-toggle"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((v) => !v)}
            >
              Contents
              <span aria-hidden="true">{navOpen ? '−' : '+'}</span>
            </button>
            <div className={`docs-sidebar-disclosure${navOpen ? ' is-open' : ''}`}>
              <ul className="docs-sidebar-list">
                {DOCS.map((d) => (
                  <li key={d.slug}>
                    <Link to={`/docs/${d.slug}`} className={d.slug === slug ? 'is-active' : undefined}>
                      {d.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <article className="docs-content" ref={contentRef} onClick={onContentClick}>
            <div dangerouslySetInnerHTML={{ __html: html }} />
          </article>

          <nav className="docs-toc" aria-label="On this page">
            {headings.length > 0 ? (
              <>
                <p className="docs-toc-title">On this page</p>
                <ul>
                  {headings.map((h) => (
                    <li key={h.id} className={h.depth === 3 ? 'is-sub' : undefined}>
                      <a href={`#${h.id}`} className={activeId === h.id ? 'is-active' : undefined}>
                        {stripInlineMd(h.text)}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </nav>
        </div>
      </section>
    </Shell>
  );
}
