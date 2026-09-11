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
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
  const res: any = (r as any)?.result;
  if (!res) return `no readable result: ${String(JSON.stringify(r)).slice(0, 200)}`;
  const e: any = res.error ?? {};
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
  return sendBuilt(await buildSigned(s), s.chainId, s.label);
}

// The same for a command already built and signed. `beforeSubmit` runs once the node's preflight has
// passed, just before the command is submitted, so a caller can record exactly what it sends.
export async function sendBuilt(signed: ICommand, chainId: ChainId, label: string, beforeSubmit?: () => void): Promise<Landed> {
  const pre = await retrying('preflight', () => client.local(signed, { preflight: true, signatureVerification: true }));
  if (pre.result.status !== 'success') throw new Error(`${label}: preflight FAILED: ${errorText(pre)}`);
  beforeSubmit?.();
  const desc = await retrying('submit', () => client.submit(signed));
  const r = await pollMined(desc.requestKey, chainId, label);
  if (r.result.status !== 'success') throw new Error(`${label}: mined tx FAILED: ${errorText(r)}`);
  const gas = Number((r as any).gas);
  const height = Number((r as any).metaData?.blockHeight ?? -1);
  console.log(`  ✓ ${label}  chain ${chainId}  gas=${gas}  height=${height}  rk=${desc.requestKey}`);
  return { requestKey: desc.requestKey, gas, data: unwrap((r.result as any).data), result: r, height };
}

