import { Link } from 'react-router-dom';
import Shell from '../components/Shell';
import Code from '../components/Code';

// The deployed CC3 testnet registry, frozen in SPEC.md §3 / contracts/deployments.json.
const REGISTRY_ADDRESS_DISPLAY = '0xA972422a821F622bcC1a72d0B19242F1ae2C6047';

const INSTALL = `pnpm add @admissible/sdk     # npm install / yarn add work too — it is a normal package`;

const CLI = `npx admissible verify <uid> [--chain 1|3]     # the judge's command
npx admissible mirror <uid> [--chain 1|3]     # mirror one attestation, live
npx admissible status                         # attested heights, registry, balance`;

const SOLIDITY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAdmissibleRegistry, MirroredAttestation} from "@admissible/contracts/IAdmissibleRegistry.sol";

contract CredentialGated {
    IAdmissibleRegistry public constant REGISTRY = IAdmissibleRegistry(${REGISTRY_ADDRESS_DISPLAY});

    bytes32 public constant KYC_SCHEMA     = 0x...;  // an EAS schema UID on Ethereum
    address public constant TRUSTED_ISSUER = 0x...;  // the attester you accept

    function borrow(bytes32 uid, uint256 amount) external {
        require(
            REGISTRY.isValidFrom(3, uid, TRUSTED_ISSUER, KYC_SCHEMA),
            "no valid Ethereum credential"
        );
        MirroredAttestation memory a = REGISTRY.attestationOf(3, uid);
        require(a.recipient == msg.sender, "credential is not yours");
        // ... lend
    }
}`;

const TS_MIRROR = `import { mirror } from '@admissible/sdk';

