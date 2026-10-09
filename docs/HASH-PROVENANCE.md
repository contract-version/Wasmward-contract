# Why the same source has more than one Wasm hash

Wasmward compares the hash of the Wasm a contract is **running** with the hashes an app supports. This
fixture shows why that hash has to come from the deployed artifact, and never from rebuilding the source.

The same source, built three ways, gives three different Wasm files. These are measured, not estimated:

| Build | Size | SHA-256 | Rust compiler | Stellar CLI |
|---|---|---|---|---|
| `cargo build --release --target wasm32v1-none`, on the maintainer's machine | 4801 bytes | `1209a8d6…` | 1.96.1 | none |
| the same command, on a GitHub Actions runner | 4788 bytes | `420d8cd6…` | 1.99.0 | none |
| `stellar contract build`, then uploaded: **the deployed v1** | 1204 bytes | `a7a82511…` | 1.96.1 | 27.0.0 |

(The CI row is from one run; the runner uses whatever stable Rust it has when the job runs, so a later run can
differ again. Every CI run prints its hashes in the job summary and keeps the Wasm as an artifact.)

## What differs, and why

[`scripts/wasm-info.mjs`](../scripts/wasm-info.mjs) reads the metadata and the sections that Soroban puts in
every contract, so these are findings, not guesses.

**The compiler version.** Every Soroban Wasm records the Rust compiler that built it (`rsver`) and the SDK
(`rssdkver`). Comparing the local and the CI build:

```text
compiler  A 1.96.1, B 1.99.0
sdk       same (26.1.1#8ac18efb681a1c0b4b85a38c5a380300344e3f39)
section   code: A 3804, B 3834
They were built with different tools: compiler differ.
```

Same source, same SDK, different compiler: different code, different hash.

**The Stellar CLI optimizes the file.** The deployed v1 was built with `stellar contract build`, which
post-processes the Wasm and records its own version in a second metadata section (`cliver`). Comparing the
local cargo build with the deployed one:

```text
size      A 4801 bytes, B 1204 bytes
compiler  same (1.96.1)
cli       A (none), B 27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4
section   code: A 3804, B 352
only in A table, element
Only B carries a cliver entry, so only B was processed by the Stellar CLI, and its code section differs.
```

Even with the same compiler and SDK, the optimized file is a quarter of the size and has different sections.

**v1 and v2 differ in one section only.** Both deployed builds have the same size, the same tools and the same
interface; only the code section has different content. That is the one `version()` constant:

```text
section   code: same size (352), different content
The recorded tools are the same but the code differs, so the source (or an unrecorded build setting) is different.
```

## What to do about it

- **Hash the artifact you deploy.** `scripts/deploy.sh` hashes the files it builds, uploads them, and refuses to
  continue if the hash the network reports is not the one it computed. `testnet.json` and
  `fixture.wasmward.json` hold those hashes.
- **To see what is on the network:** `node scripts/wasm-info.mjs deployed:<hash>` reads the Wasm of that hash from
  the RPC and shows it. It refuses code whose SHA-256 is not the hash you asked for.
- **To save it:** `node scripts/wasm-info.mjs deployed:<hash> --out deployed.wasm`.
- **To ask "is my build the deployed one?":** `node scripts/wasm-info.mjs build/v1/wasmward_fixture.wasm deployed:<hash>`.
  Like `diff`, it exits 0 if they are the same Wasm, 1 if not, and says how they differ.
- **Do not put a hash in a supported list because a rebuild produced it.** A rebuild on another machine, with
  another compiler, or another Stellar CLI, gives another hash. Put in the hash of the Wasm that is, or will be,
  running on the network.

## Reading the metadata yourself

`wasm-info` has no dependencies, so it works wherever Node 18 runs. The pieces it reads are documented at the top
of [`wasm-sections.mjs`](../scripts/wasm-sections.mjs) (the Wasm sections and the `contractmetav0`,
`contractenvmetav0` and `contractspecv0` custom sections) and [`wasm-code.mjs`](../scripts/wasm-code.mjs) (how a
contract's code is stored in a ledger entry). Both are tested against the real code entries recorded from
testnet in [`scripts/fixtures`](../scripts/fixtures).
