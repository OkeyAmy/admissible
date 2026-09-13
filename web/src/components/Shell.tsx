import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { CREDITCOIN_EXPLORER, REGISTRY_ADDRESS } from '../lib/config';
import { useRegistryAddress } from '../hooks/useRegistryAddress';
import { truncateHash } from '../lib/format';

const FOOTER_LINKS: [string, string][] = [
  ['Registry', '/registry'],
  ['Pool', '/pool'],
  ['Sandbox', '/sandbox'],
  ['Verify', '/verify'],
  ['Revocation', '/revocation'],
  ['SDK', '/sdk'],
];

export function Header({ nav = true }: { nav?: boolean }) {
  return (
    <header className="shell-header">
      <div className="shell-inner shell-header-row">
        <Link to="/" className="wordmark-app">
          admissible
        </Link>
        {nav ? (
          <nav>
            <NavLink to="/app" className={({ isActive }) => (isActive ? 'is-active' : undefined)}>
              mirror
            </NavLink>
            <NavLink to="/receipts" className={({ isActive }) => (isActive ? 'is-active' : undefined)}>
              receipts
            </NavLink>
            <NavLink to="/docs" className={({ isActive }) => (isActive ? 'is-active' : undefined)}>
              docs
            </NavLink>
          </nav>
        ) : (
          <nav>
            <NavLink to="/docs">docs</NavLink>
          </nav>
        )}
      </div>
    </header>
  );
}

export function Footer() {
  const { address } = useRegistryAddress();
  return (
    <footer className="shell-footer">
      <div className="shell-footer-inner">
        <hr className="hair" />
        <div className="footer-links">
          {FOOTER_LINKS.map(([label, to], i) => (
            <span key={to}>
              {i > 0 ? <span className="footer-sep">·&nbsp;</span> : null}
              <Link to={to}>{label}</Link>
            </span>
          ))}
        </div>
        <div className="footer-meta">
          {address ? (
            <>
              registry{' '}
              <a
                className="hash-link"
                href={`${CREDITCOIN_EXPLORER}/address/${address}`}
                target="_blank"
                rel="noreferrer"
              >
                {truncateHash(address, 10, 8)}
              </a>{' '}
              · Creditcoin CC3 testnet · chain 102031
            </>
          ) : (
            <>registry not deployed yet · Creditcoin CC3 testnet · chain 102031</>
          )}
        </div>
      </div>
    </footer>
  );
}

export default function Shell({
  children,
  nav = true,
}: {
  children: ReactNode;
  nav?: boolean;
}) {
  return (
    <div className="shell mood-cream">
      <Header nav={nav} />
      <main className="shell-main">{children}</main>
      <Footer />
    </div>
  );
}

export { REGISTRY_ADDRESS };
