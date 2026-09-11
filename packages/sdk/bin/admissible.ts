#!/usr/bin/env node
/**
 * admissible — Ethereum attestations, admissible on Creditcoin.
 *
 *   admissible verify <uid> [--chain 1|3]     the judge's command
 *   admissible mirror <uid> [--chain 1|3]     mirror one attestation, live
 *   admissible status                         attested heights, registry, balance
 *
 * `verify` MUST run with no API key, no .env and no local state. Every endpoint
 * defaults to the public ones verified in SPEC.md §3; the environment is only
 * ever an override. Nothing here reads the current working directory.
 */

import { formatEther } from 'ethers';

import {
  CHAIN_KEYS,
  CREDITCOIN_CHAIN_ID,
  CREDITCOIN_EXPLORER,
  CREDITCOIN_RPC,
  PROVER_URL,
  attestedHeight,
  easscanLink,
  getRegistry,
  isChainKey,
  onchainAttestedHeight,
  parseUid,
  registryAbiSource,
  resolveEndpoints,
  sourceChain,
  totals,
  verify,
  type ChainKey,
  type MirrorProgress,
  type VerifyReport,
} from '../src/index.js';
import { mirror } from '../src/mirror.js';
import { creditcoinProvider, sourceProvider } from '../src/providers.js';

/* ------------------------------------------------------------------ */
/* minimal ANSI — mono-friendly, no framework                          */
/* ------------------------------------------------------------------ */

const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

const c = {
  reset: (s: string) => (useColour ? `\x1b[0m${s}\x1b[0m` : s),
  bold: (s: string) => (useColour ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColour ? `\x1b[2m${s}\x1b[22m` : s),
  green: (s: string) => (useColour ? `\x1b[32m${s}\x1b[39m` : s),
  red: (s: string) => (useColour ? `\x1b[31m${s}\x1b[39m` : s),
  yellow: (s: string) => (useColour ? `\x1b[33m${s}\x1b[39m` : s),
  cyan: (s: string) => (useColour ? `\x1b[36m${s}\x1b[39m` : s),
  boldGreen: (s: string) => (useColour ? `\x1b[1;32m${s}\x1b[0m` : s),
  boldRed: (s: string) => (useColour ? `\x1b[1;31m${s}\x1b[0m` : s),
};

const out = (s = '') => process.stdout.write(s + '\n');

/** Visible width, ignoring ANSI escapes. */
function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(s: string, n: number): string {
  const w = width(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

const RULE = '─';

/* ------------------------------------------------------------------ */
/* argument parsing                                                    */
/* ------------------------------------------------------------------ */

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags };
}

function chainFlag(flags: Record<string, string | boolean>): ChainKey | undefined {
  const raw = flags.chain;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!isChainKey(n)) {
    fail(`--chain must be 1 (Ethereum Sepolia) or 3 (Ethereum Mainnet); got "${String(raw)}".`);
  }
  return n as ChainKey;
}

