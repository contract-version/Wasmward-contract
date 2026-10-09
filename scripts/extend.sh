#!/usr/bin/env bash
# Extends the lifetime of the deployed fixture on Stellar testnet: the contract instance and the Wasm code
# of both builds. Testnet contracts expire after about a week, and an expired fixture breaks anything that
# points at it (the Wasmward README example, the browser demo and the integration tests).
#
# Usage: bash scripts/extend.sh [ledgers]      (default 500000, about 29 days; the network caps it)
#
# Needs testnet.json and the identity that scripts/deploy.sh created in .stellar-keys. Nothing here prints
# a secret.
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LEDGERS="${1-500000}" # no colon: an empty argument is a mistake to report, not a reason to use the default
# Refuse anything but a positive whole number before any money is spent on a transaction that cannot work.
case "$LEDGERS" in
  '' | *[!0-9]* | 0*)
    echo "error: the number of ledgers must be a whole number greater than 0, not '$LEDGERS'" >&2
    exit 1
    ;;
esac
IDENTITY="wasmward-fixture"
CFG=(--config-dir "$ROOT/.stellar-keys")

command -v stellar >/dev/null || { echo "error: the Stellar CLI is not installed" >&2; exit 1; }
[ -f testnet.json ] || { echo "error: testnet.json not found; run scripts/deploy.sh first" >&2; exit 1; }
stellar keys address "$IDENTITY" "${CFG[@]}" >/dev/null 2>&1 \
  || { echo "error: identity $IDENTITY not found in .stellar-keys; run scripts/deploy.sh first" >&2; exit 1; }

field() { node -e 'const j=JSON.parse(require("fs").readFileSync("testnet.json","utf8"));console.log(process.argv[1].split(".").reduce((o,k)=>o[k],j))' "$1"; }
CONTRACT_ID="$(field contractId)"
V1_HASH="$(field v1.wasmHash)"
V2_HASH="$(field v2.wasmHash)"

echo "Extending the instance of $CONTRACT_ID by $LEDGERS ledgers..." >&2
stellar contract extend --id "$CONTRACT_ID" --durability persistent --ledgers-to-extend "$LEDGERS" \
  --source-account "$IDENTITY" --network testnet "${CFG[@]}" >&2

for hash in "$V1_HASH" "$V2_HASH"; do
  echo "Extending the Wasm code $hash..." >&2
  stellar contract extend --wasm-hash "$hash" --ledgers-to-extend "$LEDGERS" \
    --source-account "$IDENTITY" --network testnet "${CFG[@]}" >&2
done
echo "Done. Check the result with: wasmward check" >&2
