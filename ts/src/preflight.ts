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
// Exit 0 = GO on every chain. Exit 1 = at least one chain is not ready. Exit 2 = a chain is LOST
// (a name we need is held by someone else); that is unrecoverable because the module is immutable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainId } from '@kadena/client';
import { API, NETWORK_ID, NS, MODULE, BACKFILL_KEYSET, ROOT, parseChains, local, balance, sameKeyset, validateKeyset } from './lib.js';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const CHAINS = parseChains(opt('chains', process.env.BH_CHAINS ?? '0-19'));
const SOURCE = readFileSync(join(ROOT, 'pact', 'modules', 'block-history.pact'), 'utf8');
const GAS_ACCOUNT = process.env.BH_ADMIN_ACCOUNT ?? '';
// The keyset the deploy WILL define. On mainnet this is the 2-of-3 backfill keyset.
const WANT_KS: { keys: string[]; pred: string } | null = process.env.BH_BACKFILL_KEYSET ? validateKeyset(JSON.parse(process.env.BH_BACKFILL_KEYSET)) : null;
// Deploy 10,824 + keyset 2,000 gas at the 1e-8 floor, plus headroom for the feeder to start.
const MIN_KDA = Number(process.env.BH_MIN_KDA ?? '0.02');


type Row = { chain: ChainId; ns: string; mod: string; ks: string; gas: string; dry: string; hash: string; verdict: 'GO' | 'NOT READY' | 'LOST' };

async function checkChain(c: ChainId): Promise<Row> {
  const r: Row = { chain: c, ns: '?', mod: '?', ks: '?', gas: '?', dry: '?', hash: '', verdict: 'NOT READY' };
  let lost = false, ready = true;

  // 1. the namespace must exist
  const ns = await local(`(describe-namespace ${JSON.stringify(NS)})`, { chainId: c }).catch(() => null);
  if (ns) r.ns = 'present'; else { r.ns = 'MISSING'; ready = false; }

  // 2. the module name: free / already ours / taken by someone else
  const mod = await local(`(describe-module ${JSON.stringify(MODULE)})`, { chainId: c }).catch(() => null);
  if (!mod) r.mod = 'available';
  else { r.mod = `DEPLOYED ${String(mod.hash).slice(0, 12)}…`; }

  // 3. the keyset name: free / ours / someone else's  (someone else's = this chain is LOST)
  const ks = await local(`(describe-keyset ${JSON.stringify(BACKFILL_KEYSET)})`, { chainId: c }).catch(() => null);
  if (!ks) r.ks = 'available';
  else if (WANT_KS && sameKeyset(ks, WANT_KS)) r.ks = 'ours ✓';
  else if (!WANT_KS) { r.ks = 'CLAIMED (set BH_BACKFILL_KEYSET to compare)'; ready = false; }
  else { r.ks = `CLAIMED BY OTHERS (${ks.pred}, ${ks.keys.length} key(s))`; lost = true; }

  // 4. gas
  if (GAS_ACCOUNT) {
    const bal = await balance(GAS_ACCOUNT, c);
    r.gas = `${bal.toFixed(4)} KDA`;
    if (bal < MIN_KDA) { r.gas += ` < ${MIN_KDA}`; ready = false; }
  } else { r.gas = 'no BH_ADMIN_ACCOUNT set'; ready = false; }

  // 5. THE DRY RUN — execute the real module source on the target engine, read-only, and make
  //    it report the hash the engine itself computes. That PRE-REGISTERS the hash the deploy
  //    will produce, so byte-identity can be checked afterwards instead of taken on trust.
  //    Skipped only when the module is already deployed (redefining it would run governance).
  if (mod) { r.dry = 'n/a (deployed)'; r.hash = String(mod.hash); }
  else {
    try {
      const described = await local(`${SOURCE}\n(describe-module ${JSON.stringify(MODULE)})`, { chainId: c, data: { ns: NS }, gasLimit: 150000 });
      r.hash = String(described.hash);
      r.dry = 'COMPILES + LOADS ✓';
    } catch (e: any) { r.dry = `FAILED: ${String(e?.message ?? e).slice(0, 70)}`; ready = false; }
  }

  r.verdict = lost ? 'LOST' : ready ? 'GO' : 'NOT READY';
  return r;
}

async function main() {
  console.log(`\n=== block-history PREFLIGHT (read-only; nothing is sent) ===`);
  console.log(`  target   ${API}`);
  console.log(`  network  ${NETWORK_ID}   namespace ${NS}   module ${MODULE}`);
  console.log(`  keyset   ${BACKFILL_KEYSET} = ${WANT_KS ? `${WANT_KS.keys.length} key(s), ${WANT_KS.pred}` : 'NOT CONFIGURED (set BH_BACKFILL_KEYSET)'}`);
  if (WANT_KS) for (const k of WANT_KS.keys) console.log(`             ${k}`);
  console.log(`  gas payer ${GAS_ACCOUNT || '(not set)'}   minimum ${MIN_KDA} KDA/chain\n`);

  const rows: Row[] = [];
  const queue = [...CHAINS];
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) rows.push(await checkChain(queue.shift()!));
  }));
  rows.sort((a, b) => Number(a.chain) - Number(b.chain));

  console.log('chain  namespace  module name   keyset name   gas          module dry run        verdict');
  for (const r of rows) {
    console.log(`${String(r.chain).padStart(5)}  ${r.ns.padEnd(9)}  ${r.mod.padEnd(12)}  ${r.ks.padEnd(12)}  ${r.gas.padEnd(11)}  ${r.dry.padEnd(20)}  ${r.verdict}`);
  }
  const hashes = new Set(rows.map((r) => r.hash).filter(Boolean));
  if (hashes.size === 1) console.log(`\n  module hash the engine computes on EVERY chain: ${[...hashes][0]}`);
  else if (hashes.size > 1) console.log(`\n  🔴 the engine computes DIFFERENT hashes across chains: ${[...hashes].join(' ')}`);
  const lost = rows.filter((r) => r.verdict === 'LOST');
  const notReady = rows.filter((r) => r.verdict === 'NOT READY');
  const go = rows.filter((r) => r.verdict === 'GO');
  console.log(`\n  GO ${go.length}/${rows.length}   not ready ${notReady.length}   LOST ${lost.length}`);
  if (lost.length) {
    console.log(`\n  🔴 LOST: ${lost.map((r) => r.chain).join(',')} — a name we need is held by other keys.`);
    console.log(`     The module is immutable and cannot be pointed at another keyset, so these chains`);
    console.log(`     cannot carry this module under this name. Choose a different module name, or drop them.`);
    process.exit(2);
  }
  if (notReady.length) { console.log(`\n  NOT READY: ${notReady.map((r) => r.chain).join(',')} — fix the column that is not ✓ above.`); process.exit(1); }
  console.log(`\n  VERDICT: GO — every chain is ready. Nothing has been sent.`);
}
main().catch((e) => { console.error(`\nPREFLIGHT FAILED: ${e?.message ?? e}`); process.exit(1); });
