// send-signed.ts — sign the gas payer's slot of the module commands `deploy --unsigned` wrote, check
// every one, and only with --send submit them: all preflighted first, then all submitted back to back,
// then each waited for.
//   npm run send-signed -- --gas-key <key.json> out/unsigned/<network-id>/*.json          check only
//   npm run send-signed -- --gas-key <key.json> --send out/unsigned/<network-id>/*.json   sign, check, submit
//   npm run send-signed -- [--send] <signed.json> …                                       commands already signed elsewhere
//
// The key file is JSON {publicKey, secretKey}, readable by its owner alone (required for --send). Its
// secret stays inside this process and is never printed. With --gas-key a file is signed only if it is,
// byte for byte, the deploy's module command (lib.ts: signGasSlot): the exact module source with
// {"ns": BH_NS}, at BH_GAS_PRICE and the deploy's gas limit, with one signature scoped to coin.GAS, and
// only while the chain it names would still accept it.
// Without --gas-key every signature a file carries must verify (lib.ts: verifySigned). Either way a module
// command must carry this checkout's exact source into BH_NS, and a command that defines any other module
// or interface, or uses define-keyset, is refused (lib.ts: relayKind). Every file must be exactly the JSON
// the tools write (lib.ts: fileChain).
// CHECK ONLY (no --send): nothing signed leaves this machine. Each command is preflighted on the node as
// a body rebuilt with no signature (lib.ts: preflightRequest), whatever the file carries.
// SEND: the maximum fee is printed first. Every command is preflighted, signed, before ANY is submitted, and
// one refusal stops the run with nothing sent. On a chain that already carries the module, that preflight
// refuses a module command: the module is immutable. Then all are submitted back to back, and only then
// waited for. Once the first module lands its code is public, and a copy of it landed first on a later
// chain makes that chain LOST (lib.ts: ownership), so the last submission follows the first within
// seconds, not the minutes a one-at-a-time send takes. Commands that depend on one another cannot share a
// run: each is preflighted before any lands. A command already on chain is skipped without being signed,
// once it is confirmed to be one this run would accept (lib.ts: spentKind), so re-running after a partial
// session is safe however long ago it was.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainId, ICommand } from '@kadena/client';
import {
  API, NETWORK_ID, NS, ROOT, GAS_PRICE, client, retrying, pollMined, errorText, chainTime,
  signGasSlot, verifySigned, fileChain, statusDecision, relayKind, spentKind, preflightRequest,
  type Emitted, type Signed,
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
const expect = { networkId: NETWORK_ID, ns: NS, source: SOURCE, gasPrice: GAS_PRICE };

console.log(`send-signed → ${API}  ${doSend ? 'SEND' : '(check only — nothing signed leaves this machine)'}`);
// Read every file and check its hash and chain, then ask that chain, once, whether the command is already
// there: one already on chain is skipped without being signed.
const loaded: { file: string; tx: Emitted; chainId: ChainId }[] = [];
for (const f of files) {
  let tx: Emitted | null = null;
  try { tx = JSON.parse(readFileSync(f, 'utf8')); } catch { die(`${f}: not a readable command file`); }
  try { loaded.push({ file: f, tx: tx!, chainId: fileChain(tx!) }); } catch (e: any) { die(`${f}: refused — ${e?.message ?? e}`); }
}
let skipped = 0;
const pending: typeof loaded = [];
for (const l of loaded) {
  const d = { requestKey: l.tx.hash, chainId: l.chainId, networkId: NETWORK_ID };
  const prior = (await retrying('status', () => client.getStatus(d)))[l.tx.hash];
  const step = statusDecision(prior);
  if (step === 'fail') die(`${l.file} is already on chain and FAILED there — ${errorText(prior)}`);
  if (step === 'skip') {
    let kind = '';
    try { kind = spentKind(l.tx.cmd, expect, gasKey !== null); } catch (e: any) { die(`${l.file} is already on chain, but this run would have refused it — ${e?.message ?? e}`); }
    console.log(`  · already on chain (${kind}), skipped: ${l.file}`); skipped++;
  }
  else pending.push(l);
}
// A command is signed only while its chain would still accept it, so each chain is asked for its own time.
const chainNow = new Map<string, number>();
if (gasKey) {
  for (const c of new Set(pending.map((l) => l.chainId))) {
    try { chainNow.set(c, Math.floor((await chainTime(c)).getTime() / 1000)); }
    catch { die(`could not read chain ${c}'s time from ${API}`); }
  }
}

type Item = { file: string; signed: Signed; chainId: ChainId; kind: 'module' | 'other'; fee: number };
const items: Item[] = [];
for (const l of pending) {
  if (gasKey) {
    try {
      const r = signGasSlot(l.tx, gasKey, { ...expect, now: chainNow.get(l.chainId) ?? NaN });
      items.push({ file: l.file, signed: r.signed, chainId: r.chainId, kind: 'module', fee: r.fee });
    } catch (e: any) { die(`${l.file}: refused — ${e?.message ?? e}`); }
  } else {
    const why = verifySigned(l.tx, NETWORK_ID);
    if (why) die(`${l.file}: not sendable — ${why}`);
    const c = JSON.parse(l.tx.cmd);
    try {
      items.push({ file: l.file, signed: l.tx as Signed, chainId: l.chainId, kind: relayKind(l.tx.cmd, expect), fee: Number(c.meta.gasLimit) * Number(c.meta.gasPrice) });
    } catch (e: any) { die(`${l.file}: refused — ${e?.message ?? e}`); }
  }
}
// Two module commands for one chain, or the same other command twice, means a stale file from an earlier
// run: sending both would mine the second as a failure and burn its whole gas limit.
const seen = new Map<string, string>();
for (const it of items) {
  const k = `${it.chainId}/${it.kind === 'other' ? it.signed.hash : it.kind}`;
  const prev = seen.get(k);
  if (prev) die(`${prev} and ${it.file} are both the ${it.kind === 'other' ? 'same' : it.kind} command for chain ${it.chainId} — delete the stale one`);
  seen.set(k, it.file);
}
const maxFee = items.reduce((s, i) => s + i.fee, 0);
console.log(`  ✓ ${items.length} command(s) ${gasKey ? 'signed and ' : ''}verified locally — maximum fee ${maxFee.toFixed(6)} KDA in total`);

async function preflight(it: Item): Promise<any> {
  const { body, signatureVerification } = preflightRequest(it.signed, doSend);
  const r = await retrying('preflight', () => client.local(body as unknown as ICommand, { preflight: true, signatureVerification }));
  if (r.result.status !== 'success') die(`${it.file}: the node's preflight refused it — ${errorText(r)}`);
  return r;
}

if (!doSend) {
  let ready = 0;
  for (const it of items) {
    const pre = await preflight(it);
    console.log(`  ✓ preflight, unsigned  chain ${it.chainId.padStart(2)}  gas ${pre.gas}  ${it.file}`);
    ready++;
  }
  console.log(`\n  CHECK ONLY: ${ready} ready, ${skipped} already on chain. Nothing signed was sent anywhere; re-run with --send to submit.`);
} else {
  // 1. Every command preflighted, signed, before any is submitted: one refusal stops the run with nothing sent.
  const preGas = new Map<Item, unknown>();
  for (const it of items) {
    const pre = await preflight(it);
    preGas.set(it, pre.gas);
    console.log(`  ✓ preflight, signed  chain ${it.chainId.padStart(2)}  gas ${pre.gas}  ${it.file}`);
  }
  // 2. All submitted back to back; none is waited for yet.
  let submitted = 0;
  const before = () => (submitted ? `\n${submitted} command(s) listed above as submitted went out before it and may still be mined: wait for them, then re-run this command (those on chain are skipped).` : '');
  for (const it of items) {
    let requestKey = '';
    try { requestKey = (await retrying('submit', () => client.submit(it.signed as unknown as ICommand))).requestKey; }
    catch (e: any) { die(`${it.file}: the submit failed — ${e?.message ?? e}${before()}`); }
    if (requestKey !== it.signed.hash) die(`${it.file}: the node returned request key ${requestKey}, not the command's hash ${it.signed.hash}${before()}`);
    console.log(`  → submitted  chain ${it.chainId.padStart(2)}  request key ${requestKey}`);
    submitted++;
  }
  // 3. Each waited for and reported. One that does not land does not stop the others being reported.
  let sent = 0;
  const failed: string[] = [];
  for (const it of items) {
    let r: any;
    try { r = await pollMined(it.signed.hash, it.chainId, it.file); }
    catch (e: any) { console.log(`  ✗ NOT MINED  chain ${it.chainId.padStart(2)}  ${e?.message ?? e}`); failed.push(it.chainId); continue; }
    if (r.result?.status !== 'success') { console.log(`  ✗ MINED BUT FAILED  chain ${it.chainId.padStart(2)}  ${it.file} — ${errorText(r)}`); failed.push(it.chainId); continue; }
    console.log(`  ✓ mined  chain ${it.chainId.padStart(2)}  height ${r.metaData?.blockHeight}  gas ${r.gas} (preflight ${preGas.get(it)})  request key ${it.signed.hash}`);
    sent++;
  }
  if (failed.length) die(`${failed.length} of ${items.length} submitted command(s) did not land (chain(s) ${failed.join(',')}); ${sent} mined, ${skipped} were already on chain. A module command that fails on its chain usually means another copy of the module landed there first: run npm run preflight, which reports a chain whose module is not ours as LOST.`);
  console.log(`\n  SENT ${sent}; ${skipped} were already on chain.`);
}