// One status lookup a second until the node reports the command. Not client.pollOne: its retry re-arms
// its deadline as the time left minus the pause it has just slept, so a slice could end on a negative
// setTimeout, which Node reports as a TimeoutNegativeWarning.
export async function pollMined(requestKey: string, chainId: ChainId, label: string, maxWaitMs = 600_000): Promise<ICommandResult> {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    try {
      const r = (await client.getStatus({ requestKey, chainId, networkId: NETWORK_ID }))[requestKey];
      if (r) return r;
    } catch { /* the node did not answer this time; ask again */ }
    await sleep(1_000);
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
// The deploy's one command — the module source with {"ns": BH_NS} — built in ONE place so the gas-key
// signer can recognise it exactly. The gas payer's signature is scoped to coin.GAS: a module's first
// deploy into `free` needs no other signature, so a signature on it can pay gas and nothing more.
export const MODULE_GAS_LIMIT = 120000;
// Ten times the network's minimum price: a mistyped BH_GAS_PRICE stops here instead of being signed.
export const MAX_GAS_PRICE = 1e-7;

export type Emitted = { cmd: string; hash: string; sigs: ({ pubKey?: string; sig?: string } | null)[] };
export type Signed = { cmd: string; hash: string; sigs: { sig: string }[] };

// The ONE builder for the deploy's command: deploy.ts writes with it, and signGasSlot rebuilds with it
// to demand the exact same bytes. The nonce is derived from the chain and the creation time, so the
// rebuild reproduces it exactly and a file cannot carry any other text there.
export function buildUnsignedGasOnly(s: {
  code: string; data: Record<string, any>; chainId: ChainId; sender: string; signerPubKey: string;
  gasLimit: number; creationTime: number; gasPrice?: number; networkId?: string; nonce?: string; ttl?: number;
}): Emitted {
  let b: any = Pact.builder.execution(s.code).addSigner(s.signerPubKey, (wc: WithCap) => [wc('coin.GAS')]);
  for (const [k, v] of Object.entries(s.data)) b = b.addData(k, v);
  const tx: IUnsignedCommand = b
    .setMeta({ chainId: s.chainId, senderAccount: s.sender, gasLimit: s.gasLimit, gasPrice: s.gasPrice ?? GAS_PRICE, ttl: s.ttl ?? 28800, creationTime: s.creationTime })
    .setNetworkId(s.networkId ?? NETWORK_ID)
    .setNonce(s.nonce ?? `block-history:${s.chainId}:${s.creationTime}`)
    .createTransaction();
  return { cmd: tx.cmd, hash: tx.hash, sigs: [{ pubKey: s.signerPubKey }] };
}

// `now` is the target chain's own time in seconds: a command is signed only while that chain would accept it.
export type DeployExpect = { networkId: string; ns: string; source: string; gasPrice: number; now: number };
export type GasSigned = { signed: Signed; chainId: ChainId; fee: number };
const fail: (code: string, msg: string) => never = (code, msg) => { throw new Error(`${code}: ${msg}`); };

// A command file's own integrity, checked before the node is asked anything about it: its hash is the
// hash of its command, the command is exactly the JSON the tools write, and it names a chain 0-19.
// Returns that chain. Only the exact form is accepted: a command with a repeated key, for example, can be
// read one way here and another way by the node.
export function fileChain(tx: { cmd: string; hash: string }): ChainId {
  if (typeof tx?.cmd !== 'string' || blakeHash(tx.cmd) !== tx.hash) fail('hash', 'the file hash does not match its command');
  let cmd: any;
  try { cmd = JSON.parse(tx.cmd); } catch { fail('format-json', 'the command is not JSON'); }
  if (JSON.stringify(cmd) !== tx.cmd) fail('format-exact', 'the command is not in the exact form the tools write, so this tool and the node could read different commands from it');
  const chainId: unknown = cmd?.meta?.chainId;
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

// What the module command must carry besides its code, for the gas-key signer and for commands signed
// elsewhere alike: {"ns": BH_NS}, so the module lands in the namespace this run targets.
function checkContent(data: any, ns: string): void {
  if (!data || data.ns !== ns) fail('content-module', `the module command's namespace must be "${ns}"`);
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
  if (cmd.payload?.exec?.code !== x.source) fail('content-shape', 'not the exact module source — refusing to sign');
  checkContent(cmd.payload.exec.data, x.ns);
  if (cmd.meta.gasLimit !== MODULE_GAS_LIMIT) fail('gas-limit', `${JSON.stringify(cmd.meta.gasLimit)}, expected exactly ${MODULE_GAS_LIMIT}`);
  // The catch-all: rebuild from what the command must contain; no field this function does not name
  // (ttl, an extra key, a continuation, verifiers, a signer scheme, …) can ride along.
  const rebuilt = buildUnsignedGasOnly({
    code: x.source, data: { ns: x.ns }, chainId, sender: `k:${pub}`, signerPubKey: pub, gasLimit: MODULE_GAS_LIMIT, gasPrice: x.gasPrice,
    creationTime: ct, networkId: x.networkId,
  });
  if (rebuilt.cmd !== tx.cmd) fail('exact', 'the command differs from the one the deploy tool writes');
  const sig = signHash(tx.hash, { publicKey: pub, secretKey: gasKey.secretKey }).sig;
  if (!sig || !verifySig(base64UrlDecodeArr(tx.hash), hexToBin(sig), hexToBin(pub))) fail('signature', 'it did not verify');
  return { signed: { cmd: tx.cmd, hash: tx.hash, sigs: [{ sig: sig! }] }, chainId, fee: MODULE_GAS_LIMIT * x.gasPrice };
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

// Whether a command is the deploy's module command, by its code alone; 'other' for anything else. Commands
// signed elsewhere are deduplicated and gated by it too (through relayKind).
export function commandKind(cmdText: string, source: string): 'module' | 'other' {
  let code: unknown;
  try { code = JSON.parse(cmdText)?.payload?.exec?.code; } catch { return 'other'; }
  return code === source ? 'module' : 'other';
}

// A module, interface or keyset definition anywhere in Pact code. Pact allows whitespace and comments
// (`;` to the end of the line) between the parenthesis and the keyword `module` or `interface`, both
// special forms. define-keyset is an ordinary function that can also be passed to fold or map, so any
// mention of it counts; a false match only refuses.
const DEFINITION = /\((?:\s|;[^\n]*\n)*(?:module|interface)\b|define-keyset/;

// For commands signed elsewhere: commandKind, or a throw naming why it cannot be sent. The command must be
// exactly the JSON the tools write, checked here too so this gate holds without fileChain: a repeated key
// could make this parser and the node read different code from the same text. The module command must
// carry what the gas-key signer demands of it. Any other module, interface or keyset definition is
// refused: this tool carries this checkout's module, and nothing else that claims a name.
export function relayKind(cmdText: string, x: Pick<DeployExpect, 'ns' | 'source'>): 'module' | 'other' {
  let cmd: any;
  try { cmd = JSON.parse(cmdText); } catch { fail('format-json', 'the command is not JSON'); }
  if (JSON.stringify(cmd) !== cmdText) fail('format-exact', 'the command is not in the exact form the tools write, so this tool and the node could read different commands from it');
  const exec = cmd?.payload?.exec;
  const kind = commandKind(cmdText, x.source);
  if (kind === 'module') checkContent(exec?.data, x.ns);
  else if (typeof exec?.code === 'string' && DEFINITION.test(exec.code)) fail('content-definition', 'it defines a module, interface or keyset, and is not exactly the deploy\'s module command');
  return kind;
}

// What a command already on chain must be for a run to skip it without signing: one this run would have
// sent. With --gas-key that is the deploy's module command alone, the only command that mode signs;
// without it, any command relayKind accepts. Anything else means the chain holds something this deploy
// did not intend, and the run stops to say so. Signatures and creation time are not judged: the chain
// has already accepted both. Returns the kind, or throws naming why.
export function spentKind(cmdText: string, x: Pick<DeployExpect, 'ns' | 'source'>, withGasKey: boolean): 'module' | 'other' {
  const kind = relayKind(cmdText, x);
  if (withGasKey && kind !== 'module') fail('spent-other', 'it is not the deploy\'s module command, the only command --gas-key signs');
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

// ---------------------------------------------------------------------------------------------
// Whose module a chain carries. A module hash covers the (module …) form only, so a copy someone else
// deploys — the identical code plus writes of its own in the same transaction, where the deployer holds
// module admin — carries the SAME hash with forged rows or a forged `latest`. The hash cannot tell the two
// apart; the transaction that carried the module can.

// Where deploy.ts writes this network's deploy files, one per chain, each named for the module (so for its
// namespace too).
export const DEPLOY_DIR = join(OUT, 'unsigned', NETWORK_ID);

export type DeployFile = { file: string; cmd: string; hash: string };
export type ProofExpect = Pick<DeployExpect, 'networkId' | 'ns' | 'source'>;

// The chain a deploy file can speak for, or a throw naming why it proves nothing. It is judged the way a
// command signed elsewhere is: fileChain (its hash is its command's own, so the hash is the request key of
// exactly this command, and the chain is the one the command names), this run's network, and relayKind's
// module command (this checkout's exact module source, into this run's namespace). Then, as signGasSlot
// ends, the exact rebuild: the deploy's own builder, given this checkout's code and data and, from the file,
// only what may differ between runs (gas payer, signer key, creation time, gas price, gas limit, ttl), must
// reproduce the file's bytes, so no extra data key, continuation, verifier or signer rides along. A success
// on chain for any other command proves only that THAT command ran.
export function proofChain(tx: { cmd: string; hash: string }, x: ProofExpect): ChainId {
  const chainId = fileChain(tx);
  const cmd = JSON.parse(tx.cmd), networkId = cmd.networkId;
  if (networkId !== x.networkId) fail('network', `the command is for ${networkId}, this run targets ${x.networkId}`);
  if (relayKind(tx.cmd, x) !== 'module') fail('proof-other', 'it is not the deploy\'s module command: its code is not this checkout\'s exact module source');
  const m = cmd.meta ?? {};
  let rebuilt = '';
  try {
    rebuilt = buildUnsignedGasOnly({
      code: x.source, data: { ns: x.ns }, chainId, sender: m.sender, signerPubKey: cmd.signers?.[0]?.pubKey,
      gasLimit: m.gasLimit, gasPrice: m.gasPrice, creationTime: m.creationTime, ttl: m.ttl, networkId: x.networkId,
    }).cmd;
  } catch { /* fields the builder cannot take: there are no bytes to match */ }
  if (rebuilt !== tx.cmd) fail('exact', 'the command differs from the one the deploy tool writes');
  return chainId;
}

// The request keys that can speak for a chain: those of the deploy files proofChain accepts for it.
export function proofKeys(files: { cmd: string; hash: string }[], chainId: ChainId, x: ProofExpect): string[] {
  return files.filter((tx) => { try { return proofChain(tx, x) === chainId; } catch { return false; } }).map((tx) => tx.hash);
}

export type Ownership = 'available' | 'ours' | 'lost';

// A chain's module is OURS only when one of the operator's deploy files for that chain has a request key
// whose status there is success: the file's hash binds the exact payload built and checked here, so that
// success proves the deploy transaction carried exactly that payload. Present but not proven ours is LOST,
// whatever its hash. Absent is available. `statuses` is the chain's status lookup of proofKeys: a key in it
// that belongs to no accepted file counts for nothing, and with no file at all nothing is proven.
export function ownership(
  s: { present: boolean; chainId: ChainId; files: { cmd: string; hash: string }[]; statuses: Record<string, ICommandResult | undefined> },
  x: ProofExpect,
): Ownership {
  if (!s.present) return 'available';
  return proofKeys(s.files, s.chainId, x).some((k) => s.statuses[k]?.result?.status === 'success') ? 'ours' : 'lost';
}

// Where a deploy file goes when a fresh one replaces it, or when its chain is LOST: out of the send glob
// (out/unsigned/<network-id>/*.json), and never deleted. The send reads it only when it is named.
export const SUPERSEDED = 'superseded';

// The operator's deploy files for this network: every file in the directory and in its superseded/, since a
// file moved aside is still proof material. `files` holds those proofChain accepts; `refused` names every
// other file there and why it proves nothing. ownership() still judges every file itself.
export function readDeployFiles(x: ProofExpect, dir: string = DEPLOY_DIR): { files: DeployFile[]; refused: { file: string; why: string }[] } {
  const files: DeployFile[] = [], refused: { file: string; why: string }[] = [];
  for (const sub of ['', SUPERSEDED]) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d).filter((n) => n.endsWith('.json')).sort()) {
      const file = sub ? `${sub}/${n}` : n;
      let f: DeployFile;
      try { const j = JSON.parse(readFileSync(join(d, n), 'utf8')); f = { file, cmd: j?.cmd, hash: j?.hash }; }
      catch { refused.push({ file, why: 'not a readable command file' }); continue; }
      try { proofChain(f, x); files.push(f); } catch (e: any) { refused.push({ file, why: String(e?.message ?? e) }); }
    }
  }
  return { files, refused };
}

// Seconds -> "2026-09-11T08:00:00Z".
export const utc = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// The last moment a command can land: its creation time plus its ttl, in seconds; null if it names neither.
export function validUntil(cmdText: string): number | null {
  let m: any;
  try { m = JSON.parse(cmdText)?.meta; } catch { return null; }
  return Number.isFinite(m?.creationTime) && Number.isFinite(m?.ttl) ? m.creationTime + m.ttl : null;
}

// Moves <dir>/<name> into <dir>/superseded/ under its name with its hash added, and returns the new name
// relative to <dir>. Never over a file already there: a taken name gets .2, .3, … The bytes are copied
// whole before the original is removed.
export function supersede(dir: string, name: string): string {
  const src = join(dir, name);
  const raw = readFileSync(src, 'utf8');
  let tag = '';
  try { tag = String(JSON.parse(raw)?.hash ?? ''); } catch { /* unreadable: named by its bytes below */ }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tag)) tag = blakeHash(raw);
  mkdirSync(join(dir, SUPERSEDED), { recursive: true });
  const base = name.replace(/\.json$/, '');
  for (let i = 1; ; i++) {
    const moved = `${SUPERSEDED}/${base}.${tag}${i > 1 ? `.${i}` : ''}.json`;
    try { copyFileSync(src, join(dir, moved), fsConstants.COPYFILE_EXCL); }
    catch (e: any) { if (e?.code === 'EEXIST') continue; throw e; }
    unlinkSync(src);
    return moved;
  }
}

