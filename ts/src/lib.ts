// Shared plumbing for every block-history tool: network config, keys, signing, submit/poll,
// header fetching. Targets any Chainweb node at
//   $BH_HOST/chainweb/0.0/$BH_NETWORK_ID/...
// Defaults are the local devnet in ../devnet (recap-development, :8095).
import {
  Pact, createClient, createSignWithKeypair,
  type ChainId, type ICommand, type ICommandResult, type IUnsignedCommand,
} from '@kadena/client';
import {
  genKeyPair, hash as blakeHash, signHash, verifySig, restoreKeyPairFromSecretKey, hexToBin, base64UrlDecodeArr,
} from '@kadena/cryptography-utils';
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

export async function retrying<T>(what: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
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


// ---------------------------------------------------------------------------------------------
// The deploy's two commands, built in ONE place so the gas-key signer can recognise them exactly.
// The gas payer's signature is scoped to coin.GAS: neither command needs it for anything else
// (claiming an unclaimed name in `free`, and a module's first deploy, are unauthenticated), so a
// signature on them can pay gas and nothing more.
export const KEYSET_GAS_LIMIT = 2000;
export const MODULE_GAS_LIMIT = 120000;
// Ten times the network's minimum price: a mistyped BH_GAS_PRICE stops here instead of being signed.
export const MAX_GAS_PRICE = 1e-7;
export const keysetDeployCode = (ns: string) =>
  `(namespace ${JSON.stringify(ns)}) (define-keyset ${JSON.stringify(`${ns}.block-history-backfill`)} (read-keyset "ks"))`;
export const sameKeyset = (a: any, b: { keys: string[]; pred: string }) =>
  !!a && a.pred === b.pred && Array.isArray(a.keys) && a.keys.length === b.keys.length
  && [...a.keys].sort().join() === [...b.keys].sort().join();

export type Keyset = { keys: string[]; pred: string };
// The backfill keyset is permanent once claimed, so a malformed one must never reach a command. Pact
// treats a keys-all over no keys as always satisfied (anyone could backfill) and keys-2 over one key
// as never satisfiable (backfill dead forever). Throws naming the problem.
export function validateKeyset(ks: any): Keyset {
  if (!ks || typeof ks !== 'object' || !Array.isArray(ks.keys)) throw new Error('keyset-shape: must be {"keys": [...], "pred": "..."}');
  const extra = Object.keys(ks).filter((k) => k !== 'keys' && k !== 'pred');
  if (extra.length) throw new Error(`keyset-field: unexpected field(s) ${extra.join(', ')}`);
  if (!['keys-all', 'keys-any', 'keys-2'].includes(ks.pred)) throw new Error(`keyset-pred: pred must be keys-all, keys-any or keys-2, got ${JSON.stringify(ks.pred)}`);
  if (ks.keys.length === 0) throw new Error('keyset-empty: it has no keys, and Pact would let anyone satisfy it');
  if (!ks.keys.every((k: unknown) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k))) throw new Error('keyset-hex: every key must be 64 lower-case hex characters');
  if (new Set(ks.keys).size !== ks.keys.length) throw new Error('keyset-repeat: a key is listed twice');
  if (ks.pred === 'keys-2' && ks.keys.length < 2) throw new Error('keyset-threshold: keys-2 needs at least two keys');
  return { keys: ks.keys, pred: ks.pred };
}

export type Emitted = { cmd: string; hash: string; sigs: ({ pubKey?: string; sig?: string } | null)[] };
export type Signed = { cmd: string; hash: string; sigs: { sig: string }[] };

