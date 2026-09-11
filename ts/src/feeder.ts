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
//   BH_SUBMIT_HOSTS  BH_WAITING_INTERVAL (optional sending modes, both off by default; below)
//
// Why a reactive attest can miss a block. Only block X+1 can record block X. A mining node builds
// X+1's first template from its mempool the moment it adopts X, and adds newer transactions only when
// it refreshes that template (every 15 s by default). An attest sent once X is seen here reaches the
// miners after that template is built, so X is missed whenever X+1 is found before a refresh picks the
// attest up. The two modes below work on that from two sides. With neither set, the feeder sends the
// same transactions and prints the same lines as without them. A value either mode cannot accept stops
// the feeder before it loads its key or sends anything. With either on, startup prints one `modes:`
// line, the 60 s report gains the mode's counts, and each attest's line in BH_LOG_FILE carries
// "mode":"reactive"|"waiting", plus "fanout":{"<host>":"ok"|"err"} when fan-out is on.
//
//   BH_SUBMIT_HOSTS=https://a.example,https://b.example    (bare https origins, each once, not BH_HOST, at most 5)
//     Every signed attest also goes to each listed host's Pact /send for its chain, in parallel and
//     fire and forget: the primary submit to BH_HOST starts first and never waits for them. BH_HOST
//     stays the stream, the primary submit and the poll target. A host that answers with the attest's
//     request key, or refuses it as one it already has, counts as delivered; any other answer, or none
//     within 25 s, as failed. A host is sent at most BH_MAX_INFLIGHT × chains attests at once, so one
//     that stops answering cannot pile up requests; an attest beyond that is not sent to it and counts
//     as failed. No extra gas: every host gets the same signed transaction, and a chain includes a
//     transaction once at most.
//   BH_WAITING_INTERVAL=N    (whole seconds, 2 to 60)
//     Each chain also gets one extra attest every N s (±20 % jitter), on top of the reactive one, so
//     that an attest is usually already waiting in the miners' mempools when a block arrives, and that
//     block's first template includes it. Each is its own transaction (its own nonce), anchored like
//     the reactive one to the latest header time this chain has shown on the stream, never to the wall
//     clock, and each counts against BH_MAX_INFLIGHT. The timers run only while the stream is
//     connected. Waiting attests go to BH_SUBMIT_HOSTS too. Cost: only the first attest in a block
//     records; every other one is a no-op that still pays its gas. A chain then sends about
//     1 + blockTime/N attests per block instead of 1 (30 s blocks and N = 10: about 4), and fees rise
//     roughly in that proportion. The report's `submitted` and `submit-errors` count both kinds.
import { appendFileSync } from 'node:fs';
import type { ChainId, ICommand } from '@kadena/client';
import {
  API, HOST, MODULE, NETWORK_ID, GAS_PRICE, client, keyPath, loadOrCreateKey, accountOf, parseChains,
  buildSigned, balance, local, pollMined, rawFetch, sleep, errorText,
  parseSubmitHosts, parseWaitingInterval, sendUrl, fanoutOutcome, jitterDelay, WAITING_JITTER,
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
// The optional modes are read before the key: a value they cannot accept stops the feeder here.
const { SUBMIT_HOSTS, WAITING } = (() => {
  try { return { SUBMIT_HOSTS: parseSubmitHosts(process.env.BH_SUBMIT_HOSTS, HOST), WAITING: parseWaitingInterval(process.env.BH_WAITING_INTERVAL) }; }
  catch (e: any) { console.error(`feeder: ${String(e?.message ?? e)}. The feeder refuses to start and has sent nothing.`); process.exit(1); }
})();
const MODES_ON = WAITING !== null || SUBMIT_HOSTS.length > 0;

const feeder = loadOrCreateKey(keyPath('BH_FEEDER_KEY', 'out/feeder-key.json'));
const sender = accountOf(feeder);

type ChainStats = { lastHeight: number; events: number; submitted: number; submitErrors: number; inflight: number; polled: number; pollOk: number; pollFail: number; gasSum: number; seq: number; waitingSubmitted: number; anchorMicros: number };
const stats = new Map<string, ChainStats>();
for (const c of CHAINS) stats.set(c, { lastHeight: -1, events: 0, submitted: 0, submitErrors: 0, inflight: 0, polled: 0, pollOk: 0, pollFail: 0, gasSum: 0, seq: 0, waitingSubmitted: 0, anchorMicros: 0 });
// Per extra host: attests it took, attests it did not, and sends to it still unanswered.
const fanStats = new Map(SUBMIT_HOSTS.map((h) => [h, { delivered: 0, failed: 0, inflight: 0 }]));
const FANOUT_CAP = MAX_INFLIGHT * CHAINS.length;
const FANOUT_TIMEOUT_MS = 25_000;   // a host that has not answered by then counts as failed
const waitTimers = new Map<string, ReturnType<typeof setTimeout>>();
let reconnects = 0;
const started = Date.now();
let stopping = false;
let streamAbort: AbortController | null = null;
function stop() { stopping = true; streamAbort?.abort(); stopWaiting(); }

function logLine(o: Record<string, any>) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  if (LOG_FILE) appendFileSync(LOG_FILE, line + '\n');
  return line;
}