export type FileFate = { fate: 'keep' | 'supersede'; why: string };

// What deploy may do with the file already at a chain's path, when the module there is not ours: never
// destroy a proof. A file is superseded only when its command can no longer land: it failed on that chain,
// or its creation time plus its ttl is behind the chain's time `now` (seconds). One that succeeded is kept,
// and so is anything that cannot be judged: an unreadable file, one whose hash is not its command's, one
// naming another chain, a status that cannot be read, a command pending, or not yet sent, within its ttl.
export function fileFate(tx: { cmd: string; hash: string } | null, chainId: ChainId, status: ICommandResult | undefined, now: number): FileFate {
  if (!tx) return { fate: 'keep', why: 'it cannot be judged (not a readable command file)' };
  let chain: ChainId;
  try { chain = fileChain(tx); } catch (e: any) { return { fate: 'keep', why: `it cannot be judged (${String(e?.message ?? e)})` }; }
  if (chain !== chainId) return { fate: 'keep', why: `it names chain ${chain}, not chain ${chainId}` };
  if (status?.result?.status === 'success') return { fate: 'keep', why: 'its command succeeded on this chain' };
  if (status?.result?.status === 'failure') return { fate: 'supersede', why: `its command failed on this chain (${errorText(status)})` };
  if (status) return { fate: 'keep', why: 'its status on this chain cannot be read' };
  const until = validUntil(tx.cmd);
  if (until === null) return { fate: 'keep', why: 'it cannot be judged (it names no creation time and ttl)' };
  if (until < now) return { fate: 'supersede', why: `its command expired at ${utc(until)}` };
  return { fate: 'keep', why: `its command can still land until ${utc(until)}` };
}

