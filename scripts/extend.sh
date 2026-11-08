#!/usr/bin/env bash
# Extends the lifetime of the deployed fixture on Stellar testnet: the contract instance and the Wasm code
# of both builds. Testnet contracts expire after about a week, and an expired fixture breaks anything that
# points at it (the Wasmward README example, the browser demo and the integration tests).
#
# Usage: bash scripts/extend.sh [ledgers]      (default 500000, about 29 days; the network caps it; --help for more)
#
# Needs testnet.json and the identity that scripts/deploy.sh created in .stellar-keys. Nothing here prints
# a secret.
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<'USAGE'
Usage: bash scripts/extend.sh [--dry-run] [ledgers]

Extends the lifetime of the testnet fixture: the contract instance and the Wasm code of both builds. An entry that
has already expired (is archived) cannot be extended, so each one is restored first; restoring an entry that is
still live changes nothing. When it has finished it runs scripts/fixture-status.mjs and exits 1 if the fixture still
needs attention, because an extend can be a no-op.

  ledgers      how far to extend, as a whole number of ledgers (about 5 seconds each).
               Default 500000, about 29 days; the network caps it.

  --dry-run    print the six commands that would be run (a restore and an extend for each of the three entries),
               and run none of them. Needs only testnet.json: no Stellar CLI, no identity, no network.
  -h, --help   show this text

Needs testnet.json and the identity that scripts/deploy.sh created in .stellar-keys.
USAGE
}

LEDGERS=500000
DRY_RUN=0
SEEN_LEDGERS=0
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --*)
      echo "error: unknown option $arg" >&2
      usage
      exit 1
      ;;
    *)
      if [ "$SEEN_LEDGERS" = 1 ]; then
        echo "error: expected one number of ledgers, got more" >&2
        usage
        exit 1
      fi
      # Taken as it is, even when empty: a mistake to report below, not a reason to use the default.
      LEDGERS="$arg"
      SEEN_LEDGERS=1
      ;;
  esac
done
# Refuse anything but a positive whole number before any money is spent on a transaction that cannot work.
case "$LEDGERS" in
  '' | *[!0-9]* | 0*)
    echo "error: the number of ledgers must be a whole number greater than 0, not '$LEDGERS'" >&2
    exit 1
    ;;
esac
IDENTITY="wasmward-fixture"
CFG=(--config-dir "$ROOT/.stellar-keys")

[ -f testnet.json ] || { echo "error: testnet.json not found; run scripts/deploy.sh first" >&2; exit 1; }
# A dry run only prints, so it needs neither the Stellar CLI nor the identity.
if [ "$DRY_RUN" = 0 ]; then
  command -v stellar >/dev/null || { echo "error: the Stellar CLI is not installed" >&2; exit 1; }
  stellar keys address "$IDENTITY" "${CFG[@]}" >/dev/null 2>&1 \
    || { echo "error: identity $IDENTITY not found in .stellar-keys; run scripts/deploy.sh first" >&2; exit 1; }
fi

field() { node -e 'const j=JSON.parse(require("fs").readFileSync("testnet.json","utf8"));console.log(process.argv[1].split(".").reduce((o,k)=>o[k],j))' "$1"; }
CONTRACT_ID="$(field contractId)"
V1_HASH="$(field v1.wasmHash)"
V2_HASH="$(field v2.wasmHash)"

# Runs one Stellar CLI step (restore or extend), or in a dry run only says what it would run (on stdout, since
# that is the point). Restoring an entry that is live is a no-op that exits 0 (tried on testnet), so it is always
# done first: an archived entry would otherwise answer an extend with "no changes detected" and stay archived.
step() {
  local verb="$1"
  shift
  if [ "$DRY_RUN" = 1 ]; then
    printf 'would run: stellar contract %s' "$verb"
    printf ' %s' "$@"
    printf '\n'
  else
    stellar contract "$verb" "$@" >&2
  fi
}

echo "Extending the instance of $CONTRACT_ID by $LEDGERS ledgers (restoring it first if it was archived)..." >&2
for verb in restore extend; do
  step "$verb" --id "$CONTRACT_ID" --durability persistent --ledgers-to-extend "$LEDGERS" \
    --source-account "$IDENTITY" --network testnet "${CFG[@]}"
done

for hash in "$V1_HASH" "$V2_HASH"; do
  echo "Extending the Wasm code $hash (restoring it first if it was archived)..." >&2
  for verb in restore extend; do
    step "$verb" --wasm-hash "$hash" --ledgers-to-extend "$LEDGERS" \
      --source-account "$IDENTITY" --network testnet "${CFG[@]}"
  done
done
if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run: nothing was extended." >&2
elif [ -f scripts/fixture-status.mjs ] && [ -f fixture.wasmward.json ] && command -v node >/dev/null; then
  # Look, rather than trust that the transactions did what they were asked: an extend can be a no-op.
  echo "Checking the result..." >&2
  if node scripts/fixture-status.mjs --expect v1 >&2; then
    echo "Done." >&2
  else
    echo "error: the transactions went through, but the fixture still needs attention (see above and docs/RECOVERY.md)" >&2
    exit 1
  fi
else
  echo "Done. Check the result with: node scripts/fixture-status.mjs --expect v1" >&2
fi