// The ONE builder for the deploy's commands: deploy.ts writes with it, and signGasSlot rebuilds with it
// to demand the exact same bytes. The nonce is derived from the chain and the creation time, so the
// rebuild reproduces it exactly and a file cannot carry any other text there.
export function buildUnsignedGasOnly(s: {
  code: string; data: Record<string, any>; chainId: ChainId; sender: string; signerPubKey: string;
  gasLimit: number; creationTime: number; gasPrice?: number; networkId?: string; nonce?: string;
}): Emitted {
  let b: any = Pact.builder.execution(s.code).addSigner(s.signerPubKey, (wc: WithCap) => [wc('coin.GAS')]);
  for (const [k, v] of Object.entries(s.data)) b = b.addData(k, v);
  const tx: IUnsignedCommand = b
    .setMeta({ chainId: s.chainId, senderAccount: s.sender, gasLimit: s.gasLimit, gasPrice: s.gasPrice ?? GAS_PRICE, ttl: 28800, creationTime: s.creationTime })
    .setNetworkId(s.networkId ?? NETWORK_ID)
    .setNonce(s.nonce ?? `block-history:${s.chainId}:${s.creationTime}`)
    .createTransaction();
  return { cmd: tx.cmd, hash: tx.hash, sigs: [{ pubKey: s.signerPubKey }] };
}

// `now` is the target chain's own time in seconds: a command is signed only while that chain would accept it.
export type DeployExpect = { networkId: string; ns: string; source: string; keyset: Keyset | null; gasPrice: number; now: number };
export type GasSigned = { signed: Signed; kind: 'keyset' | 'module'; chainId: ChainId; fee: number };
const fail: (code: string, msg: string) => never = (code, msg) => { throw new Error(`${code}: ${msg}`); };

// A command file's own integrity, checked before the node is asked anything about it: its hash is the
// hash of its command, and it names a chain 0-19. Returns that chain.
export function fileChain(tx: { cmd: string; hash: string }): ChainId {
  if (typeof tx?.cmd !== 'string' || blakeHash(tx.cmd) !== tx.hash) fail('hash', 'the file hash does not match its command');
  let chainId: unknown;
  try { chainId = JSON.parse(tx.cmd)?.meta?.chainId; } catch { /* refused just below */ }
  if (typeof chainId !== 'string' || !/^1?[0-9]$/.test(chainId)) fail('chain', `not a chain id 0-19: ${JSON.stringify(chainId)}`);
  return chainId as ChainId;
}

// What the node's status lookup of a command's hash decides, before the command is signed or checked.
// One the chain has not seen goes on. One on chain that succeeded is skipped, however long ago it was
// created, so re-running after a partial session is safe. One on chain that failed, or whose status
// cannot be read, stops the run.
export function statusDecision(prior: ICommandResult | undefined): 'go' | 'skip' | 'fail' {
  return !prior ? 'go' : prior.result?.status === 'success' ? 'skip' : 'fail';
}

// What the deploy's two commands must carry besides their code, for the gas-key signer and for commands
// signed elsewhere alike. Both need the configured backfill keyset: the keyset command must carry exactly
// it, and a module command is sent only on a chain where it is already defined.
function checkContent(kind: 'keyset' | 'module', data: any, x: Pick<DeployExpect, 'ns' | 'keyset'>): void {
  if (!x.keyset) fail('content-keyset-missing', 'no backfill keyset is configured (BH_BACKFILL_KEYSET): the keyset command must carry it, and a module command is sent only where it is already on chain');
  try { validateKeyset(x.keyset); } catch (e: any) { fail('content-keyset-invalid', `the configured backfill keyset is invalid — ${e?.message ?? e}`); }
  if (kind === 'keyset' && (!data || !sameKeyset(data.ks, x.keyset!))) fail('content-keyset', 'the keyset in this command is not the configured backfill keyset');
  if (kind === 'module' && (!data || data.ns !== x.ns)) fail('content-module', `the module command's namespace must be "${x.ns}"`);
}