// fileFate() with the network steps it needs: the file's status on its chain, and that chain's time.
export async function fileFateOn(chainId: ChainId, tx: { cmd: string; hash: string } | null): Promise<FileFate> {
  let judged = false;
  try { judged = !!tx && fileChain(tx) === chainId; } catch { /* fileFate says why */ }
  if (!judged) return fileFate(tx, chainId, undefined, NaN);
  const status = (await retrying('status', () => client.getStatus({ requestKey: tx!.hash, chainId, networkId: NETWORK_ID })))[tx!.hash];
  return fileFate(tx, chainId, status, Math.floor((await chainTime(chainId)).getTime() / 1000));
}

// What deploy does on one chain, from its ownership and the fate of the file at its path (null: no file).
// Ours: untouched. LOST: no file written, and any file there moved aside, out of the send glob. Otherwise a
// file whose command can still land is kept and nothing is regenerated; one whose command cannot is moved
// aside, and a fresh one is written.
export type ChainPlan = { do: 'untouched' } | { do: 'lost'; moveAside: boolean } | { do: 'keep'; why: string } | { do: 'write'; moveAside: boolean; why?: string };
export function planChain(who: Ownership, fate: FileFate | null): ChainPlan {
  if (who === 'ours') return { do: 'untouched' };
  if (who === 'lost') return { do: 'lost', moveAside: fate !== null };
  if (!fate) return { do: 'write', moveAside: false };
  if (fate.fate === 'keep') return { do: 'keep', why: fate.why };
  return { do: 'write', moveAside: true, why: fate.why };
}

