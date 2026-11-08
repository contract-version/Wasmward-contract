#!/usr/bin/env bash
# Redeploys the testnet fixture and carries the new contract into everything that pins it, in order, stopping at the
# first step that fails. It is the steps of docs/RECOVERY.md ("It has to be redeployed") as one command, because the
# first deployment expired and the steps are easy to leave half done.
#
#   bash scripts/redeploy.sh --yes        do it
#   bash scripts/redeploy.sh --dry-run    list the steps and run none of them
#
# The steps:
#   1. scripts/deploy.sh            builds v1 and v2, uploads both, deploys v1, writes testnet.json (new contract ID)
#   2. scripts/sync-config.mjs      rewrites fixture.wasmward.json from testnet.json
#   3. scripts/extend.sh            restores and extends everything (a new deployment lives about a week), then checks it
#   4. scripts/sync-siblings.mjs    writes the new contract ID and v1 hash into the frontend and the backend README
#   5. scripts/record-testnet.mjs   records the backend's replay fixture from the live network
#   6. scripts/sync-siblings.mjs --check   every file that pins the contract agrees
# What it does not do: run the other repositories' tests, commit, or push. It says so at the end.
#
# It deploys a new contract with the identity in .env and .stellar-keys and spends a little testnet money, so it asks
# for --yes. The old contract is left alone; nothing refers to it any more.
#
# Exit codes: 0 all six steps passed, 1 a step failed (it is named, and the later steps were not run), 2 usage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
}

YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      usage
      exit 2
      ;;
  esac
done

STEPS=(
  "bash scripts/deploy.sh"
  "node scripts/sync-config.mjs"
  "bash scripts/extend.sh"
  "node scripts/sync-siblings.mjs"
  "node scripts/record-testnet.mjs"
  "node scripts/sync-siblings.mjs --check"
)

if [ "$DRY_RUN" = 1 ]; then
  n=1
  for step in "${STEPS[@]}"; do
    printf 'would run %s: %s\n' "$n" "$step"
    n=$((n + 1))
  done
  echo "Dry run: nothing was run." >&2
  exit 0
fi

if [ "$YES" != 1 ]; then
  echo "error: this deploys a new contract to testnet and spends a little testnet money; run it with --yes, or look first with --dry-run" >&2
  exit 2
fi

n=1
for step in "${STEPS[@]}"; do
  echo "== Step $n of ${#STEPS[@]}: $step" >&2
  if ! $step; then
    echo "error: step $n failed ($step). The steps after it were not run. Fix the cause and run that step and the later ones by hand: docs/RECOVERY.md" >&2
    exit 1
  fi
  n=$((n + 1))
done

echo "== All ${#STEPS[@]} steps passed." >&2
echo "Not done: run the tests in Wasmward-frontend and Wasmward-backend, commit what changed in the three repositories, and push (bash ../push-all.sh if you have it)." >&2
