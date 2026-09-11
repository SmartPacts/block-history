# block-history

An append-only, engine-attested record of a Kadena chain's blocks — `height → {hash, time, by}`
— as a Pact 5 module, one independent instance per chain, immutable from its first deploy.
On mainnet it lives in the `free` namespace as `free.block-history`. Licensed under Apache-2.0.

## Why it can exist, and why only this way

Inside Pact, `(chain-data)` is the only view of the chain. It has seven fields
(`pact/Pact/Core/ChainData.hs:124-131` in the Pact 5 source) and the three that describe a
block all describe the **previous** one: at height N, `block-height` = N,
`prev-block-hash` = hash(N−1), `block-time` = creationTime(N−1). Verified on mainnet01 —
`/cut` height 7208925 hash `QqNvtjXzPCn8J1UD_MicQvSQs8ogzAIGfAIe9boWC9s`; `(chain-data)` in the
next block returned block-height 7208926 and that exact hash — and microsecond-exact on devnet.

So a transaction mined in block N can write a complete, **unforgeable** record of block N−1 from
values the engine handed it. That window is one block wide, and writing it down is all this
module does. Nothing older can be proven in-contract: the block hash is a SHA-512/256 Merkle root
(`chainweb-node src/Chainweb/MerkleUniverse.hs:56`), Pact 5 has no SHA-2 native, and `verify-spv`
supports only `TXOUT`. So the record holds only what was witnessed. Blocks before its first
`attest`, and blocks no recorder attested, are absent, and nothing in the module can add them.

## The module — `pact/modules/block-history.pact`

| Function | Who | What |
|---|---|---|
| `attest` | anyone, no arguments | records block N−1 from `(chain-data)`; a duplicate is a cheap no-op |
| `get-attested h` / `hash-of h` / `time-of h` | anyone | the record of a height; **aborts** if it was never attested. Settle on these |
| `has-attested h` | anyone | gap detection; never aborts for a height in range |
| `latest` | anyone | highest attested `{height, hash, time}`; height −1 before the first |
| `chain` | anyone | this instance's chain id |
| `key h` | pure | the 12-digit zero-padded row key |

`attest` is the only function that writes. It takes no arguments, so a caller decides only
whether a row is written, never what it says.

Each invariant is pinned by a test that a generated mutant turns red (`pact/tests/run.sh`):
- every value comes from `(chain-data)`, and `attest` takes no arguments;
- a recorded row is never rewritten, and a duplicate never aborts;
- no function but `attest` writes a row;
- the module cannot be upgraded and its tables cannot be written from outside (`GOVERNANCE` is
  `enforce false`).

Settle on `hash` and on heights. `time` is the block's miner-stamped creation time — exact to the
microsecond on chain, but metadata. The value a row will hold is public one block before it is
written, so this is a provenance record, not a randomness beacon.

### Reading it from another contract

Each chain has its own instance, so a call reads the history of the chain it runs on.

```pact
(free.block-history.hash-of 7208925)       ; the attested hash; aborts unless attested
(free.block-history.has-attested 7208925)  ; true if the height was recorded; never aborts
(free.block-history.get-attested 7208925)  ; {hash, time, by}; aborts unless attested
(free.block-history.latest)                ; the highest attested height
```

## Verify the deployed module

Each release lists its commit, the module hash and the sha256 of the module source.

- The module hash is computed by the engine, excludes comments, and is the same on all 20 chains.
  The expected mainnet hash, computed by mainnet's own engine in a read-only dry run, is
  `gV_Txq3_1nvxK7zgwJM8ZoFBunBYpuTmHaClyF9G4kU`.
- `(describe-module "free.block-history")` on any chain returns that `hash`, and a `code` field
  holding the source from `(module` to its closing parenthesis. Compare it with the file.
- `npm run preflight` (read-only) prints the hash every chain reports.
- The hash proves the code, not the starting state: the transaction that deploys a module can also
  write to its tables. So check that each chain's deploy transaction carries exactly the published
  file and nothing else. The request keys of the 20 deploy transactions are listed here once the
  module is deployed.
