import { Link } from 'react-router-dom';
import Shell from '../components/Shell';

export default function NotFound() {
  return (
    <Shell>
      <section className="page">
        <div className="page-head">
          <span className="eyebrow">404</span>
          <h1 className="page-title">Not written.</h1>
          <p className="page-lede">
            There is nothing at this address. <Link to="/">Return to the threshold</Link>, or paste a UID on{' '}
            <Link to="/app">the mirror page</Link>.
          </p>
        </div>
      </section>
    </Shell>
  );
}
