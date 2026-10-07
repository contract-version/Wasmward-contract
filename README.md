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

Prerequisites: Rust with the `wasm32v1-none` target, the [Stellar CLI](https://developers.stellar.org/docs/tools/cli),.

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

## Tests

```bash
cargo test                  # v1 build
cargo test --features v2    # v2 build
```

## Pinned versions

`soroban-sdk` is pinned to `=26.1.1`, the version the Stellar CLI 27 template uses. Testnet runs protocol 29; contracts built with an older SDK keep running on a newer protocol.

## License

Apache-2.0
