// backfill.ts — fill the gaps the feeder could not, from the node's own headers, then close.
//
// TRUST: rows written here are trusted at write time (the platform cannot verify a historical
// block hash in-contract). Everything this tool writes is auditable forever against the node
// (npm run oracle), and the module refuses anything it can judge locally: a height attest can
// still record, a malformed hash, an attested height, a conflicting re-send.
//
//   npm run backfill -- --chain 2 --from 0 --to 12000            write every missing height in range
//   npm run backfill -- --chain 2 --from 0 --to 12000 --dry-run  plan only: gaps, batches, cost
//   npm run backfill -- --chain 2 --close                        close the window on chain 2 (needs BH_CONFIRM_CLOSE=2)
//   npm run backfill -- --chain 2 --from 0 --to 12000 --unsigned write batch files for wallet signing
// Options: --depth N (default 30: never touch the top N blocks — reorg safety),
//          --batch N (rows per transaction, default 500), --gas-limit N (default 90000)
// Every height in [from, to] is scanned on chain first; only MISSING heights are written.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainId } from '@kadena/client';
import { Pact } from '@kadena/client';
import {
  API, NETWORK_ID, MODULE, GAS_PRICE, OUT, isDevnet, keyPath, loadOrCreateKey, accountOf,
  local, send, cut, canonicalHeaders, pactTime, chainTime, type TxSpec, type Header,
} from './lib.js';

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name: string) => args.includes(`--${name}`);
const CHAIN = opt('chain') as ChainId | undefined;
const FROM = Number(opt('from', 'NaN')), TO = Number(opt('to', 'NaN'));
const DEPTH = Number(opt('depth', '30'));
const BATCH = Number(opt('batch', '500'));
const GAS_LIMIT = Number(opt('gas-limit', '90000'));
const DRY = flag('dry-run'), CLOSE = flag('close'), UNSIGNED = flag('unsigned');
if (!CHAIN) { console.error('--chain <id> is required'); process.exit(2); }

const backfill = loadOrCreateKey(keyPath('BH_BACKFILL_KEY', 'out/backfill-key.json'), false);
const sender = process.env.BH_BACKFILL_ACCOUNT ?? accountOf(backfill);
const signers = [{ kp: backfill, caps: (wc: any) => [wc('coin.GAS'), wc(`${MODULE}.BACKFILL`)] }];

let seq = 0;
async function writeUnsigned(s: TxSpec): Promise<void> {
  const now = await chainTime(s.chainId);
  let b: any = Pact.builder.execution(s.code).addSigner(backfill.publicKey, (wc: any) => [wc('coin.GAS'), wc(`${MODULE}.BACKFILL`)]);
  for (const [k, v] of Object.entries(s.data ?? {})) b = b.addData(k, v);
  const tx = b.setMeta({ chainId: s.chainId, senderAccount: s.sender, gasLimit: s.gasLimit, gasPrice: GAS_PRICE, ttl: 28800, creationTime: Math.floor(now.getTime() / 1000) - 15 })
    .setNetworkId(NETWORK_ID).createTransaction();
  mkdirSync(join(OUT, 'unsigned'), { recursive: true });
  const p = join(OUT, 'unsigned', `backfill-chain${s.chainId}-${String(++seq).padStart(4, '0')}.json`);
  writeFileSync(p, JSON.stringify({ cmd: tx.cmd, hash: tx.hash, sigs: [{ pubKey: backfill.publicKey }] }, null, 2) + '\n');
  console.log(`  ✎ ${s.label} → ${p}`);
}

// Which heights in [a, b] have no record on chain? One /local per 2,000 heights.
async function missingHeights(c: ChainId, a: number, b: number): Promise<number[]> {
  const out: number[] = [];
  for (let lo = a; lo <= b; lo += 2000) {
    const hi = Math.min(b, lo + 1999);
    const has: boolean[] = await local(`(map (lambda (h:integer) (${MODULE}.has-block h)) (enumerate ${lo} ${hi}))`, { chainId: c });
    has.forEach((v, i) => { if (!v) out.push(lo + i); });
  }
  return out;
}

async function closeWindow(c: ChainId) {
  const st = await local(`(${MODULE}.backfill-status)`, { chainId: c });
  if (!st.open) { console.log(`chain ${c}: backfill window already closed at height ${st['closed-at']}`); return; }
  if (process.env.BH_CONFIRM_CLOSE !== String(c)) throw new Error(`closing is permanent. Re-run with BH_CONFIRM_CLOSE=${c} to close the window on chain ${c}`);
  const s: TxSpec = { label: `close-backfill chain ${c}`, chainId: c, sender, code: `(${MODULE}.close-backfill)`, signers, gasLimit: 1500 };
  if (UNSIGNED) { await writeUnsigned(s); return; }
  await send(s);
  const after = await local(`(${MODULE}.backfill-status)`, { chainId: c });
  if (after.open) throw new Error(`chain ${c}: window still open after close`);
  console.log(`chain ${c}: backfill window CLOSED at height ${after['closed-at']}`);
}

