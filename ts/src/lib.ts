// Shared plumbing for every block-history tool: network config, keys, signing, submit/poll,
// header fetching. Targets any Chainweb node at
//   $BH_HOST/chainweb/0.0/$BH_NETWORK_ID/...
// Defaults are the local devnet in ../devnet (recap-development, :8095).
import {
  Pact, createClient, createSignWithKeypair,
  type ChainId, type ICommand, type ICommandResult, type IUnsignedCommand,
} from '@kadena/client';
import { genKeyPair } from '@kadena/cryptography-utils';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = join(ROOT, 'ts', 'out');

// ts/.env fills in variables the shell did not export. KEY=VALUE lines, # comments.
{
  const envFile = join(ROOT, 'ts', '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

export const HOST = process.env.BH_HOST ?? 'http://localhost:8095';
export const NETWORK_ID = process.env.BH_NETWORK_ID ?? 'recap-development';
export const NS = process.env.BH_NS ?? 'free';
export const MODULE = `${NS}.block-history`;
export const BACKFILL_KEYSET = `${NS}.block-history-backfill`;
export const GAS_PRICE = Number(process.env.BH_GAS_PRICE ?? '1e-8');
export const API = `${HOST}/chainweb/0.0/${NETWORK_ID}`;

// "0-19", "2", "0,5,7", "0-3,19" -> ChainId[]
export function parseChains(spec: string = process.env.BH_CHAINS ?? '0-19'): ChainId[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad chain spec "${part}" in "${spec}"`);
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    for (let c = a; c <= b; c++) out.add(c);
  }
  return [...out].sort((x, y) => x - y).map((c) => String(c) as ChainId);
}

export const isDevnet = () => NETWORK_ID === 'recap-development' || NETWORK_ID === 'development';

// Every ordinary request gets a deadline; the SSE stream (feeder) uses rawFetch instead.
export const rawFetch = globalThis.fetch;
const fetchWithDeadline = (input: any, init?: any) =>
  rawFetch(input, { ...(init ?? {}), signal: init?.signal ?? AbortSignal.timeout(25_000) });
globalThis.fetch = fetchWithDeadline as typeof fetch;

export const client = createClient(({ chainId, networkId }) => `${HOST}/chainweb/0.0/${networkId}/chain/${chainId}/pact`);

export type Keypair = { publicKey: string; secretKey: string };
export const accountOf = (kp: Keypair) => `k:${kp.publicKey}`;
export const keysetOf = (kp: Keypair) => ({ keys: [kp.publicKey], pred: 'keys-all' });
export const signWith = (kp: Keypair) => createSignWithKeypair({ publicKey: kp.publicKey, secretKey: kp.secretKey });

// Devnet genesis faucet — a public, well-known devnet-only key. Its secret is published: never
// use it, or send value to it, outside a local devnet.
export const SENDER00: Keypair = {
  publicKey: '368820f80c324bbc7c2b0610688a7da43e39f91d118732671cd9c7500ff43cca',
  secretKey: '251a920c403ae8c8f65f59142316af3c82b631fba46ddea92ee8c95035bd2898',
};

// Loads the keypair at `path`; creates one only on a devnet. On a public network a missing key
// is an error: generating a fresh unfunded key there would silently act under an identity nobody holds.
export function loadOrCreateKey(path: string, allowCreate: boolean = isDevnet()): Keypair {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  if (!allowCreate) throw new Error(`key file not found: ${path} (on ${NETWORK_ID} keys are never generated)`);
  const kp = genKeyPair();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ publicKey: kp.publicKey, secretKey: kp.secretKey }, null, 2) + '\n', { mode: 0o600 });
  console.log(`  new keypair written to ${path} (k:${kp.publicKey})`);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey! };
}
export const keyPath = (envVar: string, fallback: string) => {
  const p = process.env[envVar] ?? fallback;
  return p.startsWith('/') ? p : join(ROOT, 'ts', p);
};

// Pact API value codec: {int}, {decimal}, {time}, {timep} -> plain JS
export function unwrap(v: any): any {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(unwrap);
  if (typeof v === 'object') {
    const ks = Object.keys(v);
    if (ks.length === 1 && 'int' in v) return Number(v.int);
    if (ks.length === 1 && 'decimal' in v) return Number(v.decimal);
    if (ks.length === 1 && 'time' in v) return v.time;
    if (ks.length === 1 && 'timep' in v) return v.timep;
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[k] = unwrap(x);
    return o;
  }
  return v;
}

async function retrying<T>(what: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: any;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e: any) {
      last = e;
      const msg = String(e?.message ?? e);
      if (!/502|503|504|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|<html>|Bad Gateway|timeout/i.test(msg)) throw e;
      await sleep(3000);
    }
  }
  throw new Error(`${what}: node unreachable after ${attempts} attempts: ${String(last?.message ?? last).slice(0, 200)}`);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function errorText(r: ICommandResult): string {
  const e: any = (r.result as any).error ?? {};
  return `${e.message ?? ''} ${e.info ?? ''}`.trim() || JSON.stringify(e);
}

// The chain's own clock: (chain-data) block-time = the PARENT block's creation time.
// A mined tx is refused when its creationTime exceeds that by more than a few seconds.
export async function chainTime(chainId: ChainId): Promise<Date> {
  const t = await local(`(at 'block-time (chain-data))`, { chainId });
  return new Date(t);
}

export async function local(code: string, o: { data?: Record<string, any>; chainId: ChainId; gasLimit?: number }): Promise<any> {
  let b: any = Pact.builder.execution(code);
  for (const [k, v] of Object.entries(o.data ?? {})) b = b.addData(k, v);
  const tx: IUnsignedCommand = b
    .setMeta({ chainId: o.chainId, senderAccount: 'block-history-reader', gasLimit: o.gasLimit ?? 150000, gasPrice: GAS_PRICE })
    .setNetworkId(NETWORK_ID)
    .createTransaction();
  const r = await retrying('local', () => client.local(tx, { preflight: false, signatureVerification: false }));
  if (r.result.status !== 'success') throw new Error(`local(${code.slice(0, 100)}) on chain ${o.chainId} failed: ${errorText(r)}`);
  return unwrap((r.result as any).data);
}

export type WithCap = (name: string, ...args: any[]) => any;
export type Signer = { kp: Keypair; caps?: (wc: WithCap) => any[] };
export type TxSpec = {
  code: string; label: string; sender: string; signers: Signer[]; chainId: ChainId;
  data?: Record<string, any>; gasLimit?: number; gasPrice?: number; ttl?: number; nonce?: string;
  creationTime?: number;   // seconds; default: chain time - 15s
};

export async function buildSigned(s: TxSpec): Promise<ICommand> {
  const ct = s.creationTime ?? Math.floor((await chainTime(s.chainId)).getTime() / 1000) - 15;
  let b: any = Pact.builder.execution(s.code);
  for (const sg of s.signers) b = sg.caps ? b.addSigner(sg.kp.publicKey, sg.caps) : b.addSigner(sg.kp.publicKey);
  for (const [k, v] of Object.entries(s.data ?? {})) b = b.addData(k, v);
  b = b.setMeta({ chainId: s.chainId, senderAccount: s.sender, gasLimit: s.gasLimit ?? 150000, gasPrice: s.gasPrice ?? GAS_PRICE, ttl: s.ttl ?? 1800, creationTime: ct })
       .setNetworkId(NETWORK_ID);
  if (s.nonce) b = b.setNonce(s.nonce);
  const tx: IUnsignedCommand = b.createTransaction();
  let signed: any = tx;
  for (const sg of s.signers) signed = await signWith(sg.kp)(signed);
  return signed as ICommand;
}

export type Landed = { requestKey: string; gas: number; data: any; result: ICommandResult; height: number };

// Preflight, submit, poll. Throws on any failure (preflight or mined).
export async function send(s: TxSpec): Promise<Landed> {
  const signed = await buildSigned(s);
  const pre = await retrying('preflight', () => client.local(signed, { preflight: true, signatureVerification: true }));
  if (pre.result.status !== 'success') throw new Error(`${s.label}: preflight FAILED: ${errorText(pre)}`);
  const desc = await retrying('submit', () => client.submit(signed));
  const r = await pollMined(desc.requestKey, s.chainId, s.label);
  if (r.result.status !== 'success') throw new Error(`${s.label}: mined tx FAILED: ${errorText(r)}`);
  const gas = Number((r as any).gas);
  const height = Number((r as any).metaData?.blockHeight ?? -1);
  console.log(`  ✓ ${s.label}  chain ${s.chainId}  gas=${gas}  height=${height}  rk=${desc.requestKey}`);
  return { requestKey: desc.requestKey, gas, data: unwrap((r.result as any).data), result: r, height };
}

export async function pollMined(requestKey: string, chainId: ChainId, label: string, maxWaitMs = 600_000): Promise<ICommandResult> {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    try {
      return await client.pollOne({ requestKey, chainId, networkId: NETWORK_ID }, { timeout: 20_000, interval: 1_000 });
    } catch { /* not yet mined within the slice */ }
  }
  throw new Error(`${label}: ${requestKey} not mined after ${Math.round((Date.now() - started) / 1000)}s`);
}

// The negative twin: preflight (signatures verified, nothing mined) must fail with the substring.
export async function sendExpectFail(s: TxSpec, mustContain: string): Promise<string> {
  const signed = await buildSigned(s);
  const pre = await retrying('preflight', () => client.local(signed, { preflight: true, signatureVerification: true }));
  if (pre.result.status === 'success') throw new Error(`${s.label}: expected refusal containing "${mustContain}" but preflight SUCCEEDED`);
  const msg = errorText(pre);
  if (!msg.includes(mustContain)) throw new Error(`${s.label}: expected "${mustContain}", got: ${msg.slice(0, 400)}`);
  console.log(`  ✓ refused as expected: ${s.label} — "${mustContain}"`);
  return msg;
}

export async function balance(account: string, chainId: ChainId): Promise<number> {
  try { return Number(await local(`(coin.get-balance ${JSON.stringify(account)})`, { chainId })); } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Block headers from the node. The object encoding is served by the node itself;
// some public proxies only pass the binary encoding, so both are handled.
// ---------------------------------------------------------------------------
export type Header = { height: number; hash: string; parent: string; creationTime: number; chainId: number };

const b64d = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Binary header layout (318 bytes, validated field-by-field against the object encoding):
// flags 8 | creationTime u64le | parent 32 | adjCount u16le | adj (u32le cid + 32) x n |
// target 32 | payloadHash 32 | chainId u32le | weight 32 | height u64le | version u32le |
// epochStart u64le | nonce 8 | hash 32
export function parseBinaryHeader(b64: string): Header {
  const raw = b64d(b64); let p = 0;
  const take = (n: number) => { const s = raw.subarray(p, p + n); p += n; return s; };
  take(8);
  const creationTime = Number(take(8).readBigUInt64LE());
  const parent = b64u(take(32));
  const n = take(2).readUInt16LE();
  for (let i = 0; i < n; i++) { take(4); take(32); }
  take(32); take(32);
  const chainId = take(4).readUInt32LE();
  take(32);
  const height = Number(take(8).readBigUInt64LE());
  take(4); take(8); take(8);
  const hash = b64u(take(32));
  if (p !== raw.length) throw new Error(`binary header: consumed ${p} of ${raw.length} bytes`);
  return { height, hash, parent, creationTime, chainId };
}

export async function getJson(url: string, accept = 'application/json'): Promise<any> {
  return retrying(`GET ${url}`, async () => {
    const r = await fetch(url, { headers: { Accept: accept } });
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${await r.text().then((t) => t.slice(0, 120))}`);
    return r.json();
  });
}

// The node's current cut: height + hash per chain.
export async function cut(): Promise<Record<string, { height: number; hash: string }>> {
  return (await getJson(`${API}/cut`)).hashes;
}

// Headers for [min, max] on a chain, following pagination. Object encoding first; binary fallback.
// NOTE: the /header endpoint returns every header the node knows at those heights, INCLUDING
// orphaned forks. Callers that need the canonical chain use canonicalHeaders().
export async function headers(chainId: ChainId, min: number, max: number): Promise<Header[]> {
  const out: Header[] = [];
  let next: string | undefined;
  for (;;) {
    const url = `${API}/chain/${chainId}/header?minheight=${min}&maxheight=${max}&limit=360${next ? `&next=${next}` : ''}`;
    let page: any;
    try {
      page = await getJson(url, 'application/json;blockheader-encoding=object');
      for (const h of page.items) out.push({ height: h.height, hash: h.hash, parent: h.parent, creationTime: h.creationTime, chainId: h.chainId });
    } catch (e: any) {
      if (!/406/.test(String(e?.message))) throw e;
      page = await getJson(url, 'application/json');
      for (const b of page.items) out.push(parseBinaryHeader(b));
    }
    next = page.next;
    if (!next) break;
  }
  return out;
}

// The CANONICAL headers for [min, max]: walk parent links back from the cut so orphans drop out.
export async function canonicalHeaders(chainId: ChainId, min: number, max: number): Promise<Header[]> {
  const top = (await cut())[chainId];
  if (max > top.height) throw new Error(`chain ${chainId}: max ${max} is above the cut ${top.height}`);
  const all = await headers(chainId, min, top.height);
  const byHash = new Map(all.map((h) => [h.hash, h]));
  const canon: Header[] = [];
  let cur: Header | undefined = byHash.get(top.hash);
  if (!cur) throw new Error(`chain ${chainId}: the cut hash ${top.hash} is not among the fetched headers`);
  while (cur && cur.height >= min) {
    if (cur.height <= max) canon.push(cur);
    cur = byHash.get(cur.parent);
  }
  canon.reverse();
  // Contiguity is a hard requirement: a hole means the node did not serve a canonical link.
  for (let i = 1; i < canon.length; i++) {
    if (canon[i].height !== canon[i - 1].height + 1 || canon[i].parent !== canon[i - 1].hash) throw new Error(`chain ${chainId}: canonical walk broke at height ${canon[i].height}`);
  }
  if (canon.length && canon[0].height !== min) throw new Error(`chain ${chainId}: canonical walk did not reach ${min} (stopped at ${canon[0].height})`);
  return canon;
}

// Pact's stable time encoding with microseconds: {"timep": "YYYY-MM-DDTHH:MM:SS.ffffffZ"}
export function pactTime(micros: number): { timep: string } {
  const ms = Math.floor(micros / 1000);
  const frac = String(micros % 1_000_000).padStart(6, '0');
  return { timep: new Date(ms).toISOString().replace(/\.\d{3}Z$/, `.${frac}Z`) };
}
// Parse "2026-09-07T18:24:54.398438Z" (or without fraction) -> microseconds since epoch
export function microsOf(iso: string): number {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/);
  if (!m) throw new Error(`bad time ${iso}`);
  return Date.parse(m[1] + 'Z') * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
}
