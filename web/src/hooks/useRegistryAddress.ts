import { useEffect, useState } from 'react';
import { resolveRegistryAddress } from '../lib/registry';

/**
 * The registry address arrives from VITE_REGISTRY_ADDRESS at build time or from
 * /deployments.json at runtime. Until the contracts workspace has deployed,
 * `address` is an empty string and every surface says so rather than spinning.
 */
export function useRegistryAddress() {
  const [address, setAddress] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    resolveRegistryAddress()
      .then((a) => {
        if (live) setAddress(a);
      })
      .catch(() => {
        if (live) setAddress('');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  return { address, loading, deployed: Boolean(address) };
}