- A keyset named `free.block-history-backfill` exists on all 20 chains. An earlier deploy plan, which
  included a trusted backfill, defined it on 2026-09-11; that plan was dropped before the module was
  deployed. The published module does not reference the keyset, and the keyset has no power over
  the record.

## Evidence

- **REPL:** `pact/tests/run.sh` runs:
  - the static gate, with every negative naming its error;
  - the suites: lifecycle, branch-complete negatives, vision pins, gas, and `deploy.repl` (the module
    deploys into an open namespace with no keyset and no signature);
  - the frozen fixture, refused for the stated reason, plus a control that loads it against open
    governance;
  - generated mutants, each turning `vision-pin.repl` RED;
  - a DML inventory with its own control: `attest`'s insert into `attested` and its `latest` write,
    and nothing else.
- **Node:** `ts/src/devnet-negatives.ts` re-proves on a live node, by preflight, the refusals a node
  can show: a read of a missing height, an external table write, and taking module admin. It also
  runs a positive control, an `attest` that goes through.
- **Differential:** `ts/src/oracle.ts` walks the node's canonical headers back from the cut and
  compares hash and microsecond time for every height. Numbers below.
- **CI** runs the suite, the typecheck and tool self-checks, shellcheck, and a leak scan on every
  push.

### Measured on devnet (`recap-development`, chainweb-node 3.2.1, 20 chains, ~0.85 blocks/s/chain)
| Item | Value |
|---|---|
| Module hash (identical on all 20 chains) | `gV_Txq3_1nvxK7zgwJM8ZoFBunBYpuTmHaClyF9G4kU` |
| Deploy gas per chain | 4,339 |
| `attest` gas on a node | 204 on average over 279 sampled mined transactions, 0 failed |
| `attest` in the REPL gas model (record / duplicate no-op) | 91 / 15 |
| Feeder soak, 6 min, 20 chains | 6,560 events, 6,560 submitted, 0 submit errors, 0 reconnects |
| Coverage in the feeder's active window | **99.80 %**: 4,000 heights, 8 gaps, 0 mismatches (oracle CONSISTENT) |
| Mainnet header stream (read-only, 240 s, public proxy) | all 20 chains on one connection, 167 events, 0.70 blocks/s network-wide, 0 unparseable |

One feeder burns ≈0.0059 KDA per chain per day: 0.5 KDA per chain (10 KDA total) is ≈84 days,
and a year on all 20 chains is ≈43 KDA. The deploy itself is ≈0.0009 KDA in total.

### Deploy-ceremony rehearsal
- Rehearsed end to end on a fresh devnet, from a fresh clone, under mainnet's own namespace:
  21 of 21 checks.
  - The preflight dry run matched the mainnet hash, and all 20 chains deployed with that one hash.
  - Every refusal held: a secret on the command line, a key file others can read, a duplicate
    file, an altered file.
  - An unsigned check-only pass sent nothing signed.
  - Files already on chain were skipped before signing, and refused when judged for another
    namespace.
  - A second pass had nothing left to do, and a repeated send sent nothing.
  - The stored code equals the file and there are no rows; no key file was opened at any point.
- An earlier rehearsal found a deploy bug, since fixed: the unsigned flow named the local devnet
  key as signer instead of the gas payer, which made every emitted file unsignable.

### Server provisioning rehearsal — `ts/deploy/provision-droplet.sh`
Rehearsed in clean Ubuntu 24.04 containers, talking to mainnet read-only. A container has no
systemd, firewall or swap, so those steps are skipped there; this table says what WAS run.
| Scenario | Result |
|---|---|
| A — a typical cloud droplet (sshd installed, cloud-init says passwords YES, SSH key present), provisioned twice | both runs exit 0; SAME feeder key both runs (never regenerated); effective sshd setting `passwordauthentication no` |
| B — no SSH key installed | exit 0; the SSH step REFUSED to disable passwords (lockout guard); effective setting untouched; no hardening file written |
| C — the service run mode: A's filesystem read-only except /tmp and the log dir (what ProtectSystem=strict + PrivateTmp give the unit), as the service user | stream check: all 20 chains, 0 unparseable, exit 0; the real feeder entrypoint loaded its key, then refused — module not deployed — and sent nothing (exit 1) |
| SSH step alone, 4 branches | normal case: effective `no`, 3 of 3; no key: skipped; sshd already broken: skipped; an overriding `00-` file: stopped and removed its own file |
| systemd 255 (Ubuntu 24.04) | the unit verifies with zero messages; every sandbox flag is accepted by `systemd-run`; a misspelled flag is rejected (control) |
| Node | v24.21.0, pinned by sha256 read in full from nodejs.org |

