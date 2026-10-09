# Wasmward fixture contract

A tiny upgradeable Soroban contract used to test [Wasmward](https://github.com/contract-version/Wasmward-backend), a runtime guard that blocks writes to a contract whose live Wasm hash is not on your supported list. It exists so Wasmward can be tested against a real upgrade on Stellar testnet.

It is a test fixture, not a template for production contracts.

## What it does

One crate, two builds selected by the Cargo feature `v2`:

| Function | Behaviour |
|---|---|
| `__constructor(admin)` | Stores the admin address at deploy time. |
| `version() -> u32` | Returns `1` for the default build and `2` for the `v2` build. |
| `upgrade(new_wasm_hash)` | Admin only. Replaces the contract's Wasm with an already uploaded one. |

The two builds have different Wasm hashes, which is what Wasmward detects.

## Use

Prerequisites: Rust with the `wasm32v1-none` target (`rustup target add wasm32v1-none`), the [Stellar CLI](https://developers.stellar.org/docs/tools/cli), and Node.js 18 or newer for the helper scripts.

```bash
cp .env.example .env      # optional: leave FIXTURE_SECRET empty to generate a testnet identity
bash scripts/deploy.sh
```

The script:

1. Imports the identity from `FIXTURE_SECRET`, or generates a fresh testnet one and saves its secret to `.env`.
2. Funds it through friendbot.
3. Builds v1 and v2 into `build/v1` and `build/v2`.
4. Uploads both and **fails if a locally computed SHA-256 differs from the hash Stellar returns**.
5. Deploys v1 with the identity as admin.
6. Writes `testnet.json` with the contract ID and both hashes. It holds public values only.

`.env`, `.stellar-keys/`, `testnet.json` and `build/` are git-ignored.

Then, from the `Wasmward-backend` checkout next to this one:

```bash
pnpm test:integration
```

The integration test upgrades the contract to v2, checks that Wasmward blocks writes, then upgrades it back to v1 so it can be run again. Set `WASMWARD_FIXTURE_DIR` if this repository is somewhere else.

## Keeping it alive

Testnet contracts expire after about a week, and an expired fixture breaks anything that points at it (the Wasmward README example, the browser demo, the integration tests). `wasmward check` shows how long the contract has left: the sooner of its instance and its Wasm code, which expire separately. To extend the instance and the Wasm code of both builds:

```bash
bash scripts/extend.sh            # about 29 days; pass a number of ledgers to change it
```

It needs `testnet.json` and the identity that `scripts/deploy.sh` created.

A weekly workflow, [`fixture-health.yml`](.github/workflows/fixture-health.yml), runs [Wasmward](https://github.com/contract-version/Wasmward-backend) against the live fixture using [`fixture.wasmward.json`](fixture.wasmward.json) and `check --min-ttl-days 3`. It then runs [`scripts/check-lifetimes.mjs`](scripts/check-lifetimes.mjs), which reads the Wasm code entry of every build in that file, including v2, the build the upgrade tests move to and that Wasmward cannot see while it is not live (`node scripts/check-lifetimes.mjs --min-days 3` does the same by hand; it needs only Node 18 or newer; add `--json` for one machine-readable report, with the same exit codes: 0 fine, 1 a build is missing or too close to expiring, 2 the config or RPC could not be used). A red run means the fixture is missing, unsupported, unreachable or has under three days left: run `scripts/extend.sh`, or `scripts/deploy.sh` if it has gone. After a redeploy, run `node scripts/sync-config.mjs` to rewrite `fixture.wasmward.json` from the new `testnet.json` (`--check` only reports whether it is stale), then update the contract ID and hashes that the Wasmward repositories also keep (`src/main.js` and `wasmward.json` in the frontend; the example in the backend README and the recorded testnet responses in its `test/fixtures/recorded`).

## Scripts

| Script | What it does | Needs |
|---|---|---|
| `scripts/deploy.sh` | Builds v1 and v2, uploads both, checks the on-chain hashes against the local ones, deploys v1, writes `testnet.json`. | Stellar CLI, a funded testnet identity (it creates one) |
| `scripts/extend.sh [--dry-run] [ledgers]` | Extends the lifetime of the instance and of both Wasm code entries. `--dry-run` prints the three commands and runs none. | `testnet.json`; for a real run, the Stellar CLI and the identity |
| `scripts/check-lifetimes.mjs` | Reads the lifetime of the instance and of every supported build's Wasm code straight from the RPC, with `--min-days`, `--json`, `--rpc-url`, `--timeout-ms`. | Node 18+ |
| `scripts/sync-config.mjs [--check]` | Rewrites `fixture.wasmward.json` from `testnet.json` after a redeploy. | Node 18+ |

`scripts/strkey.mjs` and `scripts/ledger-keys.mjs` are what `check-lifetimes.mjs` is built on (a contract address decoder and the two ledger keys); they have no command line. Every script has tests next to it (`node --test scripts/*.test.mjs`), and the ones that would spend money or touch the network are tested against stand-ins.

## CI

[`ci.yml`](.github/workflows/ci.yml) runs on every push and pull request: `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test` for both the v1 and v2 builds, then builds both Wasm variants and fails if their hashes are equal. A second job tests the lifetime script (`node --test scripts/check-lifetimes.test.mjs`) offline.

## Tests

```bash
cargo test                  # v1 build
cargo test --features v2    # v2 build
```

## Pinned versions

`soroban-sdk` is pinned to `=26.1.1`, the version the Stellar CLI 27 template uses. Testnet runs protocol 29; contracts built with an older SDK keep running on a newer protocol.

## License

Apache-2.0
