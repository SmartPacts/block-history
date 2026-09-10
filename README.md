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
values the engine handed it. That window is one block wide. Nothing older can ever be proven
in-contract: the block hash is a SHA-512/256 Merkle root (`chainweb-node
src/Chainweb/MerkleUniverse.hs:56`), Pact 5 has no SHA-2 native, and `verify-spv` supports only
`TXOUT`. Older blocks are therefore a **trusted** backfill, kept in a separate table.

## The module — `pact/modules/block-history.pact`

| Function | Who | What |
|---|---|---|
| `attest` | anyone, no arguments | records block N−1 from `(chain-data)`; duplicate = cheap no-op |
| `backfill rows` | backfill keyset, window open | records older blocks into `backfilled`; refuses the frontier, malformed hashes, attested heights, conflicting re-sends; same-hash re-send is skipped |
| `close-backfill` | backfill keyset | closes the window forever (state flag; no reopen exists) |
| `get-attested h` / `hash-of h` / `time-of h` | anyone | the engine-attested record; **aborts** if absent — settle money on these |
| `get-backfilled h` | anyone | the trusted record; aborts if absent |
| `get-block h` | anyone | either, tagged `source: "attested" \| "backfilled"`; aborts if neither |
| `has-attested h` / `has-backfilled h` / `has-block h` | anyone | gap detection, never abort |
| `latest` | anyone | highest attested `{height, hash, time}`; height −1 before the first |
| `backfill-status` | anyone | `{open, closed-at}` |
| `chain` | anyone | this instance's chain id |
| `key h`, `valid-hash s` | pure | 12-digit zero-padded key; 43-char base64url shape check |

Invariants, each pinned by a test that a generated mutant turns red (`pact/tests/run.sh`):
a height lives in at most one table; an attested row is never overwritten; a backfilled row is
never served as attested; the module cannot be upgraded (`GOVERNANCE` is `enforce false`).

Settle on `hash` and on heights. `time` is the block's miner-stamped creation time — exact to the
microsecond on chain, but metadata. The value a row will hold is public one block before it is
written, so this is a provenance record, not a randomness beacon.

### Reading it from another contract

Each chain has its own instance, so a call reads the history of the chain it runs on.

```pact
(free.block-history.hash-of 7208925)     ; the attested hash; aborts unless attested
(free.block-history.has-block 7208925)   ; true if either table holds the height; never aborts
(free.block-history.get-block 7208925)   ; the record from either table, with its `source`
(free.block-history.latest)              ; the highest attested height
```

## Verify the deployed module

Each release lists its commit, the module hash and the sha256 of the module source.

- The module hash is computed by the engine, excludes comments, and is the same on all 20 chains.
  The expected mainnet hash, computed by mainnet's own engine in a read-only dry run, is
  `0QAb21uNo_4x2OV1YbOvR3ax-ta8kKZi8hzoY97GCKI`.
- `(describe-module "free.block-history")` on any chain returns that `hash`, and a `code` field
  holding the source from `(module` to its closing parenthesis — compare it with the file.
- `npm run preflight` (read-only) prints the hash every chain reports.
- The hash proves the code, not the starting state: the transaction that deploys a module can also
  write to its tables. So check that each chain's deploy transaction carries exactly the published
  file and nothing else. The request keys of the 20 deploy transactions are listed here once the
  module is deployed.

## Evidence

- REPL: `pact/tests/run.sh` — static gate, every negative names its error, the suites (lifecycle,
  branch-complete negatives, vision pins, gas, and `namespace-claim.repl` — the keyset facts the
  two-pass deploy rests on), the frozen fixture refused for the stated reason, generated mutants
  each turning `vision-pin.repl` RED, and a DML inventory (one `insert` per record table, no `update`).
- Node: `ts/src/devnet-negatives.ts` re-proves every refusal by preflight on a live node, in
  both window states, with positive controls.
- Differential: `ts/src/oracle.ts` walks the node's canonical headers back from the cut and
  compares hash and microsecond time for every height. Numbers below.
- CI runs the suite, the typecheck and tool self-checks, shellcheck, and a leak scan on every push.

### Measured on devnet (`recap-development`, chainweb-node 3.2.1, 20 chains, ~0.85 blocks/s/chain)
| Item | Value |
|---|---|
| Module hash (identical on all 20 chains) | `0QAb21uNo_4x2OV1YbOvR3ax-ta8kKZi8hzoY97GCKI` |
| Deploy gas per chain | 10,824 |
| `attest` gas (record / duplicate no-op) | 205 / ~150 (sampled 180 mined, 0 failed) |
| `backfill` gas, 500-row batch | 48,213 (≈96 per row) |
| `close-backfill` gas | 119 |
| Feeder soak, 5 min, 20 chains | 4,304 events, 4,304 submitted, 0 submit errors, 0 reconnects |
| Event→submit latency | p50 151 ms, p90 387 ms, p99 2.2 s |
| Coverage in the feeder's active window (4,260 heights) | **99.30 %**, 30 gaps, 0 mismatches |
| Chain 2 end to end, heights 0..1103 (892 backfilled + 210 attested) | 99.82 %, 2 gaps, 0 mismatches |
| Projected mainnet gas, all 20 chains, one feeder | ≈42 KDA/year at 205 gas × 1e-8 |
| Mainnet header stream (read-only, 240 s, public proxy) | all 20 chains on one connection, 167 events, 0.70 blocks/s network-wide, 0 unparseable |