Exercised only on a real droplet: ufw, swap, `systemd-run` as the service user under the system
manager, and the ssh reload. Each stops loudly if it fails.

Three bugs were found by rehearsing and fixed:
- the SSH hardening file was silently overridden by cloud-init, because sshd keeps the FIRST value
  it reads;
- its verification, first written as `sshd -T | grep -q` under pipefail, reported "still ON" for a
  hardened host (SIGPIPE);
- step 2 called apt-get directly, so a fresh droplet's own first-minutes apt jobs stopped it on
  "Could not get lock". `-o DPkg::Lock::Timeout` covers the install lock but NOT the package-list
  lock, so step 2 now retries while any apt lock is held and reports any other failure at once.

## Operate — `ts/`

```
cp ts/.env.example ts/.env        # host, network, namespace, chains, key paths
cd ts && npm install && npm run typecheck && npm run test-tools
npm run deploy                    # devnet: creates + funds keys, deploys all chains, verifies one hash
npm run stream-check -- --seconds 240   # read-only: is the node's header stream alive for every chain?
npm run balances -- k:<account>   # read-only: KDA per chain and feeder runway; unreachable ≠ zero
npm run feeder                    # one process, all chains, SSE-driven; --duration N for a soak
npm run oracle -- --last 600      # CONSISTENT / FAIL, coverage per chain
npm run devnet-negatives -- --chain 2
```

The feeder supplies liveness, not data. It listens to the node's `/header/updates` stream (all
20 chains on one connection), signs an `attest` per new block anchored to that block's own
creation time, and submits with a tight gas limit (400). Coverage is a reaction-latency
problem.

Sequence for a network: **deploy → run the feeder → run the oracle forever.** There is nothing to
close and nothing to fill in later.

### Run your own recorder

`attest` is permissionless and idempotent, so anyone can run the feeder with their own funded
account, and recorders never conflict: a block is lost only when every recorder misses it. A
recorder cannot corrupt the record, because `attest` takes no arguments and writes only what the
engine supplies. So the worst case for a leaked feeder key is its own drained gas balance. Give the
feeder an account of its own that holds only gas and authorises nothing else.

### Run the feeder on a server

One small always-on machine with a public IPv4 address. Measured requirements:

- **1 GiB of memory.** The feeder peaks at ~200 MB resident; a 512 MB server leaves Ubuntu nothing
  to spare, and a feeder that swaps reacts late, which is exactly what costs coverage. The public
  node the feeder uses, `chainweb.eckowallet.com`, is in Gravelines, France, so a nearby region
  reacts sooner.
- **On DigitalOcean, a Bundled plan, not v5.** A v5 droplet bills its public IPv4 address
  separately and has no monthly usage cap; a Bundled plan includes the IPv4 address and caps
  billing at 672 hours a month. The feeder needs IPv4 (see the next point).
- **The node is IPv4-only** (no AAAA record), so no IPv6-only plan can reach it. AWS is roughly
  double the alternatives once its public-IPv4 charge is counted.
- **Not GitHub Actions:** 6 h job cap, 5 min minimum schedule, scheduled workflows disabled after
  60 days without repo activity, and GitHub's terms forbid unrelated workloads on hosted runners.
- **A second feeder on a different network** is the best use of the next few dollars: two
  feeders cut blocks lost per chain per year from ≈7,458 to ≈53 for ≈31 KDA/year more gas.

`ts/deploy/provision-droplet.sh` prepares a fresh Ubuntu 24.04 droplet and **stops short of
sending**. On the droplet, as root, with `<commit>` the full commit id from the release notes:

```
curl -fsSLo provision-droplet.sh \
  https://raw.githubusercontent.com/SmartPacts/block-history/<commit>/ts/deploy/provision-droplet.sh
bash provision-droplet.sh <commit>
```

