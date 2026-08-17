# dscrt-keeper

Upkeep for [dSCRT](https://github.com/jirkacepelka/SteakSCRT), liquid staking on Secret
Network.

The protocol needs a few jobs done on a schedule: harvest staking rewards and restake them,
close the withdrawal window when its time comes, book what has finished unbonding. This is a
small container that does them, with a console to set it up and a record of everything it has
sent.

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

### On ZimaOS, or anything with an app store

App Store → **Install a custom App** → paste [`zimaos/docker-compose.yml`](zimaos/docker-compose.yml).

That is the whole installation. No SSH, no clone, no build on the NAS, and nothing to edit
first. Open the tile, set a console password, paste a recovery phrase.

### Anywhere else

```bash
docker compose up -d
```

Then open <http://localhost:8787>. This builds from source rather than pulling the published
image, which for a container holding a signing key is a reasonable thing to prefer.

Without Docker:

```bash
npm ci
npm start
```

## The console

Everything is configured from it, and it shows what the keeper has actually done.

**Overview** — the keeper's address, its gas balance, what it has spent, and each job with
the reason it is or is not due. The six invariant checks are underneath: freshness, exchange
rate, solvency, unbonding entry slots, validator drift, gas. Any job can be run by hand.

**History** — every transaction the keeper has sent, with its hash linked to the explorer,
what it cost, and the error when there was one. Before this existed the answer to "what has
this thing been doing" was to scroll a Docker log that had probably already rotated.

**Settings** — the recovery phrase, the cadence, the endpoint, the contract. Changes apply to
the running process; nothing here needs a restart.

### The password

Set the first time you open it. There is no default, because a shipped default is a published
one and this guards a signing key. If you forget it, delete `admin.json` from the data
directory — which only somebody with the machine can do, which is the right bar.

### The key

Three ways in, and no way out. `KEEPER_MNEMONIC` in the environment works exactly as it
always did. Otherwise paste the phrase into the console, where it is written to the data
volume at mode 0600 — or encrypted with AES-256-GCM if you give it a passphrase.

No route returns it. The console shows the derived address and whether one is configured, and
the field is write-only.

**Be clear about what encryption buys.** It protects the file, not the volume: anyone holding
both the data directory and the container's environment holds both halves. What it buys is
that a NAS backup, a snapshot, a shared folder or a stray `cat` is not a key — which on a
home server is most of the realistic exposure. If you encrypt it, set `KEEPER_PASSPHRASE` in
the compose file or the keeper will come back from a restart reading the protocol but unable
to sign until somebody unlocks it.

## What it costs

One transaction an hour, plus one when a window falls due. On the current validator set that
is around 0.008 SCRT each, so roughly **6 SCRT a month**. The console prices every cadence
before you pick one.

Compounding more often does not earn more — rewards accrue continuously and harvesting only
moves them. The hourly cadence buys a published exchange rate that is never more than an hour
stale; six-hourly costs about a sixth as much and earns exactly the same.

## Checking on it without the console

```bash
npm run check
```

Reports the invariants and sends nothing. **It needs no key** — every check but the gas
balance is a public query, so you can point this at the protocol from anywhere to see whether
it is being looked after, without holding anything. Without a key the gas line reports that
it was not checked rather than that it was fine.

It exits non-zero when something is wrong. The container's `HEALTHCHECK` asks `/healthz`
instead, which reports the verdict of the pass the running process already made rather than
starting a second keeper every few minutes to re-ask the chain.

One pass and exit, if you only want to unstick things now: `npm run once`.

## Configuration

Nothing is required. The defaults are the live dSCRT deployment and everything else is set in
the console.

**The environment wins.** Anything set in `.env` or the compose file overrides the console
permanently, and the console shows such a field as unreachable rather than accepting an edit
that would go nowhere — a settings screen that saves a value the process ignores is worse
than no settings screen. See [.env.example](.env.example) for the full list.

**`LST_CORE_CODE_HASH` is deliberately optional.** Secret encrypts contract queries against
the code hash, so a stale one does not degrade — it stops everything. The hash changes every
time the contract is migrated, and this process runs for weeks at a time. Left unset, the
keeper asks the chain and re-asks once if a call fails and the answer has changed, so a
migration passes underneath it without anyone editing a file. Set it, and the keeper uses
yours and never looks: a deliberate refusal to follow the contract admin anywhere, at the
cost of stopping dead the moment they migrate.

## What the console cost

Worth stating plainly, because it was a real property and it is gone.

The keeper used to listen on no port, mount no volume, and run with a read-only filesystem.
It now listens on 8787 and writes to `/data`. What is kept: it still runs as an unprivileged
user, the root filesystem is still read-only with the data volume as the only writable mount,
`no-new-privileges` still applies, and the page's content security policy names no remote
origin at all — no CDN, no font host, nothing it is permitted to talk to except the process
that served it.

What was bought: a cadence reachable without editing a file next to a mnemonic, a record of
what was sent, and an install that is a paste rather than a project.

If the machine running this is reachable from outside your network, publish the port as
`127.0.0.1:8787:8787` and reach it over a tunnel.

## Data

Everything lives in one directory — `/data` in the container, `./data` otherwise:

| File | Holds |
|---|---|
| `config.json` | what the console changed |
| `wallet.env` or `wallet.enc` | the key, plain at mode 0600 or encrypted |
| `admin.json` | the console password's scrypt hash |
| `history.jsonl` | one operation per line, compacted at 5 000 |
| `memory.json` | drift baselines, so a restart does not blind the checks |

Back it up. Losing it loses the history and the key — not the ability to run, but you will be
configuring it again.

## Development

```bash
npm run typecheck    # types
npm test             # the console's API, end to end. No chain involved
npm run test:shapes  # do the contract's types still match? Queries a live testnet
```

`npm test` starts a real keeper on a throwaway data directory and drives its API: the password
gate, the environment-beats-file rule, that a stored key never comes back out, that a cadence
change reaches the running schedule, and that the static handler cannot be walked out of.

There is no build step anywhere. The daemon is TypeScript run through Node's type stripping
and the console is hand-written HTML, one stylesheet and one ES module. What runs is what you
can read.

## Where the rest lives

The contracts, deploy scripts and the incident runbook are in
[SteakSCRT](https://github.com/jirkacepelka/SteakSCRT). That repository also contains a copy
of this keeper, from before the split; **this repository is the one that is maintained.**

## Licence

Apache-2.0. See [LICENSE](LICENSE).
