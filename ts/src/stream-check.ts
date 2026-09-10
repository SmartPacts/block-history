// stream-check.ts — is the node's header stream alive, and does the feeder's parser read it?
// Read-only: connects to $BH_HOST/…/header/updates for --seconds N (default 60), counts
// BlockHeader events per chain, and reports the observed block rate. Exit 1 if fewer than the
// configured chains were seen. Use it before starting a feeder on a new host, and as a probe.
//   npm run stream-check -- --seconds 60
import { API, NETWORK_ID, parseChains, rawFetch } from './lib.js';

const args = process.argv.slice(2);
const SECONDS = (() => { const i = args.indexOf('--seconds'); return i >= 0 ? Number(args[i + 1]) : 60; })();
const CHAINS = parseChains();

async function main() {
  console.log(`stream-check: ${NETWORK_ID} via ${API}/header/updates for ${SECONDS}s, expecting chains ${CHAINS[0]}..${CHAINS[CHAINS.length - 1]}`);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), SECONDS * 1000);
  const seen = new Map<string, { n: number; last: number; first: number }>();
  let events = 0, bad = 0;
  const started = Date.now();
  try {
    const res = await rawFetch(`${API}/header/updates`, { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let name = '', data = '';
        for (const line of ev.split('\n')) { if (line.startsWith('event:')) name = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
        if (name !== 'BlockHeader' || !data) continue;
        events++;
        let h: any; try { h = JSON.parse(data).header; } catch { bad++; continue; }
        if (typeof h?.chainId !== 'number' || typeof h?.height !== 'number' || typeof h?.creationTime !== 'number' || typeof h?.hash !== 'string') { bad++; continue; }
        const c = String(h.chainId);
        const s = seen.get(c) ?? { n: 0, last: -1, first: h.height };
        s.n++; s.last = h.height; seen.set(c, s);
      }
    }
  } catch (e: any) { if (!/abort/i.test(String(e?.name ?? e))) throw e; }
  const secs = (Date.now() - started) / 1000;
  const missing = CHAINS.filter((c) => !seen.has(c));
  console.log(`  ${events} BlockHeader events in ${secs.toFixed(0)}s (${(events / secs).toFixed(2)}/s network-wide, ${(events / secs / CHAINS.length).toFixed(3)}/s/chain); unparseable ${bad}`);
  console.log(`  chains seen: ${[...seen.keys()].sort((a, b) => Number(a) - Number(b)).join(',')}${missing.length ? `   MISSING: ${missing.join(',')}` : ''}`);
  for (const [c, s] of [...seen].sort((a, b) => Number(a[0]) - Number(b[0]))) console.log(`    chain ${c.padStart(2)}: ${String(s.n).padStart(4)} events, heights ${s.first}..${s.last}`);
  process.exit(missing.length || bad ? 1 : 0);
}
main().catch((e) => { console.error(`stream-check FAILED: ${e?.message ?? e}`); process.exit(1); });
