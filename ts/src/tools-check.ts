// tools-check.ts — offline checks for the pure helpers the tools depend on. Exit 1 on any failure.
// The binary-header vector is a real devnet block (chain 2, height 1) captured with its object
// encoding; the parser must reproduce every field the object form reports.
// The gas-key signer is checked against commands built by the SAME builder deploy.ts uses, with a
// throwaway in-memory key: it must sign the deploy's two commands and refuse every altered one, each
// for the reason it names.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { genKeyPair, hash as blakeHash } from '@kadena/cryptography-utils';
import {
  ROOT, parseChains, parseBinaryHeader, pactTime, microsOf,
  buildUnsignedGasOnly, keysetDeployCode, signGasSlot, verifySigned, type Emitted,
} from './lib.js';

let fails = 0;
const check = (name: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};
// The call must throw, and its message must start with `reason` — a refusal for any other reason fails.
const refuses = (name: string, f: () => unknown, reason: string) => {
  let msg = '(no refusal)';
  try { f(); } catch (e: any) { msg = String(e?.message ?? e); }
  check(name, msg.startsWith(reason) ? reason : msg, reason);
};

check('parseChains 0-19', parseChains('0-19').length, 20);
check('parseChains mixed', parseChains('0-2,19,5'), ['0', '1', '2', '5', '19']);
check('parseChains dedupe', parseChains('2,2,2'), ['2']);

const b64 = 'AAAAAAAAAAA7xmJ_dVoGALTGbbM2jMAxPGQZGet8G05ri90d9mx9aVR-gQsTvikwAwAAAAAAI44qr9WzXAwKaBL_cOdhLC9PKB0Jmo0dIuMXUz3Q4wsEAAAADgkcz1vTanUkii3ytBTjxospbVctGauWbFITQTf_7RUHAAAAvcCyL7Q3hrNMdIH3ugomHcKgzkzKIC9-53X_sSiGpm2gMv59xoUDIVnABG7dzVMdcjPcgM8PI4RHG0esxacAAFHqiDp2VwDJlQXmsC_A15-aSzDm8u5hneriMxSSS04kAgAAAKCGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAABAAAACH1lqeSNBQAAAAAAAAAAAKXdnyez3dm6uO173u8XSsY4jOjY6Aray1qLkN81237x';
check('parseBinaryHeader devnet c2 h1', parseBinaryHeader(b64), {
  height: 1, hash: 'pd2fJ7Pd2bq47Xve7xdKxjiM6NjoCtrLWouQ3zXbfvE', parent: 'tMZtszaMwDE8ZBkZ63wbTmuL3R32bH1pVH6BCxO-KTA',
  creationTime: 1788310555117115, chainId: 2,
});

check('pactTime micros', pactTime(1788310555117115), { timep: '2026-09-02T00:55:55.117115Z' });
check('microsOf round trip', microsOf(pactTime(1788310555117115).timep), 1788310555117115);
check('microsOf seconds-only', microsOf('2026-09-02T00:55:55Z'), 1788310555000000);
check('pactTime zero fraction pads', pactTime(1788310555000000), { timep: '2026-09-02T00:55:55.000000Z' });

// ---- the gas-key signer (send-signed --gas-key) --------------------------------------------------
const SRC = readFileSync(join(ROOT, 'pact', 'modules', 'block-history.pact'), 'utf8');
const kp = genKeyPair();   // throwaway, in memory only
const gasKey = { publicKey: kp.publicKey, secretKey: kp.secretKey! };
const NET = 'recap-development';
const KS = { keys: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)], pred: 'keys-2' };
const X = { networkId: NET, ns: 'free', source: SRC, keyset: KS, gasPrice: 1e-8 };
const common = { chainId: '0' as const, sender: `k:${kp.publicKey}`, signerPubKey: kp.publicKey, creationTime: 1788310555, gasPrice: 1e-8, networkId: NET };
const ksCmd = buildUnsignedGasOnly({ ...common, code: keysetDeployCode('free'), data: { ks: KS }, gasLimit: 2000 });
const modCmd = buildUnsignedGasOnly({ ...common, code: SRC, data: { ns: 'free' }, gasLimit: 120000 });
// Change ONE thing and re-hash, so the hash check passes and the guard under test is what refuses.
const edit = (t: Emitted, fn: (c: any) => void): Emitted => {
  const c = JSON.parse(t.cmd);
  fn(c);
  const cmd = JSON.stringify(c);
  return { cmd, hash: blakeHash(cmd), sigs: t.sigs };
};

