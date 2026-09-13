import { BrowserProvider, type Signer } from 'ethers';
import { CREDITCOIN_CHAIN_ID, CREDITCOIN_RPC, CREDITCOIN_EXPLORER } from './config';

/**
 * Thin wrapper around the injected wallet (MetaMask or any EIP-1193
 * provider) already in the visitor's browser — no WalletConnect, no
 * third-party connector library. The sandbox flow is the only place this
 * project ever asks for a signature from a key it does not hold.
 */
export class NoWalletError extends Error {
  constructor() {
    super('No injected wallet found. Install MetaMask (or any EIP-1193 wallet) to use the sandbox.');
    this.name = 'NoWalletError';
  }
}

function ethereum(): NonNullable<(typeof window)['ethereum']> {
  const eth = (window as unknown as { ethereum?: Record<string, unknown> }).ethereum;
  if (!eth) throw new NoWalletError();
  return eth as never;
}

export function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { ethereum?: unknown }).ethereum);
}

export async function connectWallet(): Promise<{ provider: BrowserProvider; signer: Signer; address: string }> {
  const eth = ethereum();
  const provider = new BrowserProvider(eth as never);
  await provider.send('eth_requestAccounts', []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  return { provider, signer, address };
}

const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7'; // 11155111
const CREDITCOIN_CHAIN_ID_HEX = `0x${CREDITCOIN_CHAIN_ID.toString(16)}`;

/**
 * Switches the wallet's active network, adding it first if the wallet has
 * never seen it (`wallet_addEthereumChain`/`wallet_switchEthereumChain` are
 * standard EIP-3085/3326 calls — every injected wallet implements them,
 * this is not a custom connector).
 */
async function switchOrAddChain(chainIdHex: string, addParams: Record<string, unknown>): Promise<void> {
  const eth = ethereum();
  try {
    await (eth as { request: (a: unknown) => Promise<unknown> }).request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      await (eth as { request: (a: unknown) => Promise<unknown> }).request({
        method: 'wallet_addEthereumChain',
        params: [addParams],
      });
    } else {
      throw err;
    }
  }
}

export async function switchToSepolia(): Promise<void> {
  await switchOrAddChain(SEPOLIA_CHAIN_ID_HEX, {
    chainId: SEPOLIA_CHAIN_ID_HEX,
    chainName: 'Ethereum Sepolia',
    nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
    blockExplorerUrls: ['https://sepolia.etherscan.io'],
  });
}

export async function switchToCreditcoin(): Promise<void> {
  await switchOrAddChain(CREDITCOIN_CHAIN_ID_HEX, {
    chainId: CREDITCOIN_CHAIN_ID_HEX,
    chainName: 'Creditcoin CC3 Testnet',
    nativeCurrency: { name: 'Creditcoin', symbol: 'CTC', decimals: 18 },
    rpcUrls: [CREDITCOIN_RPC],
    blockExplorerUrls: [CREDITCOIN_EXPLORER],
  });
}

declare global {
  interface Window {
    ethereum?: Record<string, unknown>;
  }
}
