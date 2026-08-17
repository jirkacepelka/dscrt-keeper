# dscrt-keeper

Upkeep for [dSCRT](https://github.com/jirkacepelka/SteakSCRT), liquid staking on Secret
Network.

The protocol needs a few jobs done on a schedule: harvest staking rewards and restake them,
close the withdrawal window when its time comes, book what has finished unbonding. This is a
small container that does them.

## It is not a privileged component

Every message this sends is one **anyone** can send. The contract checks whether the work is
*due*, never who is asking. That has three consequences worth knowing before you run it:

- **Its key needs gas and nothing else.** A leaked keeper key costs you SCRT and stalls
  upkeep until a replacement runs. It cannot move user funds, change the fee, or touch the
  validator set. Never put the manager's key here.
- **Running a second one is harmless.** Two keepers racing waste some gas and nothing more,
  because every task is idempotent and the contract refuses whatever is not due. Redundancy
  is a decision, not a project.
- **If it dies, nobody is locked out.** Deposits, withdrawals and claims keep their own
  bookkeeping — a dead keeper costs yield, not access.

## Running it

```bash
cp .env.example .env      # paste a mnemonic; everything else already points at dSCRT
docker compose up -d
docker compose logs -f
```

The container runs as a non-root user, writes nothing, and listens on no port. It needs
outbound HTTPS and a funded key.

Without Docker:

```bash
npm ci
KEEPER_MNEMONIC="..." npm start
```

## Checking on it

```bash
npm run check
```

Reports the invariants and sends nothing — freshness, exchange rate, solvency, unbonding
entry slots, validator drift, and the keeper's own gas. It exits non-zero when something is
wrong, which is also what the container's `HEALTHCHECK` runs, so an orchestrator can tell
"running" from "running and healthy".

**It needs no key.** Every check but the gas balance is a public query, so you can point this
at the protocol from anywhere to see whether it is being looked after, without holding
anything. Without a key the gas line reports that it was not checked rather than reporting
that it was fine.

One pass and exit, if you only want to unstick things now: `npm run once`.

## Configuration

Only `KEEPER_MNEMONIC` is required. The rest defaults to the live dSCRT deployment; see
[.env.example](.env.example) for the full list.

**`LST_CORE_CODE_HASH` is deliberately optional.** Secret encrypts contract queries against
the code hash, so a stale one does not degrade — it stops everything. The hash changes every
time the contract is migrated, and this process runs for weeks at a time. Left unset, the
keeper asks the chain and re-asks once if a call fails and the answer has changed, so a
migration passes underneath it without anyone editing a file. Set it, and the keeper uses
yours and never looks: a deliberate refusal to follow the contract admin anywhere, at the
cost of stopping dead the moment they migrate.

## What it costs

One transaction an hour, plus one when a window falls due. On the current validator set that
is around 0.0077 SCRT each, so roughly 5.5 SCRT a month. `npm run check` reports the balance.

Compounding more often does not earn more — rewards accrue continuously and harvesting only
moves them. The hourly cadence buys a published exchange rate that is never more than an hour
stale.

## Where the rest lives

The contracts, deploy scripts and the incident runbook are in
[SteakSCRT](https://github.com/jirkacepelka/SteakSCRT). That repository also contains a copy
of this keeper, from before the split; **this repository is the one that is maintained.**

## Licence

Apache-2.0. See [LICENSE](LICENSE).
