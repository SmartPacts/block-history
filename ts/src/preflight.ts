// preflight.ts — READ-ONLY deployment readiness. Sends nothing, signs nothing, spends nothing.
//
// Every check is a /local query or a status lookup. The decisive one is the DRY RUN: the real module source
// is executed against the target network's own engine, so a GO means the deploy transaction would
// have succeeded, not that it looks plausible. A missing prerequisite is NO-GO, never a warning.
//
// A chain that already carries the module name counts as ours only if one of the operator's deploy files
// (out/unsigned/<network-id>/, as deploy --unsigned wrote them) has a request key — the file's own hash —
// whose status on that chain is success (lib.ts: ownership). The hash alone never makes a chain ours: it
// covers the (module …) form only, so a copy someone else deployed, with rows of its own written in the
// same transaction, carries the same hash. Run preflight from the checkout that holds those files.
//
//   npm run preflight                         check every configured chain
//   npm run preflight -- --chains 0,1          check a subset
//   BH_HOST=https://chainweb.eckowallet.com BH_NETWORK_ID=mainnet01 npm run preflight
//
// Exit 0 = GO on every chain. Exit 1 = at least one chain is not ready, or the chains do not all carry
// one hash. Exit 2 = a chain is LOST: its module name is held by a module that none of the operator's
// deploy files created, whatever its hash. A name is first-come, so that is unrecoverable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainId } from '@kadena/client';
import { API, NETWORK_ID, NS, MODULE, ROOT, parseChains, local, balance, readDeployFiles, ownershipOn, type Ownership } from './lib.js';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const CHAINS = parseChains(opt('chains', process.env.BH_CHAINS ?? '0-19'));
const SOURCE = readFileSync(join(ROOT, 'pact', 'modules', 'block-history.pact'), 'utf8');
const GAS_ACCOUNT = process.env.BH_ADMIN_ACCOUNT ?? '';
// The module deploy's maximum fee at the 1e-8 floor (120,000 gas = 0.0012 KDA), plus headroom for the
// feeder to start.
const MIN_KDA = Number(process.env.BH_MIN_KDA ?? '0.02');
const EXPECT = { networkId: NETWORK_ID, ns: NS, source: SOURCE };
const DIR = `out/unsigned/${NETWORK_ID}/`;
const { files: FILES, refused: REFUSED } = readDeployFiles(EXPECT);
const SHOWN: Record<Ownership, string> = { available: 'available', ours: 'DEPLOYED ✓ ours', lost: 'LOST (not ours)' };

type Row = { chain: ChainId; ns: string; mod: string; latest: string; gas: string; dry: string; hash: string; deployed: boolean; verdict: 'GO' | 'NOT READY' | 'LOST' };

async function checkChain(c: ChainId): Promise<Row> {
  const r: Row = { chain: c, ns: '?', mod: '?', latest: '-', gas: '?', dry: '?', hash: '', deployed: false, verdict: 'NOT READY' };
  let ready = true;

  // 1. the namespace must exist
  const ns = await local(`(describe-namespace ${JSON.stringify(NS)})`, { chainId: c }).catch(() => null);
  if (ns) r.ns = 'present'; else { r.ns = 'MISSING'; ready = false; }

  // 2. the module name: available, ours, or LOST — decided by the operator's deploy files, never by the hash.
  const mod = await local(`(describe-module ${JSON.stringify(MODULE)})`, { chainId: c }).catch(() => null);
  const who = await ownershipOn(c, !!mod, FILES, EXPECT);
  r.mod = SHOWN[who];
  if (mod) {
    r.deployed = true; r.hash = String(mod.hash);
    // The height `latest` reports: -1 until the feeder records a block. Confirm it before the feeder starts.
    r.latest = await local(`(${MODULE}.latest)`, { chainId: c }).then((l) => String(l?.height), () => '?');
  }

  // 3. gas
  if (GAS_ACCOUNT) {
    const bal = await balance(GAS_ACCOUNT, c);
    r.gas = `${bal.toFixed(4)} KDA`;
    if (bal < MIN_KDA) { r.gas += ` < ${MIN_KDA}`; ready = false; }
  } else { r.gas = 'no BH_ADMIN_ACCOUNT set'; ready = false; }

  // 4. THE DRY RUN — execute the real module source on the target engine, read-only, and make
  //    it report the hash the engine itself computes. That PRE-REGISTERS the hash the deploy
  //    will produce, so byte-identity can be checked afterwards instead of taken on trust.
  //    Skipped only where the name is already held (redefining it would run that module's governance).
  if (mod) r.dry = 'n/a (deployed)';
  else {
    try {
      const described = await local(`${SOURCE}\n(describe-module ${JSON.stringify(MODULE)})`, { chainId: c, data: { ns: NS }, gasLimit: 150000 });
      r.hash = String(described.hash);
      r.dry = 'COMPILES + LOADS ✓';
    } catch (e: any) { r.dry = `FAILED: ${String(e?.message ?? e).slice(0, 70)}`; ready = false; }
  }

  r.verdict = who === 'lost' ? 'LOST' : ready ? 'GO' : 'NOT READY';
  return r;
}

