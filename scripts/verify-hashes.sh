#!/usr/bin/env bash
# Rebuilds v1 and v2 with the Stellar CLI, the way scripts/deploy.sh does, and checks that the Wasm hashes are the
# ones pinned in fixture.wasmward.json, which are the ones deployed on testnet. It answers "does my working tree
# still build the fixture that is deployed?" without a network, an identity or any money.
#
# Why this is the check, and not `cargo build`: the hash of a plain `cargo build --release` embeds the file path
# and line of every panic, so a comment above `.expect(...)` changes it, and so does building on Windows instead of
# Linux. The Stellar CLI's build does not (see docs/HASH-PROVENANCE.md), so it reproduces the deployed hashes.
#
# Exit codes: 0 both builds have the pinned hash, 1 at least one does not, 2 the CLI is missing, the build failed
# or the config could not be read. The build goes to a temporary folder; build/ is not touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<'USAGE'
Usage: bash scripts/verify-hashes.sh [--config <file>]

Builds v1 and v2 with `stellar contract build --locked` into a temporary folder and compares the SHA-256 of each
with the one in the config (default fixture.wasmward.json, the builds labelled v1 and v2).

  --config <file>   the config to compare with
  -h, --help        show this text

Exit 0 if both match, 1 if one does not, 2 if it could not be checked. Needs the Stellar CLI and Node 18 or newer.
USAGE
}

CONFIG="fixture.wasmward.json"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --config)
      if [ "$#" -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then
        echo "error: --config needs a file" >&2
        exit 2
      fi
      CONFIG="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      usage
      exit 2
      ;;
  esac
done

log() { printf '%s\n' "$*" >&2; }
fail() { log "error: $*"; exit 2; }

command -v stellar >/dev/null || fail "the Stellar CLI is not installed (https://developers.stellar.org/docs/tools/cli)"
command -v node >/dev/null || fail "Node.js is not installed"
[ -f "$CONFIG" ] || fail "$CONFIG not found"

# The pinned hash of a labelled build, from the config.
pinned() {
  node -e '
    const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const builds = Object.values(config.contracts ?? {}).flatMap((contract) => contract.supported ?? []);
    const build = builds.find((entry) => entry.label === process.argv[2]);
    if (!build || !/^[0-9a-f]{64}$/.test(build.wasmHash)) process.exit(1);
    console.log(build.wasmHash);
  ' "$CONFIG" "$1"
}
PINNED_V1="$(pinned v1)" || fail "$CONFIG has no valid hash for the build labelled v1"
PINNED_V2="$(pinned v2)" || fail "$CONFIG has no valid hash for the build labelled v2"

sha256_of() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

log "Building v1 and v2 with the Stellar CLI..."
stellar contract build --locked --out-dir "$scratch/v1" >&2 || fail "the v1 build failed"
stellar contract build --locked --features v2 --out-dir "$scratch/v2" >&2 || fail "the v2 build failed"
for variant in v1 v2; do
  [ -f "$scratch/$variant/wasmward_fixture.wasm" ] || fail "the $variant build did not produce wasmward_fixture.wasm"
done

status=0
check() {
  local label="$1" pinned="$2" built
  built="$(sha256_of "$scratch/$label/wasmward_fixture.wasm")"
  if [ "$built" = "$pinned" ]; then
    echo "$label  ${built:0:8}...  matches the pinned hash"
  else
    echo "$label  built ${built}" >&2
    echo "$label  pinned ${pinned}" >&2
    status=1
  fi
}
check v1 "$PINNED_V1"
check v2 "$PINNED_V2"

if [ "$status" -ne 0 ]; then
  # The deployed hashes are a function of the source, the Stellar CLI and the Rust compiler (docs/HASH-PROVENANCE.md).
  log "This machine: $(rustc --version 2>/dev/null || echo 'rustc not found'); $(stellar --version 2>/dev/null | head -1)."
  log "The deployed hashes were built with rustc 1.96.1 and Stellar CLI 27.0.0, and a newer compiler gives other ones."
  log "The working tree no longer builds the deployed fixture. If that is on purpose, see CONTRIBUTING.md: the fixture has to be redeployed and three repositories updated. If not, something that changes the Wasm was edited (the toolchain counts: see docs/HASH-PROVENANCE.md)."
fi
exit "$status"
