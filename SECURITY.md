# Security

This is a test fixture that lives on Stellar **testnet**. It holds no real value and is not meant to be copied into a production contract: `upgrade` trusts a single admin and has no other safeguard.

## What is worth reporting

- A way for someone other than the admin to upgrade the deployed fixture.
- A script here that prints, logs, commits or sends a secret key. `scripts/deploy.sh` handles a secret (`FIXTURE_SECRET`, kept in the git-ignored `.env`, and the Stellar CLI's copy in the git-ignored `.stellar-keys/`); `scripts/extend.sh` uses the stored identity; the other scripts read only public values.
- A change to `.gitignore` or a script that could make `.env`, `.stellar-keys/` or `testnet.json` get committed.

## What is not

- The fixture being upgraded **by its admin**. That is what it is for, and the integration test does it on purpose.
- The fixture expiring. It expires about a week after it was last extended unless someone runs `scripts/extend.sh`; a weekly workflow reports it.

## How to report

Use GitHub's private vulnerability reporting for this repository if it is enabled (the Security tab). If it is not, open an issue that says a security problem exists **without describing it or including any secret**, and the maintainers will arrange a private channel.

## If the admin key leaks

It is a testnet key, so the damage is that someone can upgrade the fixture and break the demos and tests that point at it. Redeploy with a fresh identity (delete `.env` and `.stellar-keys/`, run `scripts/deploy.sh`, then `node scripts/sync-config.mjs`) and update the other repositories as described in [CONTRIBUTING](CONTRIBUTING.md).
