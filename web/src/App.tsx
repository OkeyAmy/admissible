import { Route, Routes } from 'react-router-dom';

import Landing from './routes/Landing';
import MirrorApp from './routes/MirrorApp';
import Registry from './routes/Registry';
import Verify from './routes/Verify';
import Revocation from './routes/Revocation';
import Sdk from './routes/Sdk';
import Receipts from './routes/Receipts';
import Batch from './routes/Batch';
import Pool from './routes/Pool';
import Sandbox from './routes/Sandbox';
import Docs from './routes/Docs';
import NotFound from './routes/NotFound';
import ScrollToTop from './components/ScrollToTop';

export default function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<MirrorApp />} />
        <Route path="/registry" element={<Registry />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/revocation" element={<Revocation />} />
        <Route path="/sdk" element={<Sdk />} />
        <Route path="/receipts" element={<Receipts />} />
        <Route path="/batch" element={<Batch />} />
        <Route path="/pool" element={<Pool />} />
        <Route path="/sandbox" element={<Sandbox />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:slug" element={<Docs />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