What it does:
- pins Node by sha256;
- clones this repository and checks out exactly `<commit>`, refusing anything else: a full commit
  id, fsck, a clean tree, and the script compares itself byte for byte to its own copy inside that
  commit;
- leaves the code owned by root and only readable by an unprivileged `blockhistory` user;
- generates the feeder key **on the droplet** (0600, never printed, never regenerated on a re-run);
- sets the firewall to inbound SSH only;
- turns off password SSH only when a key is installed, and checks the setting sshd will actually use
  with `sshd -T`;
- enables unattended security upgrades and log rotation;
- installs the systemd unit **without enabling it**;
- proves the droplet sees every chain's block stream under the service's own sandbox;
- ends by printing the feeder account to fund.

It is safe to re-run. `BH_REPO` points it at another git source (a local path or a bundle), which is
how it is rehearsed.

Enabling the service is the step that sends mainnet transactions:

```
systemctl enable --now block-history-feeder
journalctl -u block-history-feeder -f
```

Started before the module is deployed, the feeder refuses on the first chain and sends nothing.
Five failed starts in 30 minutes make systemd stop trying rather than hammer the node; clear that
with `systemctl reset-failed block-history-feeder`. `npm run keygen -- <path>` makes a key file and
refuses to overwrite one.

### Deploying to a network — one pass

In `free`, the user guard is `ns.success`, so every name there is first-come, and a module's first
deploy needs no signature except the gas payer's. The module references no keyset, so there is
nothing to claim first. One transaction per chain carries the module source, with `{"ns": BH_NS}`
in its data. `npm run preflight` reports a chain whose name is held by a different module as LOST.

```
# 0. READ-ONLY readiness. Sends nothing. Exit 0 = GO, 1 = not ready, 2 = a name is LOST.
#    The decisive check runs the real module source on the target engine via /local.
npm run preflight

# 1. One module command per chain, into ts/out/unsigned/<network-id>/
#    (<network-id> is BH_NETWORK_ID, e.g. mainnet01)
npm run deploy -- --unsigned

# 2. Sign the gas payer's slot of every file, check it and preflight it on the node — nothing
#    is sent — then send them one by one, and confirm they landed
npm run send-signed -- --gas-key <gas-key.json> out/unsigned/<network-id>/*.json
npm run send-signed -- --gas-key <gas-key.json> --send out/unsigned/<network-id>/*.json

# 3. Verify, then start capturing
npm run preflight                     # every chain DEPLOYED, one hash
npm run stream-check -- --seconds 240
npm run feeder
npm run oracle -- --last 600          # must print CONSISTENT
```

**Signing.** Deploying needs only **gas**, because a module's first deploy into `free` is
unauthenticated. So each file carries one signer, the gas payer, scoped to `coin.GAS`.

`send-signed --gas-key` rebuilds each file from what it must contain: the exact module source with
`{"ns": BH_NS}`, at `BH_GAS_PRICE` (at most 1e-7) and the deploy's gas limit. It signs a file only if
the bytes match exactly and the chain would still accept it.
- **Without `--send`,** nothing signed leaves the machine: each command is checked on the node
  unsigned.
- **With `--send`,** the maximum fee is printed first, and each command is preflighted signed just
  before it is submitted.
- **The key file** must be readable by its owner alone, and its secret is never printed.
- **A re-run** skips what is already on chain, before signing it.
- **Commands signed elsewhere** are relayed only if they are exactly the JSON these tools write and
  define no other module, interface or keyset.

## Known limits (by design)
- 100 % capture is unreachable. Gaps are honest and permanent: nothing can fill them later.
  Recorders on independent networks are the remedy.
- Every row is permanent on every node (Pact has no delete): ≈33 GB per node per year for all
  20 chains, a deliberate trade-off.
- Node-serialised times: Pact's JSON codec renders a millisecond-aligned time without its
  fraction (`Legacy/LegacyCodec.hs:126-128,153-154`). The row is exact; read times through
  `format-time` off-chain, as the oracle does.

## License

Apache License 2.0 — see `LICENSE` and `NOTICE`. The module carries the same identifier inside
its `(module …)` form, so the license travels with the source the chain stores.