One feeder burns ≈0.0059 KDA per chain per day: 0.5 KDA per chain (10 KDA total) is ≈84 days,
and a year on all 20 chains is ≈43 KDA. The deploy itself is ≈0.0026 KDA in total.

### Deploy-ceremony rehearsal
- Rehearsed end to end on a fresh devnet with a real 2-of-3 backfill keyset: 20 chains, one hash,
  preflight GO, feeder 99.41 % coverage, oracle CONSISTENT (0 mismatches).
- Two deploy bugs found and fixed by that rehearsal: the unsigned flow emitted the module
  command without confirming the keyset had landed (in an open namespace a stranger could then
  claim the keyset and own backfill forever), and it named the local devnet key as signer instead
  of the gas payer, making every emitted file unsignable.

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
manager, and the ssh reload. Each stops loudly if it fails. Three bugs were found by rehearsing
and fixed: the SSH hardening file was silently overridden by cloud-init (sshd keeps the FIRST
value it reads); its verification — first written as `sshd -T | grep -q` under pipefail —
reported "still ON" for a hardened host (SIGPIPE); and step 2 called apt-get directly, so a fresh
droplet's own first-minutes apt jobs stopped it on "Could not get lock". `-o DPkg::Lock::Timeout`
covers the install lock but NOT the package-list lock, so step 2 retries while any apt lock is
held and reports any other failure at once.

### Backfill sizing (from live mainnet heights)
Mainnet sum over 20 chains ≈ 144.3M blocks. `backfill` costs ≈96 gas/row, 500 rows/tx, ≈1,565 B/row.
| Scope | Rows | Transactions | Gas cost | Permanent per node |
|---|---|---|---|---|
| Full genesis, 20 chains | 144.3M | 288,569 | ≈138 KDA | ≈226 GB |
| Chain 2 only, full | 7.2M | 14,428 | ≈7 KDA | ≈11 GB |
| Last 30 days, 20 chains | 1.7M | 3,456 | ≈1.7 KDA | ≈2.7 GB |

Full genesis is 8-80 h of continuous submission and ≈7x the record's own yearly growth, as a
one-off. Every backfill transaction needs 2 of the 3 backfill keys, so the scope decides how many
signatures the run takes.

## Operate — `ts/`

```
cp ts/.env.example ts/.env        # host, network, namespace, chains, key paths
cd ts && npm install && npm run typecheck && npm run test-tools
npm run deploy                    # devnet: creates + funds keys, deploys all chains, verifies one hash
npm run stream-check -- --seconds 240   # read-only: is the node's header stream alive for every chain?
npm run balances -- k:<account>   # read-only: KDA per chain and feeder runway; unreachable ≠ zero
npm run feeder                    # one process, all chains, SSE-driven; --duration N for a soak
npm run oracle -- --last 600      # CONSISTENT / FAIL, coverage per chain
npm run backfill -- --chain 2 --from 0 --to 12000 --dry-run    # plan; drop --dry-run to write
BH_CONFIRM_CLOSE=2 npm run backfill -- --chain 2 --close        # one-way
npm run devnet-negatives -- --chain 2
```

The feeder supplies liveness, not data. It listens to the node's `/header/updates` stream (all
20 chains on one connection), signs an `attest` per new block anchored to that block's own
creation time, and submits with a tight gas limit (400). Coverage is a reaction-latency
problem: measured 99.3 % on a devnet running ~25× mainnet's block rate.

Sequence for a network: **deploy → run the feeder → backfill once (history plus the gaps the
feeder actually lost) → close → run the oracle forever.** Closing is the only one-way door.

### Run your own recorder

`attest` is permissionless and idempotent, so anyone can run the feeder with their own funded
account, and recorders never conflict: a block is lost only when every recorder misses it. A
recorder cannot corrupt the record — `attest` takes no arguments and writes only what the engine
supplies — so the worst case for a leaked feeder key is its own drained gas balance. Give the
feeder an account of its own that holds only gas and authorises nothing else.

### Run the feeder on a server

One small always-on machine with a public IPv4 address. Measured requirements:

- **1 GiB of memory.** The feeder peaks at ~200 MB resident; a 512 MB server leaves Ubuntu nothing
  to spare, and a feeder that swaps reacts late, which is exactly what costs coverage. The public
  node the feeder uses, `chainweb.eckowallet.com`, is in Gravelines, France, so a nearby region
  reacts sooner.
