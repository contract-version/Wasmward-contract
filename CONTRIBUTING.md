# Contributing

This repository is a test fixture for [Wasmward](https://github.com/contract-version/Wasmward-backend): a tiny upgradeable contract, the scripts that deploy and look after it on Stellar testnet, and CI. Keep it small. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is a map of what is where.

## Run every check before you push

Not sure what you have installed? `node scripts/doctor.mjs` lists what is missing and how to get it.

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo clippy --all-targets --locked --features v2 -- -D warnings
cargo test --locked
cargo test --locked --features v2

for script in scripts/*.sh; do bash -n "$script"; done
node --test scripts/*.test.mjs
```

If you touched the contract, also run the tests that upgrade the compiled Wasm (they are ignored in a plain `cargo test`; the commands are under "Tests" in the [README](README.md)).

That is what [CI](.github/workflows/ci.yml) runs. The scripts need only Node 18 or newer and have no dependencies; please keep it that way.

## Changing the contract

The deployed fixture on testnet has fixed Wasm hashes, and the other Wasmward repositories pin them (`fixture.wasmward.json` here; the frontend's `src/demo-config.js` and `wasmward.json`; the backend's README example and recorded responses). So:

- **Tests, scripts, docs and CI can change freely.** So can comments and lint settings, with one check: run `bash scripts/verify-hashes.sh`. It rebuilds v1 and v2 with the Stellar CLI, as `scripts/deploy.sh` does, and exits 0 only if both have the hashes pinned in `fixture.wasmward.json`. Use that and not `cargo build`: a plain cargo build keeps the file path and line of the panic in `upgrade`, so a comment above it changes that hash and so does building on Windows instead of Linux, while the Stellar CLI's build does not (measured, see [docs/HASH-PROVENANCE.md](docs/HASH-PROVENANCE.md)).
- **Anything that changes behaviour changes the hash,** and then the fixture has to be redeployed (`scripts/deploy.sh`), the config rewritten (`node scripts/sync-config.mjs`) and the other repositories updated. Say so in the pull request.
- `v1` and `v2` must keep different hashes. CI fails if they are equal.
- Do not use this contract as a template. It has one admin and no safeguards beyond that.

## Tests

- Soroban test snapshots under `contracts/fixture/test_snapshots` are committed. Add the new ones with the test that produced them.
- A test that expects a panic should name the error it expects (`#[should_panic(expected = "Error(Auth, InvalidAction)")]`), so it cannot pass because of an unrelated failure.
- Scripts that spend money or reach the network (`extend.sh`) are tested against a stand-in `stellar` or a local server, never against testnet. Run the real thing by hand.

## Commits

Small and conventional (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`), one idea each, with the tests for it.
