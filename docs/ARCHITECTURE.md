# How this repository fits together

This repository is the test fixture for [Wasmward](https://github.com/contract-version/Wasmward-backend): a tiny contract that can be upgraded in place, deployed on Stellar testnet, and the scripts and workflows that deploy it, look after it and check that nothing about it has changed. Three repositories depend on it (see the end), so most of what is here exists to keep two things true: **the deployed contract is alive, and its Wasm hashes are the ones everyone has pinned.**

## The contract

| Path | What it is |
|---|---|
| `contracts/fixture/src/lib.rs` | The contract: `__constructor(admin)`, `version()` (1, or 2 with the `v2` feature) and `upgrade(new_wasm_hash)`, admin only. |
| `contracts/fixture/src/test.rs` | Native tests: the admin is recorded, an upgrade needs the admin's authorization, deployments keep their own admins. |
| `contracts/fixture/tests/upgrade.rs` | Opt-in tests that run the **compiled Wasm** through an upgrade, v1 to v2 and back. They need the two files, so a plain `cargo test` lists them as ignored. |
| `rust-toolchain.toml` | The Rust compiler, pinned, because the hash depends on it. |
| `Cargo.toml`, `Cargo.lock` | The workspace, the exact `soroban-sdk` pin and the release profile. Changing any of them can change the hash. |

Do not change what the contract does: the deployed hashes are pinned in three repositories. [CONTRIBUTING.md](../CONTRIBUTING.md) says what can change freely and how to check.

## The scripts

All in `scripts/`, Node 18 or newer, no dependencies. Each command prints its description, options and exit codes for `--help`.

**Look after the deployed fixture**

| Script | What it does |
|---|---|
| `scripts/deploy.sh` | Builds v1 and v2, checks them for build-machine paths, uploads both, checks the on-chain hashes, deploys v1, writes `testnet.json`. |
| `scripts/extend.sh` | Extends the lifetime of the instance and of both builds' Wasm code. |
| `scripts/sync-config.mjs` | Rewrites `fixture.wasmward.json` from `testnet.json` after a redeploy. |
| `scripts/fixture-status.mjs` | Which build is live and how long everything has left, in one command. |
| `scripts/live-build.mjs` | Which build each contract runs now. |
| `scripts/check-lifetimes.mjs` | How long the instance and each build's Wasm code have left. |

**Check the builds**

| Script | What it does |
|---|---|
| `scripts/verify-hashes.sh` | Rebuilds with the Stellar CLI and checks the hashes are the pinned ones. |
| `scripts/check-builds.mjs` | v1 and v2 differ only in their code, and export exactly the contract's three functions. |
| `scripts/wasm-paths.mjs` | No path from the building machine inside a Wasm. |
| `scripts/wasm-info.mjs` | Describes a Wasm, or compares two, and can read a deployed one from the network. |
| `scripts/doctor.mjs` | Whether this machine has what the checks need. |

**Building blocks** (modules without a command line): `scripts/rpc.mjs`, `scripts/cli-options.mjs`, `scripts/help.mjs`, `scripts/strkey.mjs`, `scripts/ledger-keys.mjs`, `scripts/instance-entry.mjs`, `scripts/leb128.mjs`, `scripts/wasm-code.mjs`, `scripts/wasm-exports.mjs`, `scripts/wasm-strings.mjs`, `scripts/wasm-sections.mjs` and `scripts/wasm-compare.mjs`. Read the top of each for what it parses and how it was checked against what testnet returned.

Every script has a `*.test.mjs` next to it. Scripts that would spend money or touch the network are tested against stand-ins (a fake `stellar`, a local HTTP server), never against testnet. Some test files test the repository itself rather than one script: `scripts/architecture.test.mjs`, `scripts/cargo.test.mjs`, `scripts/config.test.mjs`, `scripts/dependabot.test.mjs`, `scripts/files.test.mjs`, `scripts/flags.test.mjs`, `scripts/help-all.test.mjs`, `scripts/license.test.mjs`, `scripts/links.test.mjs`, `scripts/readme.test.mjs`, `scripts/secrets.test.mjs`, `scripts/security-doc.test.mjs`, `scripts/siblings.test.mjs`, `scripts/templates.test.mjs`, `scripts/toolchain.test.mjs` and `scripts/workflows.test.mjs`. Between them they hold the documentation, the workflows, the build settings, the toolchain pin, the file formats and the secrecy promises to what they say.

## The workflows

| Workflow | When | What |
|---|---|---|
| `.github/workflows/ci.yml` | every push and pull request | fmt, clippy, tests for v1 and v2, builds both Wasm, runs the upgrade tests on them, checks v1 and v2 are a clean pair; then the script tests on Node 18, 20 and 22, and shellcheck. |
| `.github/workflows/fixture-health.yml` | every Monday, or by hand | Uses Wasmward itself on the live fixture, then `fixture-status.mjs`. Red means: see [RECOVERY.md](RECOVERY.md). |
| `.github/workflows/reproducibility.yml` | monthly, or by hand | Installs the Stellar CLI and checks that a Linux build with the pinned compiler gives the deployed hashes. |

## How a change moves through

```text
deploy.sh ──► testnet.json (local, git-ignored) ──► sync-config.mjs ──► fixture.wasmward.json
                                                                              │
              ┌───────────────────────────────────────────────────────────────┤
              ▼                                                               ▼
   fixture-health.yml (Wasmward action,                   Wasmward-frontend: src/demo-config.js, wasmward.json
   fixture-status.mjs)                                    Wasmward-backend: README example, recorded responses
```

## The other repositories

- [Wasmward-backend](https://github.com/contract-version/Wasmward-backend), the library and command line tool, uses the deployed fixture in its README example, its integration tests and its recorded testnet responses, and publishes the JSON Schema that `fixture.wasmward.json` points at.
- [Wasmward-frontend](https://github.com/contract-version/Wasmward-frontend), a browser demo, watches the fixture and shows what the guard says about it.

`scripts/siblings.test.mjs` checks, when those repositories are checked out next to this one, that they still hold this contract ID and these hashes.
