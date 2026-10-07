#!/usr/bin/env bash
# Builds the v1 and v2 fixture, uploads both to Stellar testnet, deploys v1, and writes testnet.json.
#
# Identity: if FIXTURE_SECRET is set (in the environment or in .env) it is used. Otherwise a fresh
# testnet identity is generated and its secret is saved to .env, which is git-ignored.
# The Stellar CLI keeps its own copy of the identity under ./.stellar-keys, also git-ignored.
#
# Output: testnet.json (public values only) and build/v1, build/v2.
set -euo pipefail
set +x # Never trace this script: it handles a secret key.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NETWORK="testnet"
RPC_URL="${WASMWARD_TESTNET_RPC_URL:-https://soroban-testnet.stellar.org}"
PASSPHRASE="Test SDF Network ; September 2015"
IDENTITY="wasmward-fixture"
CFG=(--config-dir "$ROOT/.stellar-keys")
CRATE="wasmward_fixture"

log() { printf '%s\n' "$*" >&2; }
fail() { log "error: $*"; exit 1; }

command -v stellar >/dev/null || fail "the Stellar CLI is not installed (https://developers.stellar.org/docs/tools/cli)"

sha256_of() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# --- Identity -------------------------------------------------------------------------------
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

if [ -z "${FIXTURE_SECRET:-}" ]; then
  log "No FIXTURE_SECRET found. Generating a fresh testnet identity and saving it to .env."
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  stellar keys generate generated --as-secret --config-dir "$scratch" >/dev/null 2>&1
  FIXTURE_SECRET="$(stellar keys secret generated --config-dir "$scratch" 2>/dev/null)"
  rm -rf "$scratch"
  umask 077
  printf 'FIXTURE_SECRET=%s\n' "$FIXTURE_SECRET" >> .env
fi

mkdir -p .stellar
printf '%s' "$FIXTURE_SECRET" | stellar keys add "$IDENTITY" --secret-key --overwrite "${CFG[@]}" >/dev/null 2>&1 \
  || fail "could not import the identity from FIXTURE_SECRET (is it a valid S... secret key?)"
ADMIN="$(stellar keys address "$IDENTITY" "${CFG[@]}" 2>/dev/null)"
log "Admin account: $ADMIN"

log "Funding the account on testnet (a no-op if it already exists)..."
stellar keys fund "$IDENTITY" --network "$NETWORK" "${CFG[@]}" >/dev/null 2>&1 \
  || log "note: friendbot did not fund the account; continuing in case it is already funded"

# --- Build ----------------------------------------------------------------------------------
log "Building v1 and v2..."
stellar contract build --locked --out-dir build/v1 >&2
stellar contract build --locked --features v2 --out-dir build/v2 >&2
V1_WASM="build/v1/$CRATE.wasm"
V2_WASM="build/v2/$CRATE.wasm"
[ -f "$V1_WASM" ] && [ -f "$V2_WASM" ] || fail "build did not produce $V1_WASM and $V2_WASM"

LOCAL_V1="$(sha256_of "$V1_WASM")"
LOCAL_V2="$(sha256_of "$V2_WASM")"
[ "$LOCAL_V1" != "$LOCAL_V2" ] || fail "v1 and v2 have the same hash; the v2 feature had no effect"

# --- Upload and compare hashes --------------------------------------------------------------
upload() {
  STELLAR_ACCOUNT="$IDENTITY" stellar contract upload --wasm "$1" --network "$NETWORK" "${CFG[@]}" | tail -n 1 | tr -d '\r'
}

log "Uploading v1..."
CHAIN_V1="$(upload "$V1_WASM")"
log "Uploading v2..."
CHAIN_V2="$(upload "$V2_WASM")"

[ "$CHAIN_V1" = "$LOCAL_V1" ] || fail "v1 hash mismatch: local $LOCAL_V1, on-chain $CHAIN_V1"
[ "$CHAIN_V2" = "$LOCAL_V2" ] || fail "v2 hash mismatch: local $LOCAL_V2, on-chain $CHAIN_V2"
log "Hashes match. v1=$LOCAL_V1 v2=$LOCAL_V2"

# --- Deploy v1 ------------------------------------------------------------------------------
log "Deploying v1..."
CONTRACT_ID="$(STELLAR_ACCOUNT="$IDENTITY" stellar contract deploy --wasm-hash "$CHAIN_V1" --network "$NETWORK" "${CFG[@]}" -- --admin "$ADMIN" | tail -n 1 | tr -d '\r')"
case "$CONTRACT_ID" in C*) ;; *) fail "unexpected deploy output: $CONTRACT_ID" ;; esac
log "Contract: $CONTRACT_ID"

cat > testnet.json <<JSON
{
  "network": "$NETWORK",
  "rpcUrl": "$RPC_URL",
  "passphrase": "$PASSPHRASE",
  "contractId": "$CONTRACT_ID",
  "admin": "$ADMIN",
  "v1": { "wasmHash": "$LOCAL_V1", "file": "$V1_WASM" },
  "v2": { "wasmHash": "$LOCAL_V2", "file": "$V2_WASM" },
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
log "Wrote testnet.json (public values only; the secret stays in .env)."
