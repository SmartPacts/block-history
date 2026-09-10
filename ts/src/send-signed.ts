// send-signed.ts — sign the gas payer's slot of the commands `deploy --unsigned` wrote, check every
// one, and only with --send submit them, one at a time.
//   npm run send-signed -- --gas-key <key.json> out/unsigned/*.json          check only
//   npm run send-signed -- --gas-key <key.json> --send out/unsigned/*.json   sign, check, submit
//   npm run send-signed -- [--send] <signed.json> …                           commands already signed elsewhere
//
// The key file is JSON {publicKey, secretKey}, readable by its owner alone (required for --send). Its
// secret stays inside this process and is never printed. With --gas-key a file is signed only if it is,
// byte for byte, one of the deploy's own two commands (lib.ts: signGasSlot): the backfill keyset
// definition carrying BH_BACKFILL_KEYSET, or the exact module source with {"ns": BH_NS}. It must also be
// at BH_GAS_PRICE and within the deploy's gas limits, with one signature scoped to coin.GAS, and only
// while the chain it names would still accept it.
// CHECK ONLY (no --send): nothing signed leaves this machine. Each command is preflighted on the node as
// a body rebuilt with no signature (lib.ts: unsignedBody), whatever the file carries.
// SEND: the maximum fee is printed first. A module command, signed here or elsewhere, is sent only on a
// chain whose backfill keyset is already ours. Each command is preflighted, signed, immediately before
// it is submitted. A command already on chain is skipped, so re-running after a partial session is safe.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainId, ICommand } from '@kadena/client';
import {
  API, NETWORK_ID, NS, ROOT, GAS_PRICE, BACKFILL_KEYSET, client, retrying, pollMined, errorText, local, chainTime,
  sameKeyset, signGasSlot, validateKeyset, verifySigned, unsignedBody, commandKind, type Emitted, type Keyset, type Signed,
} from './lib.js';

function die(msg: string): never {
  console.error(`\nSTOPPED: ${msg}\nNothing further was sent.`);
  process.exit(1);
}

const args = process.argv.slice(2);
// Before any argument is read: one containing 64 hex characters in a row looks like a secret key. It is
// refused and not repeated here, but npm prints and logs a script's arguments before the script starts,
// so a secret typed on the command line has to be treated as exposed.
if (args.some((a) => /[0-9a-fA-F]{64}/.test(a))) {
  die('an argument contains 64 hex characters in a row, which looks like a secret key, so it was not used. If it WAS a secret, treat it as exposed (npm may already have printed and logged it): move its funds and replace it. Pass the key FILE with --gas-key; a file whose name contains 64 hex characters must be renamed.');
}
const USAGE = 'usage: npm run send-signed -- [--gas-key <key.json>] [--send] <command.json> …';
let gasKeyPath = '';
let doSend = false;
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--gas-key') gasKeyPath = args[++i] ?? '';
  else if (a === '--send') doSend = true;
  else if (a.startsWith('--')) die(`unknown flag\n${USAGE}`);
  else files.push(a);
}
if (args.includes('--gas-key') && (!gasKeyPath || gasKeyPath.startsWith('--'))) die(`--gas-key needs a file path\n${USAGE}`);
if (!files.length) die(USAGE);

let gasKey: { secretKey: string; publicKey?: string } | null = null;
if (gasKeyPath) {
  let raw = '';
  try { raw = readFileSync(gasKeyPath, 'utf8'); } catch { die(`cannot read the gas key file ${gasKeyPath}`); }
  try { const j = JSON.parse(raw); gasKey = { secretKey: j.secretKey, publicKey: j.publicKey }; }
  catch { die(`${gasKeyPath} is not a JSON key file {publicKey, secretKey}`); }
  const mode = statSync(gasKeyPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    if (doSend) die(`${gasKeyPath} is accessible to other users (mode ${mode.toString(8)}) — run chmod 600 on it first`);
    console.log(`  note: ${gasKeyPath} is accessible to other users (mode ${mode.toString(8)}); chmod 600 it before --send`);
  }
}

const SOURCE = readFileSync(join(ROOT, 'pact', 'modules', 'block-history.pact'), 'utf8');
let keyset: Keyset | null = null;
if (process.env.BH_BACKFILL_KEYSET) {
  try { keyset = validateKeyset(JSON.parse(process.env.BH_BACKFILL_KEYSET)); } catch (e: any) { die(`BH_BACKFILL_KEYSET: ${e?.message ?? e}`); }
}
const expect = { networkId: NETWORK_ID, ns: NS, source: SOURCE, keyset, gasPrice: GAS_PRICE };

