// tools-check.ts — offline checks for the pure helpers the tools depend on. Exit 1 on any failure.
// The binary-header vector is a real devnet block (chain 2, height 1) captured with its object
// encoding; the parser must reproduce every field the object form reports.
// The gas-key signer is checked against commands built by the SAME builder deploy.ts uses, with a
// throwaway in-memory key: it must sign the deploy's two commands and refuse every altered one, each
// for the one reason code it names (every guard has its own code, so a refusal cannot drift to a
// neighbouring guard unnoticed). The checks made before anything is signed, the rules for commands
// signed elsewhere, and what a preflight sends in each mode are checked the same way.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { genKeyPair, hash as blakeHash } from '@kadena/cryptography-utils';
import {
  ROOT, parseChains, parseBinaryHeader, pactTime, microsOf,
  buildUnsignedGasOnly, keysetDeployCode, signGasSlot, validateKeyset, verifySigned, unsignedBody, commandKind,
  fileChain, statusDecision, relayKind, preflightRequest,
  type Emitted, type DeployExpect,
} from './lib.js';

let fails = 0;
const check = (name: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};
// The call must throw, and its message must start with `code:` — a refusal for any other reason fails.
const refuses = (name: string, f: () => unknown, code: string) => {
  let msg = '(no refusal)';
  try { f(); } catch (e: any) { msg = String(e?.message ?? e); }
  check(name, msg.startsWith(`${code}:`) ? code : msg, code);
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

// ---- the backfill keyset validator ---------------------------------------------------------------
const K = (c: string) => c.repeat(64);
check('keyset: three distinct keys with keys-2 are accepted', validateKeyset({ keys: [K('1'), K('2'), K('3')], pred: 'keys-2' }), { keys: [K('1'), K('2'), K('3')], pred: 'keys-2' });
refuses('keyset: no keys is refused (Pact would let anyone satisfy it)', () => validateKeyset({ keys: [], pred: 'keys-all' }), 'keyset-empty');
refuses('keyset: keys-2 over one key is refused (never satisfiable)', () => validateKeyset({ keys: [K('1')], pred: 'keys-2' }), 'keyset-threshold');
refuses('keyset: a key listed twice is refused', () => validateKeyset({ keys: [K('1'), K('1')], pred: 'keys-2' }), 'keyset-repeat');
refuses('keyset: an upper-case key is refused', () => validateKeyset({ keys: [K('A')], pred: 'keys-all' }), 'keyset-hex');
refuses('keyset: a nested key is refused', () => validateKeyset({ keys: [[K('1')], K('2')], pred: 'keys-2' }), 'keyset-hex');
refuses('keyset: a predicate Pact does not have is refused', () => validateKeyset({ keys: [K('1')], pred: 'keys-1' }), 'keyset-pred');
refuses('keyset: an extra field is refused', () => validateKeyset({ keys: [K('1')], pred: 'keys-all', note: 'x' }), 'keyset-field');
refuses('keyset: a non-object is refused', () => validateKeyset('keys-2'), 'keyset-shape');

// ---- the gas-key signer (send-signed --gas-key) --------------------------------------------------
const SRC = readFileSync(join(ROOT, 'pact', 'modules', 'block-history.pact'), 'utf8');
const kp = genKeyPair();   // throwaway, in memory only
const gasKey = { publicKey: kp.publicKey, secretKey: kp.secretKey! };
const NET = 'recap-development';
const T = 1788310555;       // the commands' creation time; the chain's time is a little later
const KS = { keys: [K('1'), K('2'), K('3')], pred: 'keys-2' };
const X: DeployExpect = { networkId: NET, ns: 'free', source: SRC, keyset: KS, gasPrice: 1e-8, now: T + 100 };
const common = { chainId: '0' as const, sender: `k:${kp.publicKey}`, signerPubKey: kp.publicKey, creationTime: T, gasPrice: 1e-8, networkId: NET };
const ksCmd = buildUnsignedGasOnly({ ...common, code: keysetDeployCode('free'), data: { ks: KS }, gasLimit: 2000 });
const modCmd = buildUnsignedGasOnly({ ...common, code: SRC, data: { ns: 'free' }, gasLimit: 120000 });
// Change ONE thing and re-hash, so the hash check passes and the guard under test is what refuses.
const edit = (t: Emitted, fn: (c: any) => void): Emitted => {
  const c = JSON.parse(t.cmd);
  fn(c);
  const cmd = JSON.stringify(c);
  return { cmd, hash: blakeHash(cmd), sigs: t.sigs };
};
const sign = (t: Emitted, x = X) => signGasSlot(t, gasKey, x);

check('gas signer: the builder scopes the one signature to coin.GAS alone', JSON.parse(ksCmd.cmd).signers, [{ pubKey: kp.publicKey, scheme: 'ED25519', clist: [{ name: 'coin.GAS', args: [] }] }]);
check('gas signer: signs the keyset definition; the signature verifies', verifySigned(sign(ksCmd).signed, NET), null);
check('gas signer: signs the exact module source; the signature verifies', verifySigned(sign(modCmd).signed, NET), null);
check('gas signer: reports kind, chain and the maximum fee', (({ kind, chainId, fee }) => ({ kind, chainId, fee: Math.round(fee * 1e8) }))(sign(modCmd)), { kind: 'module', chainId: '0', fee: 120000 });
check('gas signer: signs at the far edge of the 8-hour window', verifySigned(sign(ksCmd, { ...X, now: T + 28800 }).signed, NET), null);

refuses('refuses a command with a duplicated field', () => { const cmd = ksCmd.cmd.replace('{"exec":{', '{"exec":{"code":"(coin.details \\"x\\")",'); return sign({ ...ksCmd, cmd, hash: blakeHash(cmd) }); }, 'format-exact');
refuses('refuses a command that is not JSON', () => sign({ ...ksCmd, cmd: '{not json', hash: blakeHash('{not json') }), 'format-json');
refuses('refuses a file whose hash does not match its command', () => sign({ ...ksCmd, cmd: ksCmd.cmd.replace('keys-2', 'keys-1') }), 'hash');
refuses('refuses a command for another network', () => sign(edit(ksCmd, (c) => { c.networkId = 'mainnet01'; })), 'network');
refuses('refuses a command paid by another account', () => sign(edit(ksCmd, (c) => { c.meta.sender = `k:${K('f')}`; })), 'sender');
refuses('refuses a second signer', () => sign(edit(ksCmd, (c) => { c.signers.push({ pubKey: K('e'), clist: [] }); })), 'signers');
refuses('refuses a signer slot that is not an object', () => sign(edit(ksCmd, (c) => { c.signers = [null]; })), 'signers');
refuses('refuses an unscoped signature', () => sign(edit(ksCmd, (c) => { c.signers[0].clist = []; })), 'scope');
refuses('refuses a TRANSFER capability', () => sign(edit(ksCmd, (c) => { c.signers[0].clist = [{ name: 'coin.TRANSFER', args: [c.meta.sender, 'k:x', { decimal: '1.0' }] }]; })), 'scope');
refuses('refuses coin.GAS without its (empty) argument list', () => sign(edit(ksCmd, (c) => { delete c.signers[0].clist[0].args; })), 'scope');
refuses('refuses a higher gas price', () => sign(edit(ksCmd, (c) => { c.meta.gasPrice = 0.001; })), 'gas-price');
refuses('refuses a gas price written as a string', () => sign(edit(ksCmd, (c) => { c.meta.gasPrice = '1e-8'; })), 'gas-price');
refuses('refuses a configured gas price above the ceiling', () => sign(ksCmd, { ...X, gasPrice: 1e-5 }), 'gas-price-ceiling');
refuses('refuses a chain id outside 0-19', () => sign(edit(ksCmd, (c) => { c.meta.chainId = '20'; })), 'chain');
refuses('refuses a chain id that is not a number', () => sign(edit(ksCmd, (c) => { c.meta.chainId = '../x'; })), 'chain');
refuses('refuses a creation time written as a string', () => sign(edit(ksCmd, (c) => { c.meta.creationTime = String(c.meta.creationTime); })), 'creation-time');
refuses('refuses a command created more than 8 hours before the chain\'s time', () => sign(ksCmd, { ...X, now: T + 28801 }), 'creation-time-window');
refuses('refuses a command created in the chain\'s future', () => sign(ksCmd, { ...X, now: T - 61 }), 'creation-time-window');
refuses('refuses when the chain\'s time is unknown', () => sign(ksCmd, { ...X, now: NaN }), 'creation-time-window');
refuses('refuses a nonce that is not a string', () => sign(edit(ksCmd, (c) => { c.nonce = 7; })), 'nonce');
refuses('refuses a nonce other than the one the deploy tool derives', () => sign(edit(ksCmd, (c) => { c.nonce = 'another nonce'; })), 'exact');
refuses('refuses a keyset command above its gas limit', () => sign(edit(ksCmd, (c) => { c.meta.gasLimit = 150000; })), 'gas-limit');
refuses('refuses a module command above its gas limit', () => sign(edit(modCmd, (c) => { c.meta.gasLimit = 150000; })), 'gas-limit');
refuses('refuses a gas limit written as a string', () => sign(edit(ksCmd, (c) => { c.meta.gasLimit = '2000'; })), 'gas-limit');
refuses('refuses a negative gas limit', () => sign(edit(ksCmd, (c) => { c.meta.gasLimit = -1; })), 'gas-limit');
refuses('refuses arbitrary code', () => sign(edit(ksCmd, (c) => { c.payload.exec.code = `(coin.transfer "${c.meta.sender}" "k:x" 1.0)`; })), 'content-shape');
refuses('refuses a module source one character off', () => sign(edit(modCmd, (c) => { c.payload.exec.code = SRC + ' '; })), 'content-shape');
refuses('refuses a different backfill keyset', () => sign(edit(ksCmd, (c) => { c.payload.exec.data.ks.keys[0] = K('a'); })), 'content-keyset');
refuses('refuses a keyset command when no keyset is configured', () => sign(ksCmd, { ...X, keyset: null }), 'content-keyset-missing');
refuses('refuses a keyset command whose configured keyset is invalid (no keys)', () => { const empty = { keys: [] as string[], pred: 'keys-all' }; return sign(buildUnsignedGasOnly({ ...common, code: keysetDeployCode('free'), data: { ks: empty }, gasLimit: 2000 }), { ...X, keyset: empty }); }, 'content-keyset-invalid');
refuses('refuses a module command when no keyset is configured (it could only be sent where that keyset is ours)', () => sign(modCmd, { ...X, keyset: null }), 'content-keyset-missing');
refuses('refuses a module command whose configured keyset is invalid (no keys)', () => sign(modCmd, { ...X, keyset: { keys: [], pred: 'keys-all' } }), 'content-keyset-invalid');
refuses('refuses another namespace', () => sign(edit(modCmd, (c) => { c.payload.exec.data.ns = 'user'; })), 'content-module');
refuses('refuses extra transaction data', () => sign(edit(modCmd, (c) => { c.payload.exec.data.extra = 1; })), 'exact');
refuses('refuses a changed time-to-live', () => sign(edit(ksCmd, (c) => { c.meta.ttl = 1e9; })), 'exact');
refuses('refuses an extra top-level field', () => sign(edit(ksCmd, (c) => { c.verifiers = []; })), 'exact');
refuses('refuses a continuation riding beside the code', () => sign(edit(ksCmd, (c) => { c.payload.cont = { pactId: 'x', step: 1, rollback: false, data: {}, proof: null }; })), 'exact');
refuses('refuses a different signature scheme', () => sign(edit(ksCmd, (c) => { c.signers[0].scheme = 'WebAuthn'; })), 'exact');
refuses('refuses a key file whose public key is not its own', () => signGasSlot(ksCmd, { secretKey: gasKey.secretKey, publicKey: K('b') }, X), 'key-file-public');
refuses('refuses a malformed secret', () => signGasSlot(ksCmd, { secretKey: 'not-hex' }, X), 'key-file-secret');
check('already-signed path refuses an unsigned command', (verifySigned(ksCmd, NET) ?? '').startsWith('signatures:'), true);
check('already-signed path refuses a forged signature', (verifySigned({ ...sign(ksCmd).signed, sigs: [{ sig: '0'.repeat(128) }] }, NET) ?? '').startsWith('signatures:'), true);

// ---- what check-only mode sends, and how commands are classified ---------------------------------
const signedKs = sign(ksCmd).signed;
check('check-only body carries the signer slot and NO signature, even from a signed file', unsignedBody(signedKs).sigs, [{ pubKey: kp.publicKey }]);
check('check-only body keeps the command and its hash unchanged', [unsignedBody(signedKs).cmd === signedKs.cmd, unsignedBody(signedKs).hash === signedKs.hash], [true, true]);
check('check-only body from a command with no signer list is empty, not a crash', unsignedBody(edit(ksCmd, (c) => { delete c.signers; })).sigs, []);
check('classifies the keyset definition', commandKind(ksCmd.cmd, 'free', SRC), 'keyset');
check('classifies the module deploy', commandKind(modCmd.cmd, 'free', SRC), 'module');
check('classifies anything else as other', commandKind(edit(ksCmd, (c) => { c.payload.exec.code = '(free.block-history.close-backfill)'; }).cmd, 'free', SRC), 'other');
const checkOnly = preflightRequest(signedKs, false);
check('check-only preflight: the command unchanged, signer slots with a public key alone, signatures not verified', [checkOnly.body.cmd === signedKs.cmd, (checkOnly.body.sigs as any[]).map((s) => Object.keys(s ?? {})), checkOnly.signatureVerification], [true, [['pubKey']], false]);
check('send preflight: the signed command itself, signatures verified', preflightRequest(signedKs, true), { body: signedKs, signatureVerification: true });

// ---- before anything is signed: the file's own integrity, and what its status on chain decides ------
check('integrity: a file whose hash matches its command names its chain', fileChain(ksCmd), '0');
refuses('integrity: a file whose hash does not match its command', () => fileChain({ ...ksCmd, cmd: ksCmd.cmd.replace('keys-2', 'keys-1') }), 'hash');
refuses('integrity: a file with no command', () => fileChain({} as Emitted), 'hash');
refuses('integrity: a chain id outside 0-19', () => fileChain(edit(ksCmd, (c) => { c.meta.chainId = '20'; })), 'chain');
refuses('integrity: a chain id written as a number', () => fileChain(edit(ksCmd, (c) => { c.meta.chainId = 0; })), 'chain');
check('status: a command the chain has not seen goes on', statusDecision(undefined), 'go');
check('status: a command on chain that succeeded is skipped, however old', statusDecision({ result: { status: 'success', data: 'Write succeeded' } } as any), 'skip');
check('status: a command on chain that failed stops the run', statusDecision({ result: { status: 'failure', error: { message: 'x' } } } as any), 'fail');
check('status: a status that cannot be read is never a skip', statusDecision({} as any), 'fail');

// ---- commands signed elsewhere -------------------------------------------------------------------
const relayed = (t: Emitted, fn: (c: any) => void) => edit(t, fn).cmd;
check('relay: the keyset definition carrying the configured keyset', relayKind(ksCmd.cmd, X), 'keyset');
check('relay: the exact module command', relayKind(modCmd.cmd, X), 'module');
check('relay: a backfill batch needs no keyset configured', relayKind(relayed(ksCmd, (c) => { c.payload.exec.code = "(free.block-history.backfill (read-msg 'rows))"; c.payload.exec.data = { rows: [] }; }), { ...X, keyset: null }), 'other');
refuses('relay: a keyset definition carrying other keys', () => relayKind(relayed(ksCmd, (c) => { c.payload.exec.data.ks.keys[0] = K('a'); }), X), 'content-keyset');
refuses('relay: a keyset definition when no keyset is configured', () => relayKind(ksCmd.cmd, { ...X, keyset: null }), 'content-keyset-missing');
refuses('relay: a keyset definition whose configured keyset is invalid (no keys)', () => relayKind(ksCmd.cmd, { ...X, keyset: { keys: [], pred: 'keys-all' } }), 'content-keyset-invalid');
refuses('relay: a module command when no keyset is configured', () => relayKind(modCmd.cmd, { ...X, keyset: null }), 'content-keyset-missing');
refuses('relay: the module source into another namespace', () => relayKind(relayed(modCmd, (c) => { c.payload.exec.data.ns = 'user'; }), X), 'content-module');
refuses('relay: a module source one character off', () => relayKind(relayed(modCmd, (c) => { c.payload.exec.code = SRC + ' '; }), X), 'content-definition');
refuses('relay: an interface definition', () => relayKind(relayed(ksCmd, (c) => { c.payload.exec.code = '(interface i (defun f:bool ()))'; }), X), 'content-definition');
refuses('relay: a module definition with a comment after its opening parenthesis', () => relayKind(relayed(ksCmd, (c) => { c.payload.exec.code = '(namespace "free") ( ; note\n  module m G (defcap G () true))'; }), X), 'content-definition');
refuses('relay: the backfill keyset defined in another form', () => relayKind(relayed(ksCmd, (c) => { c.payload.exec.code = '(define-keyset "free.block-history-backfill" (read-keyset "ks"))'; }), X), 'content-definition');

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall tool checks passed');
process.exit(fails ? 1 : 0);
