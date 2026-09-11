// oracle.ts — the differential check: the node's canonical headers vs the module's rows.
//
// For every height in range and every chain: the node says (hash, creationTime); the module says
// (hash, time) or nothing. A single mismatch is a defect and exits 2. Missing heights are
// reported as coverage, never as a pass. The node is read through canonical parent links from the
// cut, so an orphaned block can never be mistaken for the reference.
//
//   npm run oracle -- --last 600                 the last 600 heights below the tip, all BH_CHAINS
//   npm run oracle -- --from 0 --to 5000         an explicit range
//   npm run oracle -- --chains 2,5 --last 100 --json
// Heights within 2 of the cut are excluded (attest cannot have recorded them yet).
// Exit 0 = every recorded row matches the node; 2 = a mismatch; 3 = zero heights inspected; 1 = the check could not run.
import type { ChainId } from '@kadena/client';
import { API, MODULE, parseChains, local, cut, canonicalHeaders, microsOf } from './lib.js';

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const CHAINS = parseChains(opt('chains', process.env.BH_CHAINS ?? '0-19'));
const LAST = Number(opt('last', 'NaN'));
const FROM = Number(opt('from', 'NaN')), TO = Number(opt('to', 'NaN'));
const JSON_OUT = args.includes('--json');

type Row = { height: number; recorded: boolean; hash?: string; time?: string; by?: string };
type ChainReport = { chain: string; from: number; to: number; heights: number; attested: number; missing: number; mismatches: { height: number; field: string; node: string; module: string }[]; firstMissing: number[]; latest: number };

async function moduleRows(c: ChainId, a: number, b: number): Promise<Row[]> {
  const out: Row[] = [];
  for (let lo = a; lo <= b; lo += 500) {
    const hi = Math.min(b, lo + 499);
    const rows: Row[] = await local(
      // time is read through format-time: Pact's JSON output encodes millisecond-aligned times in
      // the seconds-only {"time"} form, which would make an exact row look truncated. An object `+`
      // keeps its left side's value for a shared key, so the formatted time replaces the row's own.
      `(map (lambda (h:integer) (if (${MODULE}.has-attested h) (let* ((b (${MODULE}.get-attested h)) (r { "height": h, "recorded": true, "time": (format-time "%Y-%m-%dT%H:%M:%S.%vZ" (at 'time b)) })) (+ r b)) { "height": h, "recorded": false })) (enumerate ${lo} ${hi}))`,
      { chainId: c });
    out.push(...rows);
  }
  return out;
}

async function checkChain(c: ChainId, topByChain: Record<string, { height: number }>): Promise<ChainReport> {
  const top = topByChain[c].height;
  const to = Number.isFinite(TO) ? Math.min(TO, top - 2) : top - 2;
  const from = Number.isFinite(FROM) ? FROM : Number.isFinite(LAST) ? Math.max(0, to - LAST + 1) : Math.max(0, to - 599);
  const rep: ChainReport = { chain: c, from, to, heights: to - from + 1, attested: 0, missing: 0, mismatches: [], firstMissing: [], latest: -1 };
  if (to < from) return rep;
  const [node, mod, latest] = await Promise.all([canonicalHeaders(c, from, to), moduleRows(c, from, to), local(`(${MODULE}.latest)`, { chainId: c })]);
  rep.latest = latest.height;
  if (node.length !== rep.heights || mod.length !== rep.heights) throw new Error(`chain ${c}: node ${node.length} / module ${mod.length} rows for ${rep.heights} heights`);
  for (let i = 0; i < rep.heights; i++) {
    const n = node[i], m = mod[i];
    if (n.height !== from + i || m.height !== from + i) throw new Error(`chain ${c}: row order broke at index ${i}`);
    if (m.recorded === false) { rep.missing++; if (rep.firstMissing.length < 10) rep.firstMissing.push(m.height); continue; }
    if (m.recorded !== true) throw new Error(`chain ${c}: unreadable module row at height ${m.height}: ${JSON.stringify(m).slice(0, 160)}`);
    rep.attested++;
    if (m.hash !== n.hash) rep.mismatches.push({ height: n.height, field: 'hash', node: n.hash, module: String(m.hash) });
    const mt = microsOf(String(m.time));
    if (mt !== n.creationTime) rep.mismatches.push({ height: n.height, field: 'time', node: String(n.creationTime), module: `${m.time} (${mt})` });
  }
  return rep;
}

async function main() {
  const top = await cut();
  const reports: ChainReport[] = [];
  const queue = [...CHAINS];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (queue.length) reports.push(await checkChain(queue.shift()!, top)); }));
  reports.sort((a, b) => Number(a.chain) - Number(b.chain));
  const tot = reports.reduce((t, r) => ({ heights: t.heights + r.heights, attested: t.attested + r.attested, missing: t.missing + r.missing, mismatches: t.mismatches + r.mismatches.length }), { heights: 0, attested: 0, missing: 0, mismatches: 0 });
  if (JSON_OUT) { console.log(JSON.stringify({ api: API, module: MODULE, at: new Date().toISOString(), total: tot, chains: reports }, null, 2)); }
  else {
    console.log(`\n=== block-history oracle → ${API}  module ${MODULE} ===`);
    console.log('chain   range               heights  attested  missing  coverage   latest  mismatches');
    for (const r of reports) {
      const cov = r.heights ? ((r.attested / r.heights) * 100).toFixed(2) + '%' : '-';
      console.log(`${r.chain.padStart(5)}   ${String(r.from).padStart(8)}..${String(r.to).padEnd(8)}  ${String(r.heights).padStart(7)}  ${String(r.attested).padStart(8)}  ${String(r.missing).padStart(7)}  ${cov.padStart(8)}  ${String(r.latest).padStart(7)}  ${r.mismatches.length}${r.firstMissing.length ? `   missing: ${r.firstMissing.join(' ')}${r.missing > 10 ? ' …' : ''}` : ''}`);
      for (const m of r.mismatches.slice(0, 5)) console.log(`        MISMATCH h${m.height} ${m.field}: node=${m.node} module=${m.module}`);
    }
    const cov = tot.heights ? ((tot.attested / tot.heights) * 100).toFixed(3) : '-';
    console.log(`\ntotal   heights ${tot.heights}  attested ${tot.attested}  missing ${tot.missing}  coverage ${cov}%  mismatches ${tot.mismatches}`);
    console.log(tot.mismatches ? 'VERDICT: FAIL — the module disagrees with the node' : tot.heights === 0 ? 'VERDICT: NO DATA — zero heights inspected, nothing verified' : `VERDICT: CONSISTENT — every recorded row matches the node; ${tot.missing} gap(s)`);
  }
  process.exit(tot.mismatches ? 2 : tot.heights === 0 ? 3 : 0);
}
main().catch((e) => { console.error(`\nORACLE FAILED: ${e?.message ?? e}`); process.exit(1); });
