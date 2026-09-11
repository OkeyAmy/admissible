# Contributing

Admissible is MIT licensed. Issues and pull requests are welcome.

## Setup

```bash
pnpm install
cp .env.example .env     # PRIVATE_KEY is testnet only
forge build && forge test
```

Node 22+, pnpm 11, Foundry 1.7.1, Solidity `^0.8.28`.

**Use pnpm, not npm.** The workspace is defined by `pnpm-workspace.yaml` — there is no
`workspaces` field in `package.json` — `packageManager` is pinned to `pnpm@11.18.0`, and
`pnpm-lock.yaml` is the committed lockfile. Running `npm install` resurrects a
`package-lock.json` and fights it.

```bash
pnpm install                 # install everything
pnpm add -F web <dep>        # add a dependency to one workspace package
pnpm -r build                # build every package
pnpm -F web dev              # run the web app
pnpm -F bench bench          # run the volume bench
pnpm -F worker start         # run the mirror worker
```

Two settings that look strange and are deliberate:

- **`.npmrc` sets `node-linker=hoisted`.** `foundry.toml` remaps
  `@gluwa/asc-contracts/=node_modules/@gluwa/asc-contracts/`, so Foundry needs a flat,
  npm-like `node_modules` layout to resolve the organizer's contracts. Do not remove it.
- **Build-script allowlists live in `pnpm-workspace.yaml`** under `onlyBuiltDependencies`,
  not in `package.json` — pnpm 11 no longer reads the `pnpm` field there. `esbuild` is
  allowlisted because Vite needs it.

Two `foundry.toml` settings that also look strange and are also deliberate:

- **`via_ir = true`.** The registry's `submit` entrypoint forwards a full Attestcoin proof
  bundle — nine arguments, three of them dynamic — into the inherited `ASCBase.execute`.
  Legacy codegen runs out of stack slots doing that; `via_ir` is the compiler's own
  recommended fix, and it keeps the entrypoint signature readable instead of forcing a
  struct-wrapping workaround.
- **`evm_version = "london"`.** CC3 is a Substrate/Frontier EVM. Its block headers carry no
  `mixHash`/`prevrandao`, so targeting a post-merge EVM version makes Foundry's local header
  validation fail during simulation. `london` also keeps `PUSH0`, `MCOPY` and `TSTORE` out
  of the compiled bytecode, which Frontier-based chains do not universally implement.

Dependencies are pinned —
`@gluwa/asc-contracts@0.2.1` and `@gluwa/usc-sdk@0.18.0` — because the Attestcoin
readability spec is still moving. Do not float them without a reason in the PR
description.

`@gluwa/usc-sdk` has a hard peer dependency on **ethers v6**. Do not add viem alongside
it.

## House rules

These are not style preferences; each one exists because getting it wrong produces a
silent, wrong result.

1. **Never key attestation state on `uid` alone.** Always `(chainKey, uid)`. Mainnet and
   Sepolia are different EAS deployments with independent UID spaces.
2. **Always check `receipt.receiptStatus == 1`.** The BlockProver precompile proves
   inclusion, not success. A reverted transaction produces a perfectly valid proof.
3. **Always assert the log emitter** against `easAddress[chainKey]`. `Attested` is a
   common event that anyone can emit from a contract they control.
4. **Always loop every matching log.** `ASCBase` dedupes per
   `(chainKey, blockHeight, txIndex)`, so one `multiAttest` transaction carries many
   attestations and the query can never be replayed to pick up the ones you skipped.
5. **Treat `BlockNotOnSourceChain` as retryable.** It means *too recent*, not *wrong*.
6. **Say "Attestcoin Protocol", not "USC"**, except where `usc-sdk` is the literal package
   name.

## Evidence discipline

This project's claims are meant to be checkable, and the documentation is held to the
same standard as the code.

- **Numbers, not adjectives.** Never write "fast", "reliable", or "seamless" in code
  comments, docs, or commit messages. Write counts and percentiles.
- **Never invent a figure.** If a number is not yet measured, leave a marker containing
  the literal string `FILL:` naming the file it should come from. `TBD` is the visible
  placeholder token.
- **Log failures.** `receipts/mirrors.jsonl` records one line per attempt, including
  failures. Do not filter them out.
- **Keep proof generation and on-chain submission as separate fields.** They have
  different cost profiles and different failure modes.
- **Do not conflate attestation count with submission count.** Report *"N attestations in
  M on-chain submissions"*.

## Tests

Foundry tests use fixtures captured from **real** Attestcoin proofs rather than synthetic
bytes. If you add a decoding path, add a fixture from a real transaction on chainKey 1 or
3. A decoder test that passes only against bytes you constructed yourself proves very
little.

```bash
forge test                        # 78 tests across 3 suites (41 registry, 23 pool, 14 EASReader)
pnpm -r test --if-present
```

If you touch either security guard, re-run the mutation check documented in
`contracts/MUTATION-CHECK.md`: comment out the two `require`s, confirm **exactly 6** of the
41 `AttestationRegistry.t.sol` tests fail, restore them, confirm 41/41 (78/78 overall). A
guard whose removal breaks no test is untested.

## Documentation

`docs/*.md` is rendered on the website as well as read in the repo, so keep it portable:
one `#` H1 per file, clean `##`/`###` nesting for the sidebar and table of contents,
language-tagged code fences, and relative links between doc pages by bare filename. No
GitHub-specific syntax.

`docs/attestcoin-integration.md` is the primary technical document. If you change how the
project uses the Attestcoin Protocol, change that file in the same PR.

## Security

The emitter assertion is the security core of this design. If you find a way to write an
entry into the registry that does not correspond to a real EAS attestation on the source
chain, please open an issue — that is the bug that matters most.
