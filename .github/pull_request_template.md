## What changed, and why

## Does it change the Wasm?

- [ ] No: tests, scripts, docs or CI only (a comment or a lint setting does not change it either)
- [ ] Yes: the fixture has to be redeployed, `fixture.wasmward.json` rewritten and the other Wasmward repositories updated. I say so here and list them.

To check rather than assume, run `bash scripts/verify-hashes.sh`: it rebuilds v1 and v2 with the Stellar CLI and exits 0 only if both still have the hashes pinned in `fixture.wasmward.json`.

## How you checked it

- [ ] `cargo fmt --all -- --check`, clippy for v1 and v2, and `cargo test` for v1 and v2 pass (the commands are in CONTRIBUTING.md)
- [ ] `node --test scripts/*.test.mjs` passes
- [ ] A script change has a test that failed before the change
- [ ] Nothing here prints, logs or commits a secret key
