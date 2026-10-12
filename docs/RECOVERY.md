# When the fixture is not working

The fixture is the contract deployed on Stellar testnet that Wasmward's README example, the browser demo and the integration tests point at. Three things go wrong with it. Each has a one-line check and a fix.

Start with what it says about itself. Both commands need only Node 18 or newer and read nothing secret:

```bash
node scripts/live-build.mjs --expect v1     # which build is running now
node scripts/check-lifetimes.mjs            # how long the instance and each build's Wasm code have left
```

## It has expired

**Sign.** The weekly [Fixture health](../.github/workflows/fixture-health.yml) run is red, `wasmward check` says `missing` or `archived`, or `check-lifetimes.mjs` exits 1 with "has expired" or "not found". Testnet entries live about a week after they were last extended.

**Fix, while it is still alive** (the usual case: the run was red because under three days were left):

```bash
bash scripts/extend.sh            # the instance and both builds' Wasm code, about 29 days
bash scripts/extend.sh --dry-run  # print the three commands first, run none
```

It needs `testnet.json` and the identity that `scripts/deploy.sh` created in `.stellar-keys/`, both on the machine that deployed the fixture. Check the result with `node scripts/check-lifetimes.mjs --min-days 20`.

**Fix, after it has gone.** An entry that has already expired is archived, and extending an archived entry fails. The Stellar CLI can restore one (`stellar contract restore`); these scripts do not do that, and none of them has tried it. The way that is scripted is to deploy again: see "It has to be redeployed" below.

## It is running the wrong build

**Sign.** `node scripts/live-build.mjs --expect v1` exits 1 and says `runs v2 (...), expected v1`. The demo and the README example expect v1. The upgrade tests move the fixture to v2 and back, so a test run that was interrupted halfway can leave it on v2. Wasmward alone does not flag this, because both builds are on the supported list.

**Fix.** Run the integration test in the Wasmward repository again (`pnpm test:integration` in `Wasmward-backend`). Its setup upgrades the fixture back to v1 when it finds any other build, and it leaves it on v1 at the end. It needs the identity that deployed the fixture, because only the admin can upgrade. Then check: `node scripts/live-build.mjs --expect v1` should exit 0.

If it says `runs ... which is not on the supported list`, the fixture was upgraded to something that is neither build. That is not something these scripts cause: redeploy.

## It has to be redeployed

**When.** The fixture is gone and cannot be restored, the admin key leaked (see [SECURITY.md](../SECURITY.md)), or the contract code changed on purpose (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

**Steps.**

1. `bash scripts/deploy.sh`. It builds both variants, uploads them, checks that the on-chain hashes equal the local ones, deploys v1 and writes `testnet.json`. After a leaked key, delete `.env` and `.stellar-keys/` first so that it creates a fresh identity.
2. `node scripts/sync-config.mjs` rewrites `fixture.wasmward.json` from `testnet.json` (`--check` only says whether it is stale).
3. Update what the other Wasmward repositories keep: in the frontend `src/demo-config.js` and `wasmward.json`; in the backend the README example and the recorded testnet responses in `test/fixtures/recorded`.
4. `node scripts/live-build.mjs --expect v1` and `node scripts/check-lifetimes.mjs` should both exit 0.

A redeploy gives new hashes only if the Wasm changed. The same source built by another compiler also gives another Wasm, which is why the hash that counts is the one of what was uploaded: see [HASH-PROVENANCE.md](HASH-PROVENANCE.md).

## What the exit codes mean

Both scripts use the same ones: `0` fine; `1` something is wrong with the fixture (wrong build, missing, or too close to expiring); `2` the config or the RPC could not be used, so nothing is known about the fixture. A `2` is a reason to try another RPC (`--rpc-url`) before concluding anything.