- **On DigitalOcean, a Bundled plan, not v5.** A v5 droplet bills its public IPv4 address
  separately and has no monthly usage cap; a Bundled plan includes the IPv4 address and caps
  billing at 672 hours a month. The feeder needs IPv4 — see the next point.
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

It pins Node by sha256; clones this repository and checks out exactly `<commit>`, refusing
anything else (full commit id, fsck, clean tree, and the script compares itself byte-for-byte to
its own copy inside that commit); leaves the code owned by root and only readable by an
unprivileged `blockhistory` user; generates the feeder key **on the droplet** (0600, never
printed, never regenerated on a re-run); sets the firewall to inbound SSH only; turns off
password SSH only when a key is installed, and checks the setting sshd will actually use with
`sshd -T`; enables unattended security upgrades and log rotation; installs the systemd unit
**without enabling it**; and proves the droplet sees every chain's block stream under the
service's own sandbox. It ends by printing the feeder account to fund. It is safe to re-run.
`BH_REPO` points it at another git source (a local path or a bundle), which is how it is
rehearsed.

Enabling the service is the step that sends mainnet transactions:

```
systemctl enable --now block-history-feeder
journalctl -u block-history-feeder -f
```

Started before the module is deployed, the feeder refuses on the first chain and sends nothing.
Five failed starts in 30 minutes make systemd stop trying rather than hammer the node; clear that
with `systemctl reset-failed block-history-feeder`. `npm run keygen -- <path>` makes a key file and
refuses to overwrite one.

### Deploying to a network — two passes

In `free`, the user guard is `ns.success`, so every name there is first-come and **claiming an
unclaimed name needs no signature at all** (proven in the REPL: `define-keyset` succeeds under
`env-sigs []`). Rotating a claimed name does require the current keys (1-of-3 refused, 2-of-3
accepted). So whoever claims `free.block-history-backfill` on a chain owns backfill there
**forever**, because the module can never be upgraded.

**That is why the deploy is two passes, and why the tool refuses to shortcut it.** The module is
never emitted or sent for a chain whose keyset is not already on chain with the intended keys.

```
# 0. READ-ONLY readiness. Sends nothing. Exit 0 = GO, 1 = not ready, 2 = a name is LOST.
#    The decisive check runs the real module source on the target engine via /local.
npm run preflight

# 1. FIRST PASS: keyset commands only (one per chain, into ts/out/unsigned/)
npm run deploy -- --unsigned

# 2. Sign the gas payer's slot of every file, check it and preflight it on the node — nothing
#    is sent — then send them one by one, and confirm they landed
npm run send-signed -- --gas-key <gas-key.json> out/unsigned/*.json
npm run send-signed -- --gas-key <gas-key.json> --send out/unsigned/*.json
npm run preflight                     # keyset column must read "ours ✓" on every chain

# 3. SECOND PASS: now the module commands are written; sign and send them the same way
npm run deploy -- --unsigned
npm run send-signed -- --gas-key <gas-key.json> out/unsigned/*.json
npm run send-signed -- --gas-key <gas-key.json> --send out/unsigned/*.json

# 4. Verify, then start capturing
npm run preflight                     # module column shows the same hash everywhere
npm run stream-check -- --seconds 240
npm run feeder
npm run oracle -- --last 600          # must print CONSISTENT
```

**Signing.** Deploying needs only **gas**: neither the keyset definition nor the module deploy
requires a keyset signature, because claiming an unclaimed name in `free` is unauthenticated. So each
file carries one signer, the gas payer, scoped to `coin.GAS`. `send-signed --gas-key` rebuilds each file
from what it must contain — the backfill keyset definition carrying `BH_BACKFILL_KEYSET`, or the exact
module source — at `BH_GAS_PRICE` (at most 1e-7) and the deploy's gas limits, and signs it only if the
bytes match exactly. Without `--send`, nothing signed leaves the machine: each command is checked on the
node unsigned. With `--send`, the maximum fee is printed first, a module command goes only where the
keyset is already ours, and each command is preflighted signed just before it is submitted. The key
file must be readable by its owner alone; its secret is never printed; a re-run skips whatever is
already on chain.
The 2-of-3 backfill keyset is the keyset *content* — the authority that lasts, used for backfill
and for `close-backfill`. At 500 rows per transaction a large backfill takes thousands of
signatures, so scope it deliberately.

## Known limits (by design)
- 100 % capture is unreachable; gaps are honest and, after the close, permanent.
- Every row is permanent on every node (Pact has no delete): ≈33 GB per node per year for all
  20 chains, a deliberate trade-off.
- A backfilled row is only as good as the operator's node at write time; the tool never writes
  within 30 blocks of the tip, and the oracle audits it forever.
- Node-serialised times: Pact's JSON codec renders a millisecond-aligned time without its
  fraction (`Legacy/LegacyCodec.hs:126-128,153-154`). The row is exact; read times through
  `format-time` off-chain, as the oracle does.

## License

Apache License 2.0 — see `LICENSE` and `NOTICE`. The module carries the same identifier inside
its `(module …)` form, so the license travels with the source the chain stores.