check('gas signer: the builder scopes the one signature to coin.GAS alone', JSON.parse(ksCmd.cmd).signers, [{ pubKey: kp.publicKey, scheme: 'ED25519', clist: [{ name: 'coin.GAS', args: [] }] }]);
check('gas signer: signs the keyset definition, and the signature verifies', verifySigned(signGasSlot(ksCmd, gasKey, X), NET), null);
check('gas signer: signs the exact module source, and the signature verifies', verifySigned(signGasSlot(modCmd, gasKey, X), NET), null);
refuses('gas signer refuses a command with a duplicated field', () => { const cmd = ksCmd.cmd.replace('{"exec":{', '{"exec":{"code":"(coin.details \\"x\\")",'); return signGasSlot({ ...ksCmd, cmd, hash: blakeHash(cmd) }, gasKey, X); }, 'format:');
refuses('gas signer refuses a file whose hash does not match its command', () => signGasSlot({ ...ksCmd, cmd: ksCmd.cmd.replace('keys-2', 'keys-1') }, gasKey, X), 'hash:');
refuses('gas signer refuses a command for another network', () => signGasSlot(edit(ksCmd, (c) => { c.networkId = 'mainnet01'; }), gasKey, X), 'network:');
refuses('gas signer refuses a command paid by another account', () => signGasSlot(edit(ksCmd, (c) => { c.meta.sender = `k:${'f'.repeat(64)}`; }), gasKey, X), 'sender:');
refuses('gas signer refuses a second signer', () => signGasSlot(edit(ksCmd, (c) => { c.signers.push({ pubKey: 'e'.repeat(64), clist: [] }); }), gasKey, X), 'signers:');
refuses('gas signer refuses an unscoped signature', () => signGasSlot(edit(ksCmd, (c) => { c.signers[0].clist = []; }), gasKey, X), 'scope:');
refuses('gas signer refuses a TRANSFER capability', () => signGasSlot(edit(ksCmd, (c) => { c.signers[0].clist = [{ name: 'coin.TRANSFER', args: [c.meta.sender, 'k:x', { decimal: '1.0' }] }]; }), gasKey, X), 'scope:');
refuses('gas signer refuses a higher gas price', () => signGasSlot(edit(ksCmd, (c) => { c.meta.gasPrice = 0.001; }), gasKey, X), 'gas price:');
refuses('gas signer refuses a keyset command above its gas limit', () => signGasSlot(edit(ksCmd, (c) => { c.meta.gasLimit = 150000; }), gasKey, X), 'gas limit:');
refuses('gas signer refuses a module command above its gas limit', () => signGasSlot(edit(modCmd, (c) => { c.meta.gasLimit = 150000; }), gasKey, X), 'gas limit:');
refuses('gas signer refuses arbitrary code', () => signGasSlot(edit(ksCmd, (c) => { c.payload.exec.code = `(coin.transfer "${c.meta.sender}" "k:x" 1.0)`; }), gasKey, X), 'content:');
refuses('gas signer refuses a module source one character off', () => signGasSlot(edit(modCmd, (c) => { c.payload.exec.code = SRC + ' '; }), gasKey, X), 'content:');
refuses('gas signer refuses a different backfill keyset', () => signGasSlot(edit(ksCmd, (c) => { c.payload.exec.data.ks.keys[0] = 'a'.repeat(64); }), gasKey, X), 'content:');
refuses('gas signer refuses a keyset command with no keyset configured', () => signGasSlot(ksCmd, gasKey, { ...X, keyset: null }), 'content:');
refuses('gas signer refuses extra transaction data', () => signGasSlot(edit(modCmd, (c) => { c.payload.exec.data.extra = 1; }), gasKey, X), 'content:');
refuses('gas signer refuses another namespace', () => signGasSlot(edit(modCmd, (c) => { c.payload.exec.data.ns = 'user'; }), gasKey, X), 'content:');
refuses('gas signer refuses a key file whose public key is not its own', () => signGasSlot(ksCmd, { secretKey: gasKey.secretKey, publicKey: 'b'.repeat(64) }, X), 'key file:');
refuses('gas signer refuses a malformed secret', () => signGasSlot(ksCmd, { secretKey: 'not-hex' }, X), 'key file:');
check('already-signed path refuses an unsigned command', (verifySigned(ksCmd, NET) ?? '').startsWith('signatures:'), true);
check('already-signed path refuses a forged signature', (verifySigned({ ...signGasSlot(ksCmd, gasKey, X), sigs: [{ sig: '0'.repeat(128) }] }, NET) ?? '').startsWith('signatures:'), true);

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall tool checks passed');
process.exit(fails ? 1 : 0);