// Signs the gas payer's slot of ONE emitted deploy command, or throws naming the guard that refused.
// Pure — no network, nothing printed. Every check runs BEFORE anything is signed, and the last one
// rebuilds the command from what it must contain and demands the file's bytes be exactly that.
export function signGasSlot(tx: Emitted, gasKey: { secretKey: string; publicKey?: string }, x: DeployExpect): GasSigned {
  if (typeof gasKey.secretKey !== 'string' || !/^[0-9a-f]{64}$/.test(gasKey.secretKey)) fail('key-file-secret', 'secretKey must be 64 hex characters');
  const pub = restoreKeyPairFromSecretKey(gasKey.secretKey).publicKey;
  if (gasKey.publicKey !== undefined && gasKey.publicKey !== pub) fail('key-file-public', 'its publicKey does not belong to its secretKey');
  if (!(typeof x.gasPrice === 'number' && x.gasPrice > 0 && x.gasPrice <= MAX_GAS_PRICE)) fail('gas-price-ceiling', `the configured gas price ${x.gasPrice} is outside (0, ${MAX_GAS_PRICE}]`);
  let cmd: any;
  try { cmd = JSON.parse(tx.cmd); } catch { fail('format-json', 'the command is not JSON'); }
  // Exactly the bytes the deploy tool writes (JSON.stringify of the command). A duplicated key or odd
  // encoding could make this parser and the node's read different commands from the same text.
  if (JSON.stringify(cmd) !== tx.cmd) fail('format-exact', 'the command is not in the exact form the deploy tool writes');
  if (cmd.networkId !== x.networkId) fail('network', `the command is for ${cmd.networkId}, this run targets ${x.networkId}`);
  const chainId = fileChain(tx);
  if (cmd.meta?.sender !== `k:${pub}`) fail('sender', `the command's gas payer is ${cmd.meta?.sender}, not this key's account k:${pub}`);
  const signers = Array.isArray(cmd.signers) ? cmd.signers : [];
  const s0 = signers[0];
  if (signers.length !== 1 || !s0 || typeof s0 !== 'object' || s0.pubKey !== pub) fail('signers', 'the command must have exactly one signer, this key');
  const clist = Array.isArray(s0.clist) ? s0.clist : [];
  if (clist.length !== 1 || clist[0].name !== 'coin.GAS' || !Array.isArray(clist[0].args) || clist[0].args.length !== 0) fail('scope', 'the signature must be scoped to coin.GAS alone');
  if (cmd.meta.gasPrice !== x.gasPrice) fail('gas-price', `${JSON.stringify(cmd.meta.gasPrice)}, expected ${x.gasPrice}`);
  const ct = cmd.meta.creationTime;
  if (!Number.isInteger(ct) || ct <= 0) fail('creation-time', `not a positive whole number of seconds: ${JSON.stringify(ct)}`);
  if (!(Number.isFinite(x.now) && ct >= x.now - 28800 && ct <= x.now + 60)) fail('creation-time-window', `created at ${ct}, outside the 8 hours before this chain's time ${x.now} — rebuild the file`);
  if (typeof cmd.nonce !== 'string') fail('nonce', 'the nonce must be a string');
  const code = cmd.payload?.exec?.code;
  const data = cmd.payload?.exec?.data;
  let kind: 'keyset' | 'module', limit: number, expectData: Record<string, any>;
  if (code === keysetDeployCode(x.ns)) {
    checkContent('keyset', data, x);
    kind = 'keyset'; limit = KEYSET_GAS_LIMIT; expectData = { ks: x.keyset };
  } else if (code === x.source) {
    checkContent('module', data, x);
    kind = 'module'; limit = MODULE_GAS_LIMIT; expectData = { ns: x.ns };
  } else {
    fail('content-shape', 'neither the backfill keyset definition nor the exact module source — refusing to sign');
  }
  if (cmd.meta.gasLimit !== limit!) fail('gas-limit', `${JSON.stringify(cmd.meta.gasLimit)}, expected exactly ${limit!} for this command`);
  // The catch-all: rebuild from what the command must contain; no field this function does not name
  // (ttl, an extra key, a continuation, verifiers, a signer scheme, …) can ride along.
  const rebuilt = buildUnsignedGasOnly({
    code, data: expectData!, chainId: chainId as ChainId, sender: `k:${pub}`, signerPubKey: pub, gasLimit: limit!, gasPrice: x.gasPrice,
    creationTime: ct, networkId: x.networkId,
  });
  if (rebuilt.cmd !== tx.cmd) fail('exact', 'the command differs from the one the deploy tool writes for this content');
  const sig = signHash(tx.hash, { publicKey: pub, secretKey: gasKey.secretKey }).sig;
  if (!sig || !verifySig(base64UrlDecodeArr(tx.hash), hexToBin(sig), hexToBin(pub))) fail('signature', 'it did not verify');
  return { signed: { cmd: tx.cmd, hash: tx.hash, sigs: [{ sig: sig! }] }, kind: kind!, chainId: chainId as ChainId, fee: limit! * x.gasPrice };
}