console.log(`send-signed → ${API}  ${doSend ? 'SEND' : '(check only — nothing signed leaves this machine)'}`);
// Read every file first, then ask each chain it names for that chain's own time: a command is signed
// only while its chain would still accept it.
const loaded: { file: string; tx: Emitted; chainId: string }[] = [];
for (const f of files) {
  let tx: Emitted | null = null;
  try { tx = JSON.parse(readFileSync(f, 'utf8')); } catch { die(`${f}: not a readable command file`); }
  let chainId = '';
  try { chainId = String(JSON.parse(tx!.cmd).meta.chainId); } catch { /* signGasSlot and verifySigned refuse it by name */ }
  loaded.push({ file: f, tx: tx!, chainId });
}
const chainNow = new Map<string, number>();
if (gasKey) {
  for (const c of new Set(loaded.map((l) => l.chainId).filter((c) => /^1?[0-9]$/.test(c)))) {
    try { chainNow.set(c, Math.floor((await chainTime(c as ChainId)).getTime() / 1000)); }
    catch { die(`could not read chain ${c}'s time from ${API}`); }
  }
}

type Item = { file: string; signed: Signed; chainId: ChainId; kind: 'keyset' | 'module' | 'other'; fee: number };
const items: Item[] = [];
for (const l of loaded) {
  if (gasKey) {
    try {
      const r = signGasSlot(l.tx, gasKey, { ...expect, now: chainNow.get(l.chainId) ?? NaN });
      items.push({ file: l.file, signed: r.signed, chainId: r.chainId, kind: r.kind, fee: r.fee });
    } catch (e: any) { die(`${l.file}: refused — ${e?.message ?? e}`); }
  } else {
    const why = verifySigned(l.tx, NETWORK_ID);
    if (why) die(`${l.file}: not sendable — ${why}`);
    const c = JSON.parse(l.tx.cmd);
    items.push({ file: l.file, signed: l.tx as Signed, chainId: String(c.meta.chainId) as ChainId, kind: commandKind(l.tx.cmd, NS, SOURCE), fee: Number(c.meta.gasLimit) * Number(c.meta.gasPrice) });
  }
}
// Two commands of the same kind for one chain means a stale file from an earlier run: sending both
// would mine the second as a failure and burn its whole gas limit.
const seen = new Map<string, string>();
for (const it of items) {
  const k = `${it.chainId}/${it.kind === 'other' ? it.signed.hash : it.kind}`;
  const prev = seen.get(k);
  if (prev) die(`${prev} and ${it.file} are both the ${it.kind === 'other' ? 'same' : it.kind} command for chain ${it.chainId} — delete the stale one`);
  seen.set(k, it.file);
}
const maxFee = items.reduce((s, i) => s + i.fee, 0);
console.log(`  ✓ ${items.length} command(s) ${gasKey ? 'signed and ' : ''}verified locally — maximum fee ${maxFee.toFixed(6)} KDA in total`);

async function onChain(it: Item): Promise<any> {
  const d = { requestKey: it.signed.hash, chainId: it.chainId, networkId: NETWORK_ID };
  return ((await retrying('status', () => client.getStatus(d))) as any)[it.signed.hash];
}
async function keysetIsOurs(chainId: ChainId): Promise<boolean> {
  if (!keyset) return false;
  const ks = await local(`(describe-keyset ${JSON.stringify(BACKFILL_KEYSET)})`, { chainId }).catch(() => null);
  return sameKeyset(ks, keyset);
}
async function preflight(it: Item, body: Emitted | Signed, verify: boolean): Promise<any> {
  const r = await retrying('preflight', () => client.local(body as unknown as ICommand, { preflight: true, signatureVerification: verify }));
  if (r.result.status !== 'success') die(`${it.file}: the node's preflight refused it — ${errorText(r)}`);
  return r;
}

let ready = 0, skipped = 0, sent = 0;
for (const it of items) {
  const prior = await onChain(it);
  if (prior) {
    if (prior.result?.status !== 'success') die(`${it.file} is already on chain and FAILED there — ${errorText(prior)}`);
    console.log(`  · already on chain, skipped: ${it.file}`);
    skipped++;
    continue;
  }
  if (it.kind === 'module' && !(await keysetIsOurs(it.chainId))) {
    die(`${it.file}: the backfill keyset on chain ${it.chainId} is not ours yet — send its keyset command first, then confirm with npm run preflight`);
  }
  if (!doSend) {
    const pre = await preflight(it, unsignedBody(it.signed), false);
    console.log(`  ✓ preflight, unsigned  chain ${it.chainId.padStart(2)}  gas ${pre.gas}  ${it.file}`);
    ready++;
    continue;
  }
  const pre = await preflight(it, it.signed, true);
  const desc = await retrying('submit', () => client.submit(it.signed as unknown as ICommand));
  if (desc.requestKey !== it.signed.hash) die(`${it.file}: the node returned request key ${desc.requestKey}, not the command's hash ${it.signed.hash}`);
  const r = await pollMined(desc.requestKey, it.chainId, it.file);
  if (r.result.status !== 'success') die(`${it.file}: MINED BUT FAILED — ${errorText(r)}`);
  console.log(`  ✓ mined  chain ${it.chainId.padStart(2)}  height ${(r as any).metaData?.blockHeight}  gas ${(r as any).gas} (preflight ${pre.gas})  request key ${desc.requestKey}`);
  sent++;
}
if (!doSend) console.log(`\n  CHECK ONLY: ${ready} ready, ${skipped} already on chain. Nothing signed was sent anywhere; re-run with --send to submit.`);
else console.log(`\n  SENT ${sent}; ${skipped} were already on chain.`);
