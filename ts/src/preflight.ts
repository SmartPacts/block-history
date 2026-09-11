// preflight.ts — READ-ONLY deployment readiness. Sends nothing, signs nothing, spends nothing.
//
// Every check is a /local query. The decisive one is the DRY RUN: the real module source is
// executed against the target network's own engine, so a GO means the deploy transaction would
// have succeeded, not that it looks plausible. A missing prerequisite is NO-GO, never a warning.
//
//   npm run preflight                         check every configured chain
//   npm run preflight -- --chains 0,1          check a subset
//   BH_HOST=https://chainweb.eckowallet.com BH_NETWORK_ID=mainnet01 npm run preflight
//
// Exit 0 = GO on every chain. Exit 1 = at least one chain is not ready, or the chains do not all carry
// one hash. Exit 2 = a chain is LOST: its module name is held by a module whose hash is not the one the
// dry run computes for this source. A name is first-come, so that is unrecoverable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainId } from '@kadena/client';
import { API, NETWORK_ID, NS, MODULE, ROOT, parseChains, local, balance } from './lib.js';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const CHAINS = parseChains(opt('chains', process.env.BH_CHAINS ?? '0-19'));
const SOURCE = readFileSync(join(ROOT, 'pact', 'modules', 'block-history.pact'), 'utf8');
const GAS_ACCOUNT = process.env.BH_ADMIN_ACCOUNT ?? '';
// The module deploy's maximum fee at the 1e-8 floor (120,000 gas = 0.0012 KDA), plus headroom for the
// feeder to start.
const MIN_KDA = Number(process.env.BH_MIN_KDA ?? '0.02');


type Row = { chain: ChainId; ns: string; mod: string; gas: string; dry: string; hash: string; deployed: boolean; verdict: 'GO' | 'NOT READY' | 'LOST' };

async function checkChain(c: ChainId): Promise<Row> {
  const r: Row = { chain: c, ns: '?', mod: '?', gas: '?', dry: '?', hash: '', deployed: false, verdict: 'NOT READY' };
  let ready = true;

  // 1. the namespace must exist
  const ns = await local(`(describe-namespace ${JSON.stringify(NS)})`, { chainId: c }).catch(() => null);
  if (ns) r.ns = 'present'; else { r.ns = 'MISSING'; ready = false; }

  // 2. the module name: available, or held. Whether a held name is ours is decided in main(), against
  //    the hash the dry run computes.
  const mod = await local(`(describe-module ${JSON.stringify(MODULE)})`, { chainId: c }).catch(() => null);
  if (!mod) r.mod = 'available';
  else { r.deployed = true; r.hash = String(mod.hash); r.mod = `DEPLOYED ${r.hash.slice(0, 12)}…`; }

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

  r.verdict = ready ? 'GO' : 'NOT READY';
  return r;
}

async function main() {
  console.log(`\n=== block-history PREFLIGHT (read-only; nothing is sent) ===`);
  console.log(`  target   ${API}`);
  console.log(`  network  ${NETWORK_ID}   namespace ${NS}   module ${MODULE}`);
  console.log(`  gas payer ${GAS_ACCOUNT || '(not set)'}   minimum ${MIN_KDA} KDA/chain\n`);

  const rows: Row[] = [];
  const queue = [...CHAINS];
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) rows.push(await checkChain(queue.shift()!));
  }));
  rows.sort((a, b) => Number(a.chain) - Number(b.chain));

  // A held name is ours when its hash is the one the dry run computes for this source; any other hash
  // there is another module, and that chain is LOST. With no chain left to dry-run, the held names can
  // only be compared with each other (below) and with the hash an earlier preflight printed.
  const computed = new Set(rows.filter((r) => !r.deployed && r.hash).map((r) => r.hash));
  const want = computed.size === 1 ? [...computed][0] : null;
  for (const r of rows) {
    if (!r.deployed || want === null) continue;
    if (r.hash === want) r.mod = 'DEPLOYED ✓';
    else { r.mod = `TAKEN ${r.hash.slice(0, 12)}…`; r.verdict = 'LOST'; }
  }

  console.log('chain  namespace  module name   gas          module dry run        verdict');
  for (const r of rows) {
    console.log(`${String(r.chain).padStart(5)}  ${r.ns.padEnd(9)}  ${r.mod.padEnd(12)}  ${r.gas.padEnd(11)}  ${r.dry.padEnd(20)}  ${r.verdict}`);
  }
  const hashes = new Set(rows.map((r) => r.hash).filter(Boolean));
  if (hashes.size === 1) console.log(`\n  module hash, computed by the engine or deployed, on EVERY chain: ${[...hashes][0]}`);
  else if (hashes.size > 1) console.log(`\n  🔴 the chains do not carry one hash: ${[...hashes].join(' ')}`);
  if (rows.every((r) => r.deployed)) console.log(`  every chain already carries the name, so nothing was dry-run: compare that hash with the one a preflight printed before the deploy`);
  const lost = rows.filter((r) => r.verdict === 'LOST');
  const notReady = rows.filter((r) => r.verdict === 'NOT READY');
  const go = rows.filter((r) => r.verdict === 'GO');
  console.log(`\n  GO ${go.length}/${rows.length}   not ready ${notReady.length}   LOST ${lost.length}`);
  if (lost.length) {
    console.log(`\n  🔴 LOST: ${lost.map((r) => r.chain).join(',')} — ${MODULE} there is a module with another hash, not this source.`);
    console.log(`     A name in ${NS} is first-come and cannot be taken back, so these chains cannot carry`);
    console.log(`     this module under this name. Choose a different module name, or drop them.`);
    process.exit(2);
  }
  if (notReady.length) { console.log(`\n  NOT READY: ${notReady.map((r) => r.chain).join(',')} — fix the column that is not ✓ above.`); process.exit(1); }
  if (hashes.size > 1) { console.log(`\n  NOT READY: one source in one namespace must hash identically everywhere — find the chain that differs before sending anything.`); process.exit(1); }
  console.log(`\n  VERDICT: GO — every chain is ready. Nothing has been sent.`);
}
main().catch((e) => { console.error(`\nPREFLIGHT FAILED: ${e?.message ?? e}`); process.exit(1); });