async function preflightWorld() {
  console.log(`feeder: ${NETWORK_ID} via ${API}\n  module ${MODULE}  chains ${CHAINS.join(',')}\n  sender ${sender}  gasLimit ${GAS_LIMIT}  ttl ${TTL}s`);
  if (MODES_ON) console.log(`  modes: reactive${WAITING !== null ? `; waiting every ${WAITING}s ±${Math.round(WAITING_JITTER * 100)}%` : ''}${SUBMIT_HOSTS.length ? `; fan-out to ${SUBMIT_HOSTS.length} host${SUBMIT_HOSTS.length > 1 ? 's' : ''}: ${SUBMIT_HOSTS.join(', ')}` : ''}`);
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
// TTL 300 it stays valid for any realistic run of blocks after H. A waiting attest is the same call
// sent from a timer, H being the latest header seen for C; its nonce gains a suffix so it is never
// the same transaction as the reactive one.
async function attest(c: ChainId, h: number, creationMicros: number, mode: 'reactive' | 'waiting' = 'reactive') {
  const s = stats.get(c)!;
  const tag = MODES_ON ? { mode } : {};
  if (s.inflight >= MAX_INFLIGHT) { logLine({ chain: c, height: h, ...tag, skipped: 'inflight cap' }); return; }
  s.inflight++;
  const seq = ++s.seq;
  const waiting = mode === 'waiting' ? ' waiting' : '';
  // With fan-out on, this attest's log line is written once every extra host has answered.
  let fan: Promise<Record<string, 'ok' | 'err'>> | undefined;
  const record = (o: Record<string, any>) => { if (fan) void fan.then((fanout) => logLine({ ...o, fanout })); else logLine(o); };
  try {
    const signed = await buildSigned({
      code: `(${MODULE}.attest)`, label: `attest c${c} h${h}${waiting}`, chainId: c, sender,
      signers: [{ kp: feeder, caps: (wc) => [wc('coin.GAS')] }],
      gasLimit: GAS_LIMIT, ttl: TTL, nonce: `bh:${c}:${h}:${Date.now()}${mode === 'waiting' ? `:w${seq}` : ''}`,
      creationTime: Math.floor(creationMicros / 1_000_000) - 5,
    });
    const submitting = client.submit(signed);   // started first: the extra hosts never hold it up
    if (SUBMIT_HOSTS.length) fan = fanOut(signed, c);
    const desc = await submitting;
    s.submitted++;
    if (mode === 'waiting') s.waitingSubmitted++;
    record({ chain: c, height: h, ...tag, rk: desc.requestKey, latencyMs: Date.now() - Math.floor(creationMicros / 1000) });
    if (SAMPLE_POLL > 0 && seq % SAMPLE_POLL === 1) {
      // Sampled verification: catches a systemic failure (wrong module, gas limit, key) early.
      s.polled++;
      pollMined(desc.requestKey, c, `attest c${c} h${h}${waiting}`, 180_000).then((r) => {
        const ok = r.result.status === 'success';
        ok ? s.pollOk++ : s.pollFail++;
        s.gasSum += Number((r as any).gas ?? 0);
        const line = logLine({ chain: c, height: h, ...tag, rk: desc.requestKey, mined: ok, gas: (r as any).gas, at: (r as any).metaData?.blockHeight, result: ok ? (r.result as any).data : errorText(r) });
        if (!ok) console.log(`  ! sampled attest FAILED on chain ${c}: ${line}`);
      }).catch((e) => { s.pollFail++; console.log(`  ! sampled attest not mined on chain ${c}: ${String(e?.message ?? e).slice(0, 160)}`); });
    }
  } catch (e: any) {
    s.submitErrors++;
    console.log(`  ! submit failed chain ${c} h${h}${waiting}: ${String(e?.message ?? e).slice(0, 200)}`);
    record({ chain: c, height: h, ...tag, submitError: String(e?.message ?? e).slice(0, 300) });
  } finally { s.inflight--; }
}

// BH_SUBMIT_HOSTS: one signed attest to every extra host at once. Never rejects: whatever a host does,
// it is counted, and the answers come back in the order the hosts are listed.
async function fanOut(signed: ICommand, c: ChainId): Promise<Record<string, 'ok' | 'err'>> {
  const out: Record<string, 'ok' | 'err'> = {};
  await Promise.all(SUBMIT_HOSTS.map(async (host) => {
    const f = fanStats.get(host)!;
    let r: 'ok' | 'err' = 'err';
    if (f.inflight < FANOUT_CAP) {
      f.inflight++;
      try {
        const res = await fetch(sendUrl(host, NETWORK_ID, c), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmds: [signed] }), signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS) });
        r = fanoutOutcome(res.status, await res.text(), signed.hash);
      } catch { /* no answer within the deadline, or no connection: failed */ }
      finally { f.inflight--; }
    }
    if (r === 'ok') f.delivered++; else f.failed++;
    out[host] = r;
  }));
  return Object.fromEntries(SUBMIT_HOSTS.map((h) => [h, out[h]]));
}