// ownership() with the one network step it needs: the chain's status lookup of proofKeys. A lookup the node
// does not answer throws; it never decides the chain.
export async function ownershipOn(chainId: ChainId, present: boolean, files: DeployFile[], x: ProofExpect): Promise<Ownership> {
  const keys = present ? proofKeys(files, chainId, x) : [];
  const statuses = keys.length
    ? await retrying('status', () => client.getStatus(keys.map((requestKey) => ({ requestKey, chainId, networkId: x.networkId }))))
    : {};
  return ownership({ present, chainId, files, statuses }, x);
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

// ---------------------------------------------------------------------------------------------
// The feeder's two optional sending modes, both off by default: the rules for their settings, pure so
// they are checked offline. feeder.ts does the sending.

export const MAX_SUBMIT_HOSTS = 5;

// BH_HOST as the extra hosts are compared with it: scheme, host and port, then any path without its
// trailing slashes. A value that is not a URL is compared as written, less its trailing slashes.
const baseUrl = (s: string) => { try { const u = new URL(s); return u.origin + u.pathname.replace(/\/+$/, ''); } catch { return s.trim().replace(/\/+$/, ''); } };

// BH_SUBMIT_HOSTS: the extra hosts every signed attest also goes to, each reduced to its origin; [] when
// unset or empty. Each must be a bare https://host[:port] (the send path is appended to it), listed once,
// and not `primary` (BH_HOST), which already gets every attest; at most MAX_SUBMIT_HOSTS. A refusal names
// the entry by its position and never repeats what it carried, which could be a password.
export function parseSubmitHosts(spec: string | undefined, primary: string): string[] {
  if (spec === undefined || spec.trim() === '') return [];
  const entries = spec.split(',').map((e) => e.trim());
  if (entries.length > MAX_SUBMIT_HOSTS) fail('hosts-count', `BH_SUBMIT_HOSTS lists ${entries.length} hosts; at most ${MAX_SUBMIT_HOSTS} are allowed`);
  const out: string[] = [];
  for (const [i, e] of entries.entries()) {
    const n = `BH_SUBMIT_HOSTS entry ${i + 1}`;
    let u: URL | undefined;
    try { u = new URL(e); } catch { /* refused just below */ }
    if (!u) return fail('hosts-url', `${n} is ${e === '' ? 'empty' : 'not a URL'}`);
    if (u.protocol !== 'https:') fail('hosts-https', `${n} does not use https`);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) fail('hosts-base', `${n} must be a bare https://host or https://host:port, with no user, password, path, query or fragment`);
    if (out.includes(u.origin)) fail('hosts-duplicate', `${n} repeats ${u.origin}`);
    if (u.origin === baseUrl(primary)) fail('hosts-primary', `${n} is BH_HOST itself (${u.origin}), which already gets every attest`);
    out.push(u.origin);
  }
  return out;
}

