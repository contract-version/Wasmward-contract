# Changelog

This repository is a test fixture and has no releases. The fixture on testnet changes only when it is redeployed, and
that is listed here. Everything else is listed under "Unreleased", newest first, grouped by what a contributor would
notice. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### The deployed fixture

Not redeployed since it was first deployed on 2026-10-07. Contract ID `CBR5ZFDI…DYPDPV`, v1 `a7a82511…` (the live
build) and v2 `ec040ead…`. It was last extended on 2026-10-08 and expires about 29 days after that unless
`scripts/extend.sh` is run again.

### Build

- The Rust compiler is pinned to 1.96.1 in `rust-toolchain.toml`. Measured: with it and Stellar CLI 27.0.0 the deployed hashes
  reproduce on Windows and on a Linux runner; with 1.99.0 they do not.
- Doc comments and other source edits above the panic in `upgrade` change the hash of a plain `cargo build` (it keeps the
  file path and line), but not of the Stellar CLI build that `deploy.sh` uses. CONTRIBUTING said comments never change the
  Wasm; it now says what is true and points at `scripts/verify-hashes.sh`.

### Scripts

- `scripts/verify-hashes.sh`: does this working tree still build the deployed fixture? Rebuilds with the Stellar CLI and compares.
- `scripts/fixture-status.mjs`, `scripts/live-build.mjs`: which build is live, and how long everything has left, in one command.
- `scripts/check-builds.mjs` also pins the exported interface (`__constructor`, `upgrade`, `version`) of both builds.
- `scripts/wasm-paths.mjs`, and `deploy.sh` runs it first: a build that carries a path from the building machine is not uploaded.
- `scripts/doctor.mjs`: what a contributor still has to install, including the compiler version that reproduces the hashes.
- `--help` on every Node script, taken from the comment at the top of the script.
- `wasm-info` shows the exported functions, and comparing two modules names functions only one has.
- Earlier: `check-lifetimes.mjs` (instance and every build's Wasm code), `extend.sh --dry-run`, `sync-config.mjs`, `wasm-info.mjs`
  (including `deployed:<hash>` read from the network), `check-builds.mjs`.

### Workflows

- Weekly fixture health: Wasmward on the live fixture, then `fixture-status.mjs` with `--expect v1`, written to the job summary.
- Monthly and by-hand reproducibility check: the pinned compiler must reproduce the deployed hashes, and the runner's stable
  one only reports.
- CI: shellcheck on the shell scripts; Node 18, 20 and 22; the upgrade tests on the Wasm CI just built.
- Time limits on every job, read-only token permissions, actions pinned to a major version, dependabot for the actions only
  (not for Cargo, which would change the hash).

### Tests and documentation

- Tests that hold the repository to what it says: no secret seed in any tracked file and the identity files git-ignored; the
  workflows' permissions and pins; the build settings that fix the hash; the toolchain pin agreeing everywhere it is written;
  every relative link and anchor; every option the docs show after a script; the README listing every script; the config and
  `.env.example`; LF line endings; SECURITY.md's promises; the license; and, when the sibling repositories are checked out,
  that they still hold this contract ID and these hashes.
- Guides: `docs/ARCHITECTURE.md` (a map), `docs/RECOVERY.md` (expired, on the wrong build, must be redeployed) and
  `docs/HASH-PROVENANCE.md` (why one source has several hashes, with the measurements).
- Issue forms, a pull request template and a security policy.
- A stand-in secret in a test was a valid-checksum Stellar seed. It is now an obvious fake; the account never existed on
  testnet or mainnet, but the old value stays in the git history.

### The contract

Unchanged. Its behaviour must not change: three repositories pin the Wasm hashes. Rust tests cover the admin, the
authorization of `upgrade` and the version, and opt-in tests run the compiled Wasm through an upgrade and back.
