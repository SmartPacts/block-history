// feeder.ts — keeps the block-history module fed: one `attest` per observed block, per chain.
//
// It supplies LIVENESS, not data: the hash and time a row carries come from the engine when
// the transaction executes, so nothing this process sends can be wrong — only late or absent.
// Design (measured): reactive, not polling. One SSE connection to the node's
// /header/updates stream carries every chain; on each BlockHeader event for chain C at height H
// a fresh attest is signed and submitted to C immediately, so it lands in H+1 and records H.
// The on-chain call is idempotent, so redundant feeders and late landings cost ~100 gas, never
// an abort.
//
//   npm run feeder                          run until stopped
//   npm run feeder -- --duration 600        run for 600 s (soak), then exit 0
// Environment (ts/.env or shell): BH_HOST BH_NETWORK_ID BH_NS BH_CHAINS BH_FEEDER_KEY
//   BH_ATTEST_GAS_LIMIT (default 400)  BH_ATTEST_TTL (default 300 s)
//   BH_MAX_INFLIGHT (per chain, default 4)  BH_SAMPLE_POLL (poll 1 in N, default 25)
//   BH_LOG_FILE (JSON lines; default none)
import { appendFileSync } from 'node:fs';
import type { ChainId } from '@kadena/client';
import {
  API, MODULE, NETWORK_ID, GAS_PRICE, client, keyPath, loadOrCreateKey, accountOf, parseChains,
  buildSigned, balance, local, pollMined, rawFetch, sleep, errorText,
} from './lib.js';

const args = process.argv.slice(2);
const DURATION = (() => { const i = args.indexOf('--duration'); return i >= 0 ? Number(args[i + 1]) : 0; })();
const GAS_LIMIT = Number(process.env.BH_ATTEST_GAS_LIMIT ?? '400');
const TTL = Number(process.env.BH_ATTEST_TTL ?? '300');
const MAX_INFLIGHT = Number(process.env.BH_MAX_INFLIGHT ?? '4');
const SAMPLE_POLL = Number(process.env.BH_SAMPLE_POLL ?? '25');
const LOG_FILE = process.env.BH_LOG_FILE;
const CHAINS = parseChains();
const chainSet = new Set<string>(CHAINS);

const feeder = loadOrCreateKey(keyPath('BH_FEEDER_KEY', 'out/feeder-key.json'));
const sender = accountOf(feeder);

type ChainStats = { lastHeight: number; events: number; submitted: number; submitErrors: number; inflight: number; polled: number; pollOk: number; pollFail: number; gasSum: number; seq: number };
const stats = new Map<string, ChainStats>();
for (const c of CHAINS) stats.set(c, { lastHeight: -1, events: 0, submitted: 0, submitErrors: 0, inflight: 0, polled: 0, pollOk: 0, pollFail: 0, gasSum: 0, seq: 0 });
let reconnects = 0;
const started = Date.now();
let stopping = false;
let streamAbort: AbortController | null = null;
function stop() { stopping = true; streamAbort?.abort(); }

function logLine(o: Record<string, any>) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  if (LOG_FILE) appendFileSync(LOG_FILE, line + '\n');
  return line;
}

async function preflightWorld() {
  console.log(`feeder: ${NETWORK_ID} via ${API}\n  module ${MODULE}  chains ${CHAINS.join(',')}\n  sender ${sender}  gasLimit ${GAS_LIMIT}  ttl ${TTL}s`);
  for (const c of CHAINS) {
    // Ask describe-module directly, so a feeder started before the deploy says exactly what is wrong.
    const deployed = await local(`(describe-module ${JSON.stringify(MODULE)})`, { chainId: c }).then(
      () => true,
      (e) => { if (/Cannot find module/i.test(String(e?.message ?? e))) return false; throw e; });
    if (!deployed) throw new Error(`${MODULE} is not deployed on chain ${c} yet. The feeder refuses to start and has sent nothing. Deploy the module first, then start it again.`);
    const latest = await local(`(${MODULE}.latest)`, { chainId: c });
    const bal = await balance(sender, c);
    if (bal <= 0) throw new Error(`chain ${c}: ${sender} holds no KDA — fund it (npm run deploy funds it on a devnet)`);
    if (bal < 0.05) console.log(`  ! chain ${c}: balance ${bal} KDA is low (each attest costs ~${(GAS_LIMIT * GAS_PRICE).toExponential(1)} KDA at most)`);
    console.log(`  chain ${c}: module present (latest recorded height ${latest.height}), balance ${bal} KDA`);
  }
}