// Where a host takes a signed command for a chain: the same Pact /send path the client posts to on BH_HOST.
export const sendUrl = (host: string, networkId: string, chainId: ChainId) => `${host}/chainweb/0.0/${networkId}/chain/${chainId}/pact/api/v1/send`;

// A Chainweb node's refusal of a command it already has. The command is then delivered there.
export const ALREADY_KNOWN = 'Transaction already exists on chain';

// One extra host's answer to one /send: 'ok' (delivered) when it returns exactly this command's request
// key, or refuses the command as one it already has; 'err' (failed) for anything else, including a 200
// that is not a node's answer.
export function fanoutOutcome(status: number, body: string, requestKey: string): 'ok' | 'err' {
  if (status >= 200 && status < 300) {
    let keys: unknown;
    try { keys = JSON.parse(body)?.requestKeys; } catch { return 'err'; }
    return Array.isArray(keys) && keys.length === 1 && keys[0] === requestKey ? 'ok' : 'err';
  }
  return body.includes(ALREADY_KNOWN) ? 'ok' : 'err';
}

export const WAITING_MIN = 2, WAITING_MAX = 60, WAITING_JITTER = 0.2;

// BH_WAITING_INTERVAL: the seconds between a chain's waiting attests, or null (off) when unset or empty.
// Whole seconds only, WAITING_MIN to WAITING_MAX.
export function parseWaitingInterval(spec: string | undefined): number | null {
  if (spec === undefined || spec.trim() === '') return null;
  const t = spec.trim();
  if (!/^[0-9]+$/.test(t)) fail('interval-format', `BH_WAITING_INTERVAL must be a whole number of seconds, not ${JSON.stringify(spec)}`);
  const n = Number(t);
  if (n < WAITING_MIN || n > WAITING_MAX) fail('interval-range', `BH_WAITING_INTERVAL is ${n}; it must be ${WAITING_MIN} to ${WAITING_MAX} seconds`);
  return n;
}

// The delay before a chain's next waiting attest, in ms: the interval ±WAITING_JITTER for `rand` uniform
// in [0, 1), so the chains' timers drift apart instead of firing together.
export const jitterDelay = (seconds: number, rand: number) => Math.round(seconds * 1000 * (1 + WAITING_JITTER * (2 * rand - 1)));