function fail(message: string): never {
  process.stderr.write(c.red(`error: ${message}`) + '\n');
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* verify — THE judge's command                                        */
/* ------------------------------------------------------------------ */

function renderVerify(report: VerifyReport, elapsedMs: number): void {
  const chain = sourceChain(report.chainKey);
  const endpoints = resolveEndpoints();

  out();
  out(c.bold('admissible verify'));
  out(c.dim(RULE.repeat(78)));
  out(`${pad('attestation', 16)}${report.uid}`);
  out(`${pad('source chain', 16)}${chain.name}  ${c.dim(`(chainKey ${report.chainKey})`)}`);
  out(`${pad('registry', 16)}${report.registryAddress || c.dim('(not deployed)')}  ${c.dim(`[${endpoints.registrySource}]`)}`);
  out(`${pad('creditcoin rpc', 16)}${endpoints.creditcoinRpc}`);
  out(`${pad('easscan', 16)}${chain.easscan}`);
  out(c.dim(RULE.repeat(78)));
  out();

  // Column widths sized to content, so the table stays tight in a mono font.
  const FIELD_W = Math.max(14, ...report.rows.map((r) => r.field.length + 2));
  const REG_W = Math.max(24, ...report.rows.map((r) => width(r.registry) + 2));
  const EAS_W = Math.max(24, ...report.rows.map((r) => width(r.easscan) + 2));

  out(
    c.dim(pad('field', FIELD_W) + pad('registry (creditcoin)', REG_W) + pad('easscan (ethereum)', EAS_W) + ' '),
  );
  out(c.dim(RULE.repeat(FIELD_W + REG_W + EAS_W + 3)));

  for (const row of report.rows) {
    const mark = row.informational ? c.dim('·') : row.match ? c.green('=') : c.red('≠');
    const line = pad(row.field, FIELD_W) + pad(row.registry, REG_W) + pad(row.easscan, EAS_W) + ' ' + mark;
    out(row.informational ? c.dim(line) : line);
  }

  out(c.dim(RULE.repeat(FIELD_W + REG_W + EAS_W + 3)));
  out();

  const compared = report.rows.filter((r) => !r.informational);
  const matched = compared.filter((r) => r.match).length;

  if (report.outcome === 'PASS') {
    out(c.boldGreen(`  PASS  `) + `  ${matched}/${compared.length} fields identical on Creditcoin and easscan.`);
    out(
      c.dim(
        `          The registry record was written by proving the Ethereum transaction itself —\n` +
          `          no oracle, no bridge, no new signature.`,
      ),
    );
  } else {
    out(c.boldRed(`  FAIL  `) + `  ${matched}/${compared.length} fields identical.`);
    for (const f of report.failures) out(c.red(`          · ${f}`));
  }

  for (const n of report.notes) out(c.dim(`          note: ${n}`));

  out();
  out(c.dim(`  cross-check: ${easscanLink(report.uid, report.chainKey)}`));
  if (report.registry) {
    out(c.dim(`  source tx:   ${chain.explorer}/tx/${report.registry.sourceTxHash}`));
  } else if (report.eas?.txid) {
    out(c.dim(`  source tx:   ${chain.explorer}/tx/${report.eas.txid}`));
  }
  out(c.dim(`  ${elapsedMs} ms`));
  out();
}

async function cmdVerify(args: Args): Promise<number> {
  const raw = args.positional[0];
  if (!raw) fail('usage: admissible verify <uid> [--chain 1|3]');
  const uid = parseUid(raw);
  if (!uid) fail(`"${raw}" is not an EAS UID. Expected a 32-byte hex value, or an easscan URL containing one.`);

  const started = Date.now();
  const report = await verify(uid, chainFlag(args.flags), {
    registryAddress: typeof args.flags.registry === 'string' ? args.flags.registry : undefined,
    creditcoinRpc: typeof args.flags.rpc === 'string' ? args.flags.rpc : undefined,
  });
  const elapsed = Date.now() - started;

  if (args.flags.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    renderVerify(report, elapsed);
  }
  return report.outcome === 'PASS' ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* mirror                                                              */
/* ------------------------------------------------------------------ */

const STAGE_LABEL: Record<MirrorProgress['stage'], string> = {
  resolving: 'resolving       ',
  'awaiting-attestation': 'attesting       ',
  'building-proof': 'building proof  ',
  submitting: 'submitting      ',
  mirrored: 'mirrored        ',
  failed: 'failed          ',
};

const STAGE_ORDER: MirrorProgress['stage'][] = ['resolving', 'awaiting-attestation', 'building-proof', 'submitting', 'mirrored'];

function renderStage(p: MirrorProgress, startedAt: number): void {
  const t = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  const idx = STAGE_ORDER.indexOf(p.stage);
  const n = idx >= 0 ? `${idx + 1}/5` : ' — ';
  const label = STAGE_LABEL[p.stage];

  const detail: string[] = [];
  if (p.attestedHeight !== undefined && p.targetBlock !== undefined) {
    const behind = p.targetBlock - p.attestedHeight;
    detail.push(`attested ${p.attestedHeight} → need ${p.targetBlock}${behind > 0 ? ` (${behind} to go)` : ''}`);
  } else if (p.targetBlock !== undefined) {
    detail.push(`block ${p.targetBlock}`);
  }
  if (p.continuityRoots !== undefined) detail.push(`${p.continuityRoots} continuity roots`);
  if (p.merkleSiblings !== undefined) detail.push(`${p.merkleSiblings} merkle siblings`);
  if (p.creditcoinTxHash) detail.push(p.creditcoinTxHash);
  if (p.error) detail.push(c.red(p.error));

  const colour = p.stage === 'failed' ? c.red : p.stage === 'mirrored' ? c.green : (s: string) => s;
  out(`  ${c.dim(t + 's')}  ${c.dim(n)}  ${colour(label)}  ${c.dim(detail.join('  ·  '))}`);
}

async function cmdMirror(args: Args): Promise<number> {
  const raw = args.positional[0];
  if (!raw) fail('usage: admissible mirror <uid> [--chain 1|3]');
  const uid = parseUid(raw);
  if (!uid) fail(`"${raw}" is not an EAS UID.`);

  let chainKey = chainFlag(args.flags);
  if (!chainKey) {
    const { detectChainKey } = await import('../src/eas.js');
    const detected = await detectChainKey(uid);
    if (!detected) fail(`easscan has no attestation ${uid} on either source chain. Pass --chain to force one.`);
    chainKey = detected;
  }

  const chain = sourceChain(chainKey);
  out();
  out(c.bold('admissible mirror'));
  out(c.dim(RULE.repeat(78)));
  out(`${pad('attestation', 16)}${uid}`);
  out(`${pad('source chain', 16)}${chain.name}  ${c.dim(`(chainKey ${chainKey})`)}`);
  out(c.dim(RULE.repeat(78)));
  out();

  const startedAt = Date.now();
  let lastKey = '';
  const result = await mirror(uid, chainKey, {
    action: args.flags.revoke ? 1 : 0,
    registryAddress: typeof args.flags.registry === 'string' ? args.flags.registry : undefined,
    onProgress: (p) => {
      // Collapse repeated identical poll lines so the log stays readable.
      const key = `${p.stage}|${p.attestedHeight ?? ''}|${p.continuityRoots ?? ''}|${p.creditcoinTxHash ?? ''}`;
      if (key === lastKey) return;
      lastKey = key;
      renderStage(p, startedAt);
    },
  });

  out();
  if (result.status === 'mirrored') {
    out(c.boldGreen('  MIRRORED  ') + `  ${result.attestationsWritten ?? '?'} attestation(s) written from one proved Ethereum transaction.`);
    out(`  creditcoin tx  ${result.creditcoinTxHash}`);
    out(c.dim(`                 ${CREDITCOIN_EXPLORER}/tx/${result.creditcoinTxHash}`));
    out(`  gas used       ${result.gasUsed}`);
    out(`  cost           ${result.ctcCost} CTC`);
    out(`  proof          ${result.proofLatencyMs} ms   ${c.dim('(prover service — costs no CTC)')}`);
    out(`  submit         ${result.submitLatencyMs} ms   ${c.dim('(creditcoin — costs CTC)')}`);
    if (result.attestationWaitMs) out(`  attestation    ${result.attestationWaitMs} ms   ${c.dim('(waiting for the source block)')}`);
    out(`  queryId        ${result.queryId}`);
    out();
    out(c.dim(`  verify it:  npx admissible verify ${uid} --chain ${chainKey}`));
  } else if (result.status === 'already-mirrored') {
    out(c.yellow('  ALREADY MIRRORED  ') + `  the registry already holds this transaction's query.`);
    out(c.dim(`  queryId  ${result.queryId}`));
    out();
    out(c.dim(`  verify it:  npx admissible verify ${uid} --chain ${chainKey}`));
  } else {
    out(c.boldRed('  FAILED  ') + `  ${result.error}`);
  }
  out();
  return result.status === 'failed' ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

async function cmdStatus(args: Args): Promise<number> {
  const endpoints = resolveEndpoints({
    registryAddress: typeof args.flags.registry === 'string' ? args.flags.registry : undefined,
  });

  out();
  out(c.bold('admissible status'));
  out(c.dim(RULE.repeat(78)));
  out(`${pad('creditcoin', 18)}${endpoints.creditcoinRpc}  ${c.dim(`chainId ${CREDITCOIN_CHAIN_ID}`)}`);
  out(`${pad('prover', 18)}${endpoints.proverUrl}`);
  out(c.dim(RULE.repeat(78)));
  out();

  /* --- attested heights, both source chains --- */
  out(c.bold('  attestcoin protocol — attested source heights'));
  out();
  for (const key of CHAIN_KEYS) {
    const chain = sourceChain(key);
    const [prover, onchain, head] = await Promise.all([
      attestedHeight(key, endpoints.proverUrl).catch((e: Error) => e),
      onchainAttestedHeight(key, endpoints.creditcoinRpc).catch((e: Error) => e),
      headOf(key).catch((e: Error) => e),
    ]);

    out(`  ${c.bold(pad(chain.name, 20))}${c.dim(`chainKey ${key}`)}`);
    if (typeof prover === 'number') {
      out(`    ${pad('prover cache', 18)}${prover}`);
    } else {
      out(`    ${pad('prover cache', 18)}${c.red('unavailable: ' + prover.message)}`);
    }
    if (onchain instanceof Error) {
      out(`    ${pad('chaininfo 0x…0FD3', 18)}${c.red('unavailable: ' + onchain.message)}`);
    } else {
      out(`    ${pad('chaininfo 0x…0FD3', 18)}${onchain.height}  ${c.dim(onchain.isAttestation ? '(attestation)' : '(checkpoint)')}`);
    }
    if (typeof head === 'number') {
      const lag = typeof prover === 'number' ? head - prover : null;
      out(`    ${pad('source head', 18)}${head}${lag !== null ? c.dim(`   lag ${lag} blocks`) : ''}`);
    } else {
      out(`    ${pad('source head', 18)}${c.red('unavailable: ' + head.message)}`);
    }
    out(`    ${pad('reorg window', 18)}${chain.reorgWindow} blocks  ${c.dim('(blocks nearer the head are not provable yet)')}`);
    out();
  }

  /* --- registry --- */
  out(c.bold('  registry'));
  out();
  if (!endpoints.registryAddress) {
    out(`    ${c.yellow('not deployed')} — no address from --registry, REGISTRY_ADDRESS or contracts/deployments.json.`);
    out();
  } else {
    out(`    ${pad('address', 18)}${endpoints.registryAddress}  ${c.dim(`[${endpoints.registrySource}]`)}`);
    out(`    ${pad('abi', 18)}${c.dim(registryAbiSource())}`);
    try {
      const t = await totals({ registryAddress: endpoints.registryAddress, creditcoinRpc: endpoints.creditcoinRpc });
      out(`    ${pad('total mirrored', 18)}${c.bold(String(t.totalMirrored))}  ${c.dim('attestations')}`);
      out(`    ${pad('total revoked', 18)}${c.bold(String(t.totalRevoked))}`);
      out(`    ${pad('eas chainKey 1', 18)}${t.easAddress[1]}`);
      out(`    ${pad('eas chainKey 3', 18)}${t.easAddress[3]}`);
    } catch (err) {
      out(`    ${c.red('registry read failed: ' + (err as Error).message)}`);
    }
    out();
  }

  /* --- deployer balance --- */
  out(c.bold('  deployer'));
  out();
  const address = process.env.DEPLOYER_ADDRESS ?? (await signerAddress(endpoints.registryAddress, endpoints.creditcoinRpc));
  if (!address) {
    out(`    ${c.dim('no DEPLOYER_ADDRESS and no PRIVATE_KEY in the environment — balance not shown.')}`);
    out(`    ${c.dim('(read-only commands such as `verify` never need either.)')}`);
  } else {
    const provider = creditcoinProvider(endpoints.creditcoinRpc);
    try {
      const [balance, nonce] = await Promise.all([provider.getBalance(address), provider.getTransactionCount(address)]);
      out(`    ${pad('address', 18)}${address}`);
      out(`    ${pad('balance', 18)}${c.bold(formatEther(balance))} CTC`);
      out(`    ${pad('nonce', 18)}${nonce}`);
    } catch (err) {
      out(`    ${c.red('balance read failed: ' + (err as Error).message)}`);
    } finally {
      provider.destroy();
    }
  }
  out();
  return 0;
}

async function headOf(chainKey: ChainKey): Promise<number> {
  const provider = sourceProvider(chainKey);
  try {
    return await provider.getBlockNumber();
  } finally {
    provider.destroy();
  }
}

async function signerAddress(registryAddress: string, rpc: string): Promise<string | null> {
  if (!process.env.PRIVATE_KEY) return null;
  try {
    const handle = getRegistry({ registryAddress: registryAddress || undefined, creditcoinRpc: rpc });
    const addr = handle.signer ? await handle.signer.getAddress() : null;
    handle.provider.destroy();
    return addr;
  } catch {
    // No registry deployed yet — derive the address from the key alone.
    try {
      const { Wallet } = await import('ethers');
      return new Wallet(process.env.PRIVATE_KEY).address;
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */

function usage(): void {
  out();
  out(c.bold('admissible') + c.dim(' — Ethereum attestations, admissible on Creditcoin.'));
  out();
  out('  ' + c.bold('admissible verify <uid> [--chain 1|3]'));
  out(c.dim('      Read (chainKey, uid) from the Creditcoin registry, fetch the same UID'));
  out(c.dim('      from easscan, and print a field-by-field diff plus PASS/FAIL.'));
  out(c.dim('      Needs no API key, no .env and no local state.'));
  out();
  out('  ' + c.bold('admissible mirror <uid> [--chain 1|3] [--revoke]'));
  out(c.dim('      Prove the attesting Ethereum transaction and write it to Creditcoin.'));
  out(c.dim('      Prints all five live stages. Needs PRIVATE_KEY.'));
  out();
  out('  ' + c.bold('admissible status'));
  out(c.dim('      Attested source heights for chainKey 1 and 3, registry totals, balance.'));
  out();
  out(c.dim('  flags: --chain 1|3   --registry 0x…   --rpc <url>   --json'));
  out();
  out(c.dim(`  defaults: creditcoin ${CREDITCOIN_RPC}`));
  out(c.dim(`            prover     ${PROVER_URL}`));
  out();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || args.flags.help || args.command === 'help') {
    usage();
    process.exit(args.command ? 0 : 1);
  }

  let code = 0;
  switch (args.command) {
    case 'verify':
      code = await cmdVerify(args);
      break;
    case 'mirror':
      code = await cmdMirror(args);
      break;
    case 'status':
      code = await cmdStatus(args);
      break;
    default:
      process.stderr.write(c.red(`unknown command "${args.command}"`) + '\n');
      usage();
      code = 2;
  }
  process.exit(code);
}

main().catch((err: Error) => {
  process.stderr.write('\n' + c.red(`error: ${err.message}`) + '\n\n');
  process.exit(2);
});