// Build + submit one attest for chain C, anchored to block H's own creation time so the node
// accepts it without an extra round trip: creationTime <= parent time is always valid, and with
// TTL 300 it stays valid for any realistic run of blocks after H.
async function attest(c: ChainId, h: number, creationMicros: number) {
  const s = stats.get(c)!;
  if (s.inflight >= MAX_INFLIGHT) { logLine({ chain: c, height: h, skipped: 'inflight cap' }); return; }
  s.inflight++;
  const seq = ++s.seq;
  try {
    const signed = await buildSigned({
      code: `(${MODULE}.attest)`, label: `attest c${c} h${h}`, chainId: c, sender,
      signers: [{ kp: feeder, caps: (wc) => [wc('coin.GAS')] }],
      gasLimit: GAS_LIMIT, ttl: TTL, nonce: `bh:${c}:${h}:${Date.now()}`,
      creationTime: Math.floor(creationMicros / 1_000_000) - 5,
    });
    const desc = await client.submit(signed);
    s.submitted++;
    logLine({ chain: c, height: h, rk: desc.requestKey, latencyMs: Date.now() - Math.floor(creationMicros / 1000) });
    if (SAMPLE_POLL > 0 && seq % SAMPLE_POLL === 1) {
      // Sampled verification: catches a systemic failure (wrong module, gas limit, key) early.
      s.polled++;
      pollMined(desc.requestKey, c, `attest c${c} h${h}`, 180_000).then((r) => {
        const ok = r.result.status === 'success';
        ok ? s.pollOk++ : s.pollFail++;
        s.gasSum += Number((r as any).gas ?? 0);
        const line = logLine({ chain: c, height: h, rk: desc.requestKey, mined: ok, gas: (r as any).gas, at: (r as any).metaData?.blockHeight, result: ok ? (r.result as any).data : errorText(r) });
        if (!ok) console.log(`  ! sampled attest FAILED on chain ${c}: ${line}`);
      }).catch((e) => { s.pollFail++; console.log(`  ! sampled attest not mined on chain ${c}: ${String(e?.message ?? e).slice(0, 160)}`); });
    }
  } catch (e: any) {
    s.submitErrors++;
    console.log(`  ! submit failed chain ${c} h${h}: ${String(e?.message ?? e).slice(0, 200)}`);
    logLine({ chain: c, height: h, submitError: String(e?.message ?? e).slice(0, 300) });
  } finally { s.inflight--; }
}

async function consumeStream() {
  streamAbort = new AbortController();
  const res = await rawFetch(`${API}/header/updates`, { headers: { Accept: 'text/event-stream' }, signal: streamAbort.signal });
  if (!res.ok || !res.body) throw new Error(`header stream: HTTP ${res.status}`);
  console.log(`  connected to ${API}/header/updates`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('header stream closed by the node');
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let name = '', data = '';
      for (const line of ev.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (name !== 'BlockHeader' || !data) continue;
      let h: any;
      try { h = JSON.parse(data).header; } catch { continue; }
      const c = String(h.chainId) as ChainId;
      if (!chainSet.has(c)) continue;
      const s = stats.get(c)!;
      s.events++;
      if (h.height <= s.lastHeight) continue;          // a re-announced or orphan-side header
      s.lastHeight = h.height;
      void attest(c, h.height, h.creationTime);
    }
    if (stopping) return;
  }
}

function report() {
  const up = Math.round((Date.now() - started) / 1000);
  let ev = 0, sub = 0, err = 0, pk = 0, pf = 0, gs = 0;
  for (const s of stats.values()) { ev += s.events; sub += s.submitted; err += s.submitErrors; pk += s.pollOk; pf += s.pollFail; gs += s.gasSum; }
  console.log(`[${up}s] events ${ev}  submitted ${sub}  submit-errors ${err}  sampled mined ok/fail ${pk}/${pf}  avg gas ${pk ? Math.round(gs / pk) : '-'}  reconnects ${reconnects}`);
  logLine({ report: true, up, events: ev, submitted: sub, submitErrors: err, pollOk: pk, pollFail: pf, reconnects, chains: Object.fromEntries([...stats].map(([c, s]) => [c, s.lastHeight])) });
}

async function main() {
  await preflightWorld();
  const timer = setInterval(report, 60_000);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (DURATION > 0) setTimeout(stop, DURATION * 1000);
  let backoff = 1000;
  while (!stopping) {
    try { await consumeStream(); backoff = 1000; }
    catch (e: any) {
      if (stopping) break;
      reconnects++;
      console.log(`  stream error: ${String(e?.message ?? e).slice(0, 160)} — reconnecting in ${backoff / 1000}s`);
      await sleep(backoff); backoff = Math.min(backoff * 2, 30_000);
    }
  }
  clearInterval(timer);
  await sleep(2000);   // let sampled polls settle
  report();
  let fails = 0; for (const s of stats.values()) fails += s.pollFail;
  process.exit(fails > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