async function main() {
  const c = CHAIN!;
  console.log(`\n=== block-history backfill → ${API} chain ${c} ${DRY ? '(DRY RUN)' : ''}${UNSIGNED ? '(UNSIGNED)' : ''} ===`);
  if (CLOSE) { await closeWindow(c); return; }
  if (!Number.isFinite(FROM) || !Number.isFinite(TO) || FROM < 0 || TO < FROM) throw new Error('--from A --to B (0 <= A <= B) are required');
  const st = await local(`(${MODULE}.backfill-status)`, { chainId: c });
  if (!st.open) throw new Error(`chain ${c}: the backfill window is closed (at height ${st['closed-at']}); nothing can be written`);
  const top = (await cut())[c].height;
  // Never write near the tip: attest owns the frontier, and a block under DEPTH confirmations
  // may still be reorganised — a reorged backfill row would be permanently wrong.
  const to = Math.min(TO, top - DEPTH - 2);
  if (to < FROM) { console.log(`chain ${c}: nothing eligible — cut ${top}, depth ${DEPTH}, so the highest backfillable height is ${top - DEPTH - 2}`); return; }
  console.log(`  cut ${top}; scanning [${FROM}, ${to}] for missing heights …`);
  const missing = await missingHeights(c, FROM, to);
  console.log(`  ${missing.length} missing of ${to - FROM + 1} heights`);
  if (!missing.length) return;

  // Canonical headers for the missing heights, fetched by contiguous runs.
  const runs: [number, number][] = [];
  for (const h of missing) { const last = runs[runs.length - 1]; if (last && last[1] === h - 1) last[1] = h; else runs.push([h, h]); }
  const rows: { height: { int: number }; hash: string; time: { timep: string } }[] = [];
  for (const [a, b] of runs) {
    const hs: Header[] = await canonicalHeaders(c, a, b);
    if (hs.length !== b - a + 1) throw new Error(`chain ${c}: expected ${b - a + 1} canonical headers for [${a},${b}], got ${hs.length}`);
    for (const h of hs) rows.push({ height: { int: h.height }, hash: h.hash, time: pactTime(h.creationTime) });
  }
  const batches: typeof rows[] = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
  const estGas = rows.length * 90;
  console.log(`  ${runs.length} gap run(s), ${rows.length} rows, ${batches.length} batch(es) of <=${BATCH}; ~${estGas.toLocaleString()} gas ≈ ${(estGas * GAS_PRICE).toFixed(6)} KDA`);
  if (DRY) { for (const [a, b] of runs.slice(0, 20)) console.log(`    gap ${a}${b !== a ? `..${b}` : ''}`); if (runs.length > 20) console.log(`    … ${runs.length - 20} more`); return; }

  let written = 0, skipped = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const s: TxSpec = {
      label: `backfill chain ${c} batch ${i + 1}/${batches.length} (${batch[0].height.int}..${batch[batch.length - 1].height.int})`,
      chainId: c, sender, code: `(${MODULE}.backfill (read-msg 'rows))`, data: { rows: batch }, signers, gasLimit: GAS_LIMIT,
    };
    if (UNSIGNED) { await writeUnsigned(s); continue; }
    const r = await send(s);
    written += r.data.written; skipped += r.data.skipped;
    if (r.data.written + r.data.skipped !== batch.length) throw new Error(`batch ${i + 1}: module reported ${JSON.stringify(r.data)} for ${batch.length} rows`);
  }
  if (UNSIGNED) { console.log(`\n  ${batches.length} unsigned batch file(s) written to ts/out/unsigned/. Sign each in your wallet and submit with: npm run send-signed -- <file>`); return; }
  const still = await missingHeights(c, FROM, to);
  console.log(`\nchain ${c}: written ${written}, skipped ${skipped}; ${still.length} height(s) still missing in [${FROM}, ${to}]`);
  if (still.length) { console.log(`  first missing: ${still.slice(0, 10).join(' ')}`); process.exit(1); }
}
main().catch((e) => { console.error(`\nBACKFILL FAILED: ${e?.message ?? e}`); process.exit(1); });
if (!isDevnet() && !UNSIGNED && !DRY) console.log('  note: on a public network prefer --unsigned and sign in your own wallet');
