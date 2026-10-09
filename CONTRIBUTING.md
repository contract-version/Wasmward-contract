# Contributing

This repository is a test fixture for [Wasmward](https://github.com/contract-version/Wasmward-backend): a tiny upgradeable contract, the scripts that deploy and look after it on Stellar testnet, and CI. Keep it small.

## Run every check before you push

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

The deployed fixture on testnet has fixed Wasm hashes, and the other Wasmward repositories pin them (`fixture.wasmward.json` here; the frontend's `src/main.js` and `wasmward.json`; the backend's README example and recorded responses). So:

- **Tests, scripts, docs and CI can change freely.** Comments and lint settings do not change the Wasm either. To check rather than assume, build before and after with the same toolchain and compare: `node scripts/wasm-info.mjs before.wasm after.wasm` exits 0 only if they are the same Wasm. (Compare builds from one toolchain: another compiler or the Stellar CLI gives another hash for the same source, see [docs/HASH-PROVENANCE.md](docs/HASH-PROVENANCE.md).)
- **Anything that changes behaviour changes the hash,** and then the fixture has to be redeployed (`scripts/deploy.sh`), the config rewritten (`node scripts/sync-config.mjs`) and the other repositories updated. Say so in the pull request.
- `v1` and `v2` must keep different hashes. CI fails if they are equal.
- Do not use this contract as a template. It has one admin and no safeguards beyond that.

## Tests

- Soroban test snapshots under `contracts/fixture/test_snapshots` are committed. Add the new ones with the test that produced them.
- A test that expects a panic should name the error it expects (`#[should_panic(expected = "Error(Auth, InvalidAction)")]`), so it cannot pass because of an unrelated failure.
- Scripts that spend money or reach the network (`extend.sh`) are tested against a stand-in `stellar` or a local server, never against testnet. Run the real thing by hand.

## Commits

Small and conventional (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`), one idea each, with the tests for it.