// BH_WAITING_INTERVAL: one timer per chain, re-armed with fresh jitter each time it fires. Started on
// each stream connection; stopped when the stream drops and on shutdown.
function startWaiting() {
  const every = WAITING;
  if (every === null || stopping) return;
  stopWaiting();
  const arm = (c: ChainId) => waitTimers.set(c, setTimeout(() => {
    const s = stats.get(c)!;
    // No header for this chain on this connection yet: nothing to anchor to, so nothing is sent.
    if (!stopping && s.anchorMicros > 0) void attest(c, s.lastHeight, s.anchorMicros, 'waiting');
    if (waitTimers.has(c)) arm(c);
  }, jitterDelay(every, Math.random())));
  for (const c of CHAINS) arm(c);
}
function stopWaiting() { for (const t of waitTimers.values()) clearTimeout(t); waitTimers.clear(); }

async function consumeStream() {
  streamAbort = new AbortController();
  const res = await rawFetch(`${API}/header/updates`, { headers: { Accept: 'text/event-stream' }, signal: streamAbort.signal });
  if (!res.ok || !res.body) throw new Error(`header stream: HTTP ${res.status}`);
  console.log(`  connected to ${API}/header/updates`);
  for (const s of stats.values()) s.anchorMicros = 0;   // waiting attests anchor only to this connection's headers
  startWaiting();
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
      s.anchorMicros = h.creationTime;
      void attest(c, h.height, h.creationTime);
    }
    if (stopping) return;
  }
}

function report() {
  const up = Math.round((Date.now() - started) / 1000);
  let ev = 0, sub = 0, err = 0, pk = 0, pf = 0, gs = 0, ws = 0;
  for (const s of stats.values()) { ev += s.events; sub += s.submitted; err += s.submitErrors; pk += s.pollOk; pf += s.pollFail; gs += s.gasSum; ws += s.waitingSubmitted; }
  let fd = 0, ff = 0;
  for (const f of fanStats.values()) { fd += f.delivered; ff += f.failed; }
  const modes = `${WAITING !== null ? `  waiting submitted ${ws}` : ''}${SUBMIT_HOSTS.length ? `  fan-out delivered/failed ${fd}/${ff}` : ''}`;
  console.log(`[${up}s] events ${ev}  submitted ${sub}  submit-errors ${err}  sampled mined ok/fail ${pk}/${pf}  avg gas ${pk ? Math.round(gs / pk) : '-'}  reconnects ${reconnects}${modes}`);
  logLine({
    report: true, up, events: ev, submitted: sub, submitErrors: err, pollOk: pk, pollFail: pf, reconnects,
    ...(WAITING !== null ? { waitingSubmitted: ws } : {}),
    ...(SUBMIT_HOSTS.length ? { fanout: Object.fromEntries([...fanStats].map(([h, f]) => [h, { delivered: f.delivered, failed: f.failed }])) } : {}),
    chains: Object.fromEntries([...stats].map(([c, s]) => [c, s.lastHeight])),
  });
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
      stopWaiting();                                   // no stream, no anchor: the waiting timers pause until it is back
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
