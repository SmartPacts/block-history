// tools-check.ts — offline checks for the pure helpers the tools depend on. Exit 1 on any failure.
// The binary-header vector is a real devnet block (chain 2, height 1) captured with its object
// encoding; the parser must reproduce every field the object form reports.
// The gas-key signer is checked against a command built by the SAME builder deploy.ts uses, with a
// throwaway in-memory key: it must sign the deploy's module command and refuse every altered one, each
// for the one reason code it names (every guard has its own code, so a refusal cannot drift to a
// neighbouring guard unnoticed). The checks made before anything is signed, the rules for commands
// signed elsewhere and for commands already on chain, and what a preflight sends in each mode are
// checked the same way.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { genKeyPair, hash as blakeHash } from '@kadena/cryptography-utils';
import {
  ROOT, parseChains, parseBinaryHeader, pactTime, microsOf,
  buildUnsignedGasOnly, signGasSlot, verifySigned, unsignedBody, commandKind,
  fileChain, statusDecision, relayKind, spentKind, preflightRequest, errorText,
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
// What a call returns, or what it threw: a refusal where acceptance was expected is then one named FAIL,
// not a crash that hides every later check.
const outcome = (f: () => unknown) => { try { return f(); } catch (e: any) { return `threw ${String(e?.message ?? e)}`; } };

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
const K = (c: string) => c.repeat(64);
const SRC = readFileSync(join(ROOT, 'pact', 'modules', 'block-history.pact'), 'utf8');
const kp = genKeyPair();   // throwaway, in memory only
const gasKey = { publicKey: kp.publicKey, secretKey: kp.secretKey! };
const NET = 'recap-development';
const T = 1788310555;       // the command's creation time; the chain's time is a little later
const X: DeployExpect = { networkId: NET, ns: 'free', source: SRC, gasPrice: 1e-8, now: T + 100 };
const modCmd = buildUnsignedGasOnly({
  chainId: '0', sender: `k:${kp.publicKey}`, signerPubKey: kp.publicKey, creationTime: T, gasPrice: 1e-8, networkId: NET,
  code: SRC, data: { ns: 'free' }, gasLimit: 120000,
});
// Change ONE thing and re-hash, so the hash check passes and the guard under test is what refuses.
const edit = (t: Emitted, fn: (c: any) => void): Emitted => {
  const c = JSON.parse(t.cmd);
  fn(c);
  const cmd = JSON.stringify(c);
  return { cmd, hash: blakeHash(cmd), sigs: t.sigs };
};
const sign = (t: Emitted, x = X) => signGasSlot(t, gasKey, x);
// The command with its namespace changed and its hash NOT recomputed.
const stale: Emitted = { ...modCmd, cmd: modCmd.cmd.replace('"ns":"free"', '"ns":"user"') };
check('fixture: the stale copy differs from the command its hash belongs to', stale.cmd !== modCmd.cmd, true);

check('gas signer: the builder scopes the one signature to coin.GAS alone', JSON.parse(modCmd.cmd).signers, [{ pubKey: kp.publicKey, scheme: 'ED25519', clist: [{ name: 'coin.GAS', args: [] }] }]);
check('gas signer: signs the exact module source; the signature verifies', verifySigned(sign(modCmd).signed, NET), null);
check('gas signer: reports the chain and the maximum fee', (({ chainId, fee }) => ({ chainId, fee: Math.round(fee * 1e8) }))(sign(modCmd)), { chainId: '0', fee: 120000 });
check('gas signer: signs at the far edge of the 8-hour window', verifySigned(sign(modCmd, { ...X, now: T + 28800 }).signed, NET), null);

refuses('refuses a command with a duplicated field', () => { const cmd = modCmd.cmd.replace('{"exec":{', '{"exec":{"code":"(coin.details \\"x\\")",'); return sign({ ...modCmd, cmd, hash: blakeHash(cmd) }); }, 'format-exact');
refuses('refuses a command that is not JSON', () => sign({ ...modCmd, cmd: '{not json', hash: blakeHash('{not json') }), 'format-json');
refuses('refuses a file whose hash does not match its command', () => sign(stale), 'hash');
refuses('refuses a command for another network', () => sign(edit(modCmd, (c) => { c.networkId = 'mainnet01'; })), 'network');
refuses('refuses a command paid by another account', () => sign(edit(modCmd, (c) => { c.meta.sender = `k:${K('f')}`; })), 'sender');
refuses('refuses a second signer', () => sign(edit(modCmd, (c) => { c.signers.push({ pubKey: K('e'), clist: [] }); })), 'signers');
refuses('refuses a signer slot that is not an object', () => sign(edit(modCmd, (c) => { c.signers = [null]; })), 'signers');
refuses('refuses an unscoped signature', () => sign(edit(modCmd, (c) => { c.signers[0].clist = []; })), 'scope');
refuses('refuses a TRANSFER capability', () => sign(edit(modCmd, (c) => { c.signers[0].clist = [{ name: 'coin.TRANSFER', args: [c.meta.sender, 'k:x', { decimal: '1.0' }] }]; })), 'scope');
refuses('refuses coin.GAS without its (empty) argument list', () => sign(edit(modCmd, (c) => { delete c.signers[0].clist[0].args; })), 'scope');
refuses('refuses a higher gas price', () => sign(edit(modCmd, (c) => { c.meta.gasPrice = 0.001; })), 'gas-price');
refuses('refuses a gas price written as a string', () => sign(edit(modCmd, (c) => { c.meta.gasPrice = '1e-8'; })), 'gas-price');
refuses('refuses a configured gas price above the ceiling', () => sign(modCmd, { ...X, gasPrice: 1e-5 }), 'gas-price-ceiling');
refuses('refuses a chain id outside 0-19', () => sign(edit(modCmd, (c) => { c.meta.chainId = '20'; })), 'chain');
refuses('refuses a chain id that is not a number', () => sign(edit(modCmd, (c) => { c.meta.chainId = '../x'; })), 'chain');
refuses('refuses a creation time written as a string', () => sign(edit(modCmd, (c) => { c.meta.creationTime = String(c.meta.creationTime); })), 'creation-time');
refuses('refuses a command created more than 8 hours before the chain\'s time', () => sign(modCmd, { ...X, now: T + 28801 }), 'creation-time-window');
refuses('refuses a command created in the chain\'s future', () => sign(modCmd, { ...X, now: T - 61 }), 'creation-time-window');
refuses('refuses when the chain\'s time is unknown', () => sign(modCmd, { ...X, now: NaN }), 'creation-time-window');
refuses('refuses a nonce that is not a string', () => sign(edit(modCmd, (c) => { c.nonce = 7; })), 'nonce');
refuses('refuses a nonce other than the one the deploy tool derives', () => sign(edit(modCmd, (c) => { c.nonce = 'another nonce'; })), 'exact');
refuses('refuses a command above its gas limit', () => sign(edit(modCmd, (c) => { c.meta.gasLimit = 150000; })), 'gas-limit');
refuses('refuses a gas limit written as a string', () => sign(edit(modCmd, (c) => { c.meta.gasLimit = '120000'; })), 'gas-limit');
refuses('refuses a negative gas limit', () => sign(edit(modCmd, (c) => { c.meta.gasLimit = -1; })), 'gas-limit');
refuses('refuses arbitrary code', () => sign(edit(modCmd, (c) => { c.payload.exec.code = `(coin.transfer "${c.meta.sender}" "k:x" 1.0)`; })), 'content-shape');
refuses('refuses a module source one character off', () => sign(edit(modCmd, (c) => { c.payload.exec.code = SRC + ' '; })), 'content-shape');
refuses('refuses another namespace', () => sign(edit(modCmd, (c) => { c.payload.exec.data.ns = 'user'; })), 'content-module');
refuses('refuses extra transaction data', () => sign(edit(modCmd, (c) => { c.payload.exec.data.extra = 1; })), 'exact');
refuses('refuses a changed time-to-live', () => sign(edit(modCmd, (c) => { c.meta.ttl = 1e9; })), 'exact');
refuses('refuses an extra top-level field', () => sign(edit(modCmd, (c) => { c.verifiers = []; })), 'exact');
refuses('refuses a continuation riding beside the code', () => sign(edit(modCmd, (c) => { c.payload.cont = { pactId: 'x', step: 1, rollback: false, data: {}, proof: null }; })), 'exact');
refuses('refuses a different signature scheme', () => sign(edit(modCmd, (c) => { c.signers[0].scheme = 'WebAuthn'; })), 'exact');
refuses('refuses a key file whose public key is not its own', () => signGasSlot(modCmd, { secretKey: gasKey.secretKey, publicKey: K('b') }, X), 'key-file-public');
refuses('refuses a malformed secret', () => signGasSlot(modCmd, { secretKey: 'not-hex' }, X), 'key-file-secret');
check('already-signed path refuses an unsigned command', (verifySigned(modCmd, NET) ?? '').startsWith('signatures:'), true);
check('already-signed path refuses a forged signature', (verifySigned({ ...sign(modCmd).signed, sigs: [{ sig: '0'.repeat(128) }] }, NET) ?? '').startsWith('signatures:'), true);

// ---- what check-only mode sends, and how commands are classified ---------------------------------
const signedMod = sign(modCmd).signed;
check('check-only body carries the signer slot and NO signature, even from a signed file', unsignedBody(signedMod).sigs, [{ pubKey: kp.publicKey }]);
check('check-only body keeps the command and its hash unchanged', [unsignedBody(signedMod).cmd === signedMod.cmd, unsignedBody(signedMod).hash === signedMod.hash], [true, true]);
check('check-only body from a command with no signer list is empty, not a crash', unsignedBody(edit(modCmd, (c) => { delete c.signers; })).sigs, []);
check('classifies the module deploy', commandKind(modCmd.cmd, SRC), 'module');
check('classifies anything else as other', commandKind(edit(modCmd, (c) => { c.payload.exec.code = '(free.block-history.attest)'; }).cmd, SRC), 'other');
const checkOnly = preflightRequest(signedMod, false);
check('check-only preflight: the command unchanged, signer slots with a public key alone, signatures not verified', [checkOnly.body.cmd === signedMod.cmd, (checkOnly.body.sigs as any[]).map((s) => Object.keys(s ?? {})), checkOnly.signatureVerification], [true, [['pubKey']], false]);
check('send preflight: the signed command itself, signatures verified', preflightRequest(signedMod, true), { body: signedMod, signatureVerification: true });

// ---- before anything is signed: the file's own integrity, and what its status on chain decides ------
check('integrity: a file whose hash matches its command names its chain', fileChain(modCmd), '0');
refuses('integrity: a file whose hash does not match its command', () => fileChain(stale), 'hash');
refuses('integrity: a file with no command', () => fileChain({} as Emitted), 'hash');
refuses('integrity: a chain id outside 0-19', () => fileChain(edit(modCmd, (c) => { c.meta.chainId = '20'; })), 'chain');
refuses('integrity: a chain id written as a number', () => fileChain(edit(modCmd, (c) => { c.meta.chainId = 0; })), 'chain');
check('status: a command the chain has not seen goes on', statusDecision(undefined), 'go');
check('status: a command on chain that succeeded is skipped, however old', statusDecision({ result: { status: 'success', data: 'Write succeeded' } } as any), 'skip');
check('status: a command on chain that failed stops the run', statusDecision({ result: { status: 'failure', error: { message: 'x' } } } as any), 'fail');
check('status: a status that cannot be read is never a skip', statusDecision({} as any), 'fail');
check('status: a status that cannot be read is reported, not a crash', errorText({} as any).startsWith('no readable result'), true);
refuses('integrity: a command that is not JSON', () => fileChain({ cmd: 'not json', hash: blakeHash('not json') }), 'format-json');
const dup = modCmd.cmd.replace('"data":{"ns":', '"data":{"ns":"user","ns":');
check('integrity fixture: the command carries the key "ns" twice', dup.split('"ns":').length - 1, 2);
refuses('integrity: a command with a repeated key (this tool and the node could read different commands)', () => fileChain({ cmd: dup, hash: blakeHash(dup) }), 'format-exact');

// ---- commands signed elsewhere -------------------------------------------------------------------
const relayed = (t: Emitted, fn: (c: any) => void) => edit(t, fn).cmd;
const call = relayed(modCmd, (c) => { c.payload.exec.code = '(free.block-history.attest)'; c.payload.exec.data = {}; });
const keysetDefinition = relayed(modCmd, (c) => { c.payload.exec.code = '(namespace "free") (define-keyset "free.any-name" (read-keyset "ks"))'; });
const otherNs = relayed(modCmd, (c) => { c.payload.exec.data.ns = 'user'; });
// A second "code" key in front of the real one. This parser keeps the last and reads the exact module
// command; a parser that keeps the first reads a keyset definition.
const hidden = modCmd.cmd.replace('{"exec":{', '{"exec":{"code":"(namespace \\"free\\") (define-keyset \\"free.any-name\\" (read-keyset \\"ks\\"))",');
check('relay fixture: the key "code" appears twice, and this parser reads the module source', [hidden.split('"code":').length - 1, JSON.parse(hidden).payload.exec.code === SRC], [2, true]);
check('relay: the exact module command', outcome(() => relayKind(modCmd.cmd, X)), 'module');
check('relay: an ordinary call', outcome(() => relayKind(call, X)), 'other');
refuses('relay: the module source into another namespace', () => relayKind(otherNs, X), 'content-module');
refuses('relay: a module source one character off', () => relayKind(relayed(modCmd, (c) => { c.payload.exec.code = SRC + ' '; }), X), 'content-definition');
refuses('relay: an interface definition', () => relayKind(relayed(modCmd, (c) => { c.payload.exec.code = '(interface i (defun f:bool ()))'; }), X), 'content-definition');
refuses('relay: a module definition with a comment after its opening parenthesis', () => relayKind(relayed(modCmd, (c) => { c.payload.exec.code = '(namespace "free") ( ; note\n  module m G (defcap G () true))'; }), X), 'content-definition');
refuses('relay: a keyset definition', () => relayKind(keysetDefinition, X), 'content-definition');
refuses('relay: define-keyset passed to fold instead of called', () => relayKind(relayed(modCmd, (c) => { c.payload.exec.code = '(namespace "free") (fold define-keyset "free.any-name" [(read-keyset "ks")])'; }), X), 'content-definition');
refuses('relay: a command that is not JSON, refused by relayKind itself', () => relayKind('{not json', X), 'format-json');
refuses('relay: a repeated key hiding a keyset definition, refused by relayKind itself', () => relayKind(hidden, X), 'format-exact');

// ---- commands already on chain: what a spent file must be to be skipped ---------------------------
check('spent, --gas-key: the module command is skipped', outcome(() => spentKind(modCmd.cmd, X, true)), 'module');
refuses('spent, --gas-key: an ordinary call stops the run (that mode signs only the module command)', () => spentKind(call, X, true), 'spent-other');
refuses('spent, --gas-key: the module source into another namespace stops the run', () => spentKind(otherNs, X, true), 'content-module');
refuses('spent, --gas-key: a keyset definition stops the run', () => spentKind(keysetDefinition, X, true), 'content-definition');
check('spent, signed elsewhere: the module command is skipped', outcome(() => spentKind(modCmd.cmd, X, false)), 'module');
check('spent, signed elsewhere: an ordinary call is skipped', outcome(() => spentKind(call, X, false)), 'other');
refuses('spent, signed elsewhere: the module source into another namespace stops the run', () => spentKind(otherNs, X, false), 'content-module');
refuses('spent, signed elsewhere: a keyset definition stops the run', () => spentKind(keysetDefinition, X, false), 'content-definition');
refuses('spent, signed elsewhere: a command not in the exact form stops the run', () => spentKind(hidden, X, false), 'format-exact');

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall tool checks passed');
process.exit(fails ? 1 : 0);