const line = (chain: string, ns: string, mod: string, latest: string, gas: string, dry: string, verdict: string) =>
  `${chain.padStart(5)}  ${ns.padEnd(9)}  ${mod.padEnd(15)}  ${latest.padStart(6)}  ${gas.padEnd(11)}  ${dry.padEnd(20)}  ${verdict}`;

async function main() {
  console.log(`\n=== block-history PREFLIGHT (read-only; nothing is sent) ===`);
  console.log(`  target   ${API}`);
  console.log(`  network  ${NETWORK_ID}   namespace ${NS}   module ${MODULE}`);
  console.log(`  gas payer ${GAS_ACCOUNT || '(not set)'}   minimum ${MIN_KDA} KDA/chain`);
  if (FILES.length) console.log(`  deploy files  ${FILES.length} for ${MODULE} in ${DIR} — a chain's module is ours only if one of them created it`);
  else console.log(`  deploy files  NONE for ${MODULE} in ${DIR} — ownership cannot be proven, so a chain that already carries the module counts as LOST`);
  for (const f of REFUSED) console.log(`  note: ${DIR}${f.file} proves nothing — ${f.why}`);
  console.log('');

  const rows: Row[] = [];
  const queue = [...CHAINS];
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) rows.push(await checkChain(queue.shift()!));
  }));
  rows.sort((a, b) => Number(a.chain) - Number(b.chain));

  console.log(line('chain', 'namespace', 'module name', 'latest', 'gas', 'module dry run', 'verdict'));
  for (const r of rows) console.log(line(String(r.chain), r.ns, r.mod, r.latest, r.gas, r.dry, r.verdict));
  const hashes = new Set(rows.map((r) => r.hash).filter(Boolean));
  if (hashes.size === 1) console.log(`\n  module hash, computed by the engine or deployed, on EVERY chain: ${[...hashes][0]}`);
  else if (hashes.size > 1) console.log(`\n  🔴 the chains do not carry one hash: ${[...hashes].join(' ')}`);
  if (rows.every((r) => r.deployed)) console.log(`  every chain already carries the name, so nothing was dry-run: compare that hash with the one a preflight printed before the deploy`);
  const lost = rows.filter((r) => r.verdict === 'LOST');
  const notReady = rows.filter((r) => r.verdict === 'NOT READY');
  const go = rows.filter((r) => r.verdict === 'GO');
  console.log(`\n  GO ${go.length}/${rows.length}   not ready ${notReady.length}   LOST ${lost.length}`);
  if (lost.length) {
    console.log(`\n  🔴 LOST: ${lost.map((r) => r.chain).join(',')} — ${MODULE} there was not created by any deploy file in ${DIR}:`);
    console.log(`     no request key of theirs succeeded on these chains. Its hash can still be the right one: a module hash`);
    console.log(`     covers the (module …) form only, and whoever deployed it could write rows or \`latest\` in that same transaction.`);
    if (!FILES.length) console.log(`     There is no deploy file here at all: run preflight from the checkout that wrote and sent them.`);
    console.log(`     A name in ${NS} is first-come and cannot be taken back: choose a different module name, or drop these chains.`);
    process.exit(2);
  }
  if (notReady.length) { console.log(`\n  NOT READY: ${notReady.map((r) => r.chain).join(',')} — fix the column that is not ✓ above.`); process.exit(1); }
  if (hashes.size > 1) { console.log(`\n  NOT READY: one source in one namespace must hash identically everywhere — find the chain that differs before sending anything.`); process.exit(1); }
  console.log(`\n  VERDICT: GO — every chain is ready. Nothing has been sent.`);
}
main().catch((e) => { console.error(`\nPREFLIGHT FAILED: ${e?.message ?? e}`); process.exit(1); });