const result = await mirror('0x<EAS_UID>', 3, {
  onProgress: (p) => {
    switch (p.stage) {
      case 'resolving':
        console.log('resolving UID → Ethereum transaction'); break;
      case 'awaiting-attestation':
        console.log(\`attested height \${p.attestedHeight} / need \${p.targetBlock}\`); break;
      case 'building-proof':
        console.log(\`proof: \${p.continuityRoots} roots, \${p.merkleSiblings} siblings\`); break;
      case 'submitting':
        console.log('BlockProver 0x…0FD2 verifying'); break;
      case 'mirrored':
        console.log(\`done: \${p.creditcoinTxHash}\`); break;
      case 'failed':
        console.error(p.error); break;
    }
  }
});`;

const TS_SCHEMA = `import { mirrorSchema } from '@admissible/sdk';

const r = await mirrorSchema('0x<SCHEMA_UID>', 1, {
  limit: 200,
  onBatchProgress: (p) =>
    console.log(\`batch \${p.batchIndex + 1}/\${p.batchCount}: \${p.stage}\`)
});

console.log(\`\${r.attestations} attestations in \${r.transactions} transactions\`);`;

const TS_READ = `import { resolve, isValid } from '@admissible/sdk';

const a = await resolve(3, '0x<EAS_UID>');
if (a.exists && !a.revoked) {
  console.log(\`attested by \${a.attester} in Ethereum block \${a.sourceBlock}\`);
}`;

const TS_VERIFY = `import { verify } from '@admissible/sdk';

const r = await verify('0x<EAS_UID>');
for (const row of r.rows) {
  console.log(\`\${row.match ? 'ok  ' : 'FAIL'} \${row.field}: \${row.registry} / \${row.easscan}\`);
}
console.log(r.outcome);`;

export default function Sdk() {
  return (
    <Shell>
      <section className="page">
        <div className="page-head">
          <span className="eyebrow">SDK</span>
          <h1 className="page-title">Build against it.</h1>
          <p className="page-lede">
            <code className="mono">@admissible/sdk</code> is a functional API over{' '}
            <code className="mono">@gluwa/usc-sdk@0.18.0</code> and ethers v6. There is no client to construct;
            every function takes its configuration as an optional last argument and falls back to public
            defaults — <code className="mono">resolve</code>, <code className="mono">verify</code>,{' '}
            <code className="mono">isValid</code> and the <code className="mono">eas</code> helpers work with no
            <code className="mono">.env</code>, no API key and no local state. Full reference:{' '}
            <Link to="/docs/sdk">docs/sdk</Link>.
          </p>
        </div>

        <div className="section">
          <h2 className="section-title">Install</h2>
          <Code lang="bash">{INSTALL}</Code>
          <p className="section-note">
            Peer dependency: <code className="mono">ethers@^6.15.0</code>. Do not add viem alongside it —{' '}
            <code className="mono">@gluwa/usc-sdk</code> has a hard dependency on ethers v6.
          </p>
        </div>

        <div className="section">
          <h2 className="section-title">Consume the registry from Solidity</h2>
          <p className="section-note">
            The registry is the durable artifact. This is the whole integration cost for a Creditcoin dApp — no
            Attestcoin types, no proof handling, no worker.
          </p>
          <Code lang="solidity" label="CredentialGated.sol">
            {SOLIDITY}
          </Code>
          <p className="section-note">
            <code className="mono">isValidFrom</code> returns true only if the attestation is mirrored, not
            revoked, and its attester and schema match. The <code className="mono">recipient</code> check is
            separate and necessary — UIDs are public, so without it a borrower could present a stranger&rsquo;s
            credential. If the attestation is later revoked on Ethereum and that revocation is mirrored, this
            call starts returning false with no redeployment. See <Link to="/revocation">revocation</Link>.
          </p>
        </div>

        <div className="section">
          <h2 className="section-title">Mirror one attestation, with live progress</h2>
          <Code lang="ts" label="mirror(uid, chainKey, opts)">
            {TS_MIRROR}
          </Code>
          <p className="section-note">
            This callback is what the <Link to="/app">proof theatre</Link> renders — the five stage names are
            frozen in the interface, so the web app and any script consuming <code className="mono">mirror()</code>{' '}
            stay in sync.
          </p>
        </div>

        <div className="section">
          <h2 className="section-title">Mirror an entire schema</h2>
          <Code lang="ts" label="mirrorSchema(schemaUid, chainKey, opts)">
            {TS_SCHEMA}
          </Code>
          <p className="section-note">
            Groups by source transaction first, then batches — at most 10 transactions per submission, within a
            1000-block span. One <code className="mono">multiAttest</code> transaction is a single query carrying
            many attestations, so report the pair as &ldquo;N attestations in M on-chain submissions&rdquo; rather
            than conflating them. See it live on <Link to="/batch">/batch</Link>.
          </p>
        </div>

        <div className="section">
          <h2 className="section-title">Read the registry</h2>
          <Code lang="ts" label="resolve / isValid">
            {TS_READ}
          </Code>
          <p className="section-note">
            <code className="mono">resolve</code> always returns a record — check{' '}
            <code className="mono">exists</code> before trusting any other field, since an unmirrored UID returns
            a zeroed struct. <code className="mono">resolveOrNull</code> returns <code className="mono">null</code>{' '}
            instead. See it live on <Link to="/registry">/registry</Link>.
          </p>
        </div>

        <div className="section">
          <h2 className="section-title">Verify, independently</h2>
          <Code lang="ts" label="verify(uid)">
            {TS_VERIFY}
          </Code>
          <p className="section-note">
            The two sides are genuinely independent: one is Creditcoin state written through an Attestcoin proof,
            the other is an Ethereum indexer with no relationship to this project. Try it on{' '}
            <Link to="/verify">/verify</Link>, or from the CLI, below.
          </p>
        </div>

        <div className="section">
          <h2 className="section-title">CLI</h2>
          <Code lang="bash">{CLI}</Code>
          <p className="section-note">
            <code className="mono">verify</code> and <code className="mono">status</code> need no API key, no{' '}
            <code className="mono">.env</code> and no local state — every endpoint defaults to a public one.{' '}
            <code className="mono">mirror</code> needs <code className="mono">PRIVATE_KEY</code> and testnet CTC.
            Every command accepts an <code className="mono">easscan.org/attestation/view/0x…</code> URL in place
            of a bare UID.
          </p>
        </div>
      </section>
    </Shell>
  );
}
