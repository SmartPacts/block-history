// send-signed.ts — sign the gas payer's slot of the commands `deploy --unsigned` wrote, check every
// one, preflight every one on the node, and only with --send submit them, one at a time, in order.
//   npm run send-signed -- --gas-key <key.json> out/unsigned/*.json          check only — nothing is sent
//   npm run send-signed -- --gas-key <key.json> --send out/unsigned/*.json   sign, check, then submit
//   npm run send-signed -- [--send] <signed.json> …                           commands already signed elsewhere
//
// The key file is JSON {publicKey, secretKey}. Its secret stays inside this process and is never printed.
// With --gas-key the tool signs ONLY the deploy's own two commands — the backfill keyset definition
// carrying BH_BACKFILL_KEYSET, and the exact module source with {"ns": BH_NS} — at BH_GAS_PRICE, within
// the deploy's gas limits, with one signature scoped to coin.GAS. Anything else, including any file
// changed after it was written, is refused before a signature exists (lib.ts: signGasSlot).
// Every command is preflighted before the first one is sent, and a command already on chain is
// reported and skipped, so re-running after a partial session is safe.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainId, ICommand } from '@kadena/client';
import {
  API, NETWORK_ID, NS, ROOT, GAS_PRICE, client, retrying, pollMined, errorText,
  signGasSlot, verifySigned, type Emitted, type Signed,
} from './lib.js';

function die(msg: string): never {
  console.error(`\nSTOPPED: ${msg}\nNothing further was sent.`);
  process.exit(1);
}

const USAGE = 'usage: npm run send-signed -- [--gas-key <key.json>] [--send] <command.json> …';
let gasKeyPath = '';
let doSend = false;
const files: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--gas-key') gasKeyPath = args[++i] ?? '';
  else if (a === '--send') doSend = true;
  else if (a.startsWith('--')) die(`unknown flag ${a}\n${USAGE}`);
  else files.push(a);
}
// A 64-hex argument is a secret that lost its way, never a file name: refuse it by its shape, before
// any error message could echo it back.
if ([gasKeyPath, ...files].some((f) => /^[0-9a-fA-F]{64}$/.test(f))) die('an argument is 64 hex characters — that looks like a secret, not a file path');
if (args.includes('--gas-key') && !gasKeyPath) die(`--gas-key needs a file path\n${USAGE}`);
if (!files.length) die(USAGE);

let gasKey: { secretKey: string; publicKey?: string } | null = null;
if (gasKeyPath) {
  let raw = '';
  try { raw = readFileSync(gasKeyPath, 'utf8'); } catch { die(`cannot read the gas key file ${gasKeyPath}`); }
  try { const j = JSON.parse(raw); gasKey = { secretKey: j.secretKey, publicKey: j.publicKey }; }
  catch { die(`${gasKeyPath} is not a JSON key file {publicKey, secretKey}`); }
  if ((statSync(gasKeyPath).mode & 0o077) !== 0) console.log(`  note: ${gasKeyPath} is readable by other users — chmod 600 is recommended`);
}

const SOURCE = readFileSync(join(ROOT, 'pact', 'modules', 'block-history.pact'), 'utf8');
let keyset: { keys: string[]; pred: string } | null = null;
if (process.env.BH_BACKFILL_KEYSET) {
  try { keyset = JSON.parse(process.env.BH_BACKFILL_KEYSET); } catch { die('BH_BACKFILL_KEYSET is not JSON'); }
}
const expect = { networkId: NETWORK_ID, ns: NS, source: SOURCE, keyset, gasPrice: GAS_PRICE };

console.log(`send-signed → ${API}  ${doSend ? 'SEND' : '(check only — nothing is sent without --send)'}`);
type Item = { file: string; signed: Signed; chainId: ChainId };
const items: Item[] = [];
for (const f of files) {
  let tx: Emitted | null = null;
  try { tx = JSON.parse(readFileSync(f, 'utf8')); } catch { die(`${f}: not a readable command file`); }
  let signed: Signed;
  if (gasKey) {
    try { signed = signGasSlot(tx!, gasKey, expect); } catch (e: any) { die(`${f}: refused — ${e?.message ?? e}`); }
  } else {
    const why = verifySigned(tx!, NETWORK_ID);
    if (why) die(`${f}: not sendable — ${why}`);
    signed = tx as Signed;
  }
  items.push({ file: f, signed, chainId: String(JSON.parse(tx!.cmd).meta.chainId) as ChainId });
}
console.log(`  ✓ ${items.length} command(s) ${gasKey ? 'signed and ' : ''}verified locally`);

const toSend: Item[] = [];
for (const it of items) {
  const d = { requestKey: it.signed.hash, chainId: it.chainId, networkId: NETWORK_ID };
  const prior: any = ((await retrying('status', () => client.getStatus(d))) as any)[it.signed.hash];
  if (prior) {
    if (prior.result?.status !== 'success') die(`${it.file} is already on chain and FAILED there — ${errorText(prior)}`);
    console.log(`  · already on chain, skipped: ${it.file}`);
    continue;
  }
  const pre = await retrying('preflight', () => client.local(it.signed as unknown as ICommand, { preflight: true, signatureVerification: true }));
  if (pre.result.status !== 'success') die(`${it.file}: the node's preflight refused it — ${errorText(pre)}`);
  console.log(`  ✓ preflight  chain ${it.chainId.padStart(2)}  gas ${(pre as any).gas}  ${it.file}`);
  toSend.push(it);
}
if (!doSend) {
  console.log(`\n  CHECK ONLY: ${toSend.length} ready, ${items.length - toSend.length} already on chain. Nothing was sent; re-run with --send to submit.`);
  process.exit(0);
}
for (const it of toSend) {
  const desc = await retrying('submit', () => client.submit(it.signed as unknown as ICommand));
  if (desc.requestKey !== it.signed.hash) die(`${it.file}: the node returned request key ${desc.requestKey}, not the command's hash ${it.signed.hash}`);
  const r = await pollMined(desc.requestKey, it.chainId, it.file);
  if (r.result.status !== 'success') die(`${it.file}: MINED BUT FAILED — ${errorText(r)}`);
  console.log(`  ✓ mined  chain ${it.chainId.padStart(2)}  height ${(r as any).metaData?.blockHeight}  gas ${(r as any).gas}  request key ${desc.requestKey}`);
}
console.log(`\n  SENT ${toSend.length}; ${items.length - toSend.length} were already on chain.`);
