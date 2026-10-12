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

## The source location is in a plain `cargo` build, and not in the Stellar CLI's

A third cause, found by changing the source and rebuilding (2026-10-12, Windows, Stellar CLI 27.0.0, rustc 1.96.1).
`contracts/fixture/src/lib.rs` has one panic, the `.expect("admin not set")` in `upgrade`. A plain
`cargo build --release` keeps where that panic is in the data section: the string `contracts\fixture\src\lib.rs`
(with backslashes when built on Windows) and the line and column.

| Source | `cargo build --release --target wasm32v1-none` | `stellar contract build --locked` |
|---|---|---|
| as committed | 4801 bytes, `1209a8d6…` | 1307 bytes, optimized to 1204: **`a7a82511…`**, the deployed v1 |
| one line added at the top of the file | 4801 bytes, `da413449…` | 1204 bytes, **`a7a82511…`**, unchanged |
| a comment added after the `.expect` line | `1209a8d6…`, unchanged | not tried |

So for a plain cargo build, a comment or a doc line **above** the panic changes the hash, and a build on Linux
gives another one than a build on Windows, because the path is in it. The Stellar CLI's build runs the Wasm
optimizer, which drops that information, and it reproduces the deployed hashes from this repository's source. The
v2 build was rebuilt the same way and gives `ec040ead…`, the deployed v2.

That is why [`scripts/verify-hashes.sh`](../scripts/verify-hashes.sh) rebuilds with the Stellar CLI and compares with
`fixture.wasmward.json`, and why the hashes CI prints for its `cargo build` are not expected to match them. It is
also why adding doc comments to the contract does not need a redeploy as long as that script still passes, and why
a `#![deny(missing_docs)]` does not work here: the Soroban macros generate items without documentation.

## Does the deployed hash reproduce on another machine?

Yes, with the same compiler, and no without it. Measured on 2026-10-12 by the
[Reproducibility workflow](../.github/workflows/reproducibility.yml), which installs the Stellar CLI and runs
[`scripts/verify-hashes.sh`](../scripts/verify-hashes.sh) on a GitHub Actions runner (Linux):

| Machine | Rust compiler | Stellar CLI | v1 | v2 |
|---|---|---|---|---|
| the maintainer's (Windows) | 1.96.1 | 27.0.0 | 1204 bytes, **`a7a82511…`** | 1204 bytes, **`ec040ead…`** |
| GitHub runner (Linux) | **1.96.1** | 27.0.0 | 1204 bytes, **`a7a82511…`** | 1204 bytes, **`ec040ead…`** |
| GitHub runner (Linux) | 1.99.0, the runner's stable | 27.0.0 | 1161 bytes, `e422ab2b…` | 1161 bytes, `6db96002…` |

The first two rows are the deployed hashes, byte for byte. So the operating system, the paths on the machine and the
user name do not matter for the Stellar CLI's build, and the hash is a function of the source, the CLI and the Rust
compiler. A newer compiler gives smaller Wasm (the compiler's own output was 1264 bytes, not 1307) and so another
hash; nothing is wrong with it, it is just not the deployed build.

That is also what the workflow keeps checking: its Rust 1.96.1 run has to pass, and its run with the runner's stable
Rust only reports, because a red there means the compiler moved. If you ever redeploy with a newer compiler, the
hashes in `fixture.wasmward.json` change, and the other repositories have to follow (see CONTRIBUTING.md).

## What to do about it

- **Hash the artifact you deploy.** `scripts/deploy.sh` hashes the files it builds, uploads them, and refuses to
  continue if the hash the network reports is not the one it computed. `testnet.json` and
  `fixture.wasmward.json` hold those hashes.
- **To see what is on the network:** `node scripts/wasm-info.mjs deployed:<hash>` reads the Wasm of that hash from
  the RPC and shows it. It refuses code whose SHA-256 is not the hash you asked for.
- **To save it:** `node scripts/wasm-info.mjs deployed:<hash> --out deployed.wasm`.
- **To ask "does this source still build the deployed fixture?":** `bash scripts/verify-hashes.sh`. It rebuilds v1 and
  v2 with the Stellar CLI and compares with the pinned hashes. Exit 0 if both match.
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