// The body a check-only preflight sends: the command and its signer slots with NO signature. Built from
// the parsed command, never forwarded from the file, so a signature a file may carry never leaves this
// machine.
export function unsignedBody(tx: { cmd: string; hash: string }): Emitted {
  const signers = JSON.parse(tx.cmd)?.signers;
  return { cmd: tx.cmd, hash: tx.hash, sigs: (Array.isArray(signers) ? signers : []).map((s: any) => ({ pubKey: s?.pubKey })) };
}

// What a preflight sends, and whether the node verifies its signatures. With --send: the signed command,
// verified. Check only: the unsigned body, not verified — so nothing signed leaves this machine.
export function preflightRequest(tx: Signed, send: boolean): { body: Emitted | Signed; signatureVerification: boolean } {
  return send ? { body: tx, signatureVerification: true } : { body: unsignedBody(tx), signatureVerification: false };
}

// Which of the deploy's two commands a command is, by its code alone; 'other' for anything else, such as
// a backfill batch. Commands signed elsewhere are deduplicated and gated by it too (through relayKind).
export function commandKind(cmdText: string, ns: string, source: string): 'keyset' | 'module' | 'other' {
  let code: unknown;
  try { code = JSON.parse(cmdText)?.payload?.exec?.code; } catch { return 'other'; }
  return code === keysetDeployCode(ns) ? 'keyset' : code === source ? 'module' : 'other';
}

// A module, interface or keyset definition anywhere in Pact code. Pact allows whitespace and comments
// (`;` to the end of the line) between the parenthesis and the keyword.
const DEFINITION = /\((?:\s|;[^\n]*\n)*(?:module|interface|define-keyset)\b/;

// For commands signed elsewhere: commandKind, or a throw naming why it cannot be sent. The deploy's two
// commands must carry what the gas-key signer demands of them. Any other module, interface or keyset
// definition is refused: the rule that a module goes only where the backfill keyset is ours knows only
// this checkout's module, and the keyset check only the deploy's own keyset command.
export function relayKind(cmdText: string, x: Pick<DeployExpect, 'ns' | 'source' | 'keyset'>): 'keyset' | 'module' | 'other' {
  let exec: any;
  try { exec = JSON.parse(cmdText)?.payload?.exec; } catch { /* not JSON: verifySigned refuses it */ }
  const kind = commandKind(cmdText, x.ns, x.source);
  if (kind !== 'other') checkContent(kind, exec?.data, x);
  else if (typeof exec?.code === 'string' && DEFINITION.test(exec.code)) fail('content-definition', 'it defines a module, interface or keyset, and is not exactly one of the deploy\'s two commands');
  return kind;
}

// For commands signed elsewhere: every signer slot is filled and verifies against the command's
// hash. Returns the reason it cannot be sent, or null.
export function verifySigned(tx: Emitted, networkId: string): string | null {
  let cmd: any;
  try { cmd = JSON.parse(tx.cmd); } catch { return 'format: the command is not JSON'; }
  if (cmd.networkId !== networkId) return `network: the command is for ${cmd.networkId}, this run targets ${networkId}`;
  if (blakeHash(tx.cmd) !== tx.hash) return 'hash: the file hash does not match its command';
  const signers = Array.isArray(cmd.signers) ? cmd.signers : [];
  if (!Array.isArray(tx.sigs) || tx.sigs.length !== signers.length) return `signatures: expected ${signers.length}, found ${Array.isArray(tx.sigs) ? tx.sigs.length : 0}`;
  for (let i = 0; i < signers.length; i++) {
    const sig = tx.sigs[i]?.sig;
    if (!sig) return `signatures: signer ${i + 1} of ${signers.length} has not signed`;
    if (!/^[0-9a-f]{128}$/.test(sig) || !verifySig(base64UrlDecodeArr(tx.hash), hexToBin(sig), hexToBin(signers[i].pubKey)))
      return `signatures: signer ${i + 1} of ${signers.length} does not verify`;
  }
  return null;
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
