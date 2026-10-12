// sweep.ts — move the feeder's whole KDA balance, on every chain, to one destination account.
//
//   npm run sweep -- k:<destination public key>            dry run: balances, fees, node preflight of every transfer
//   npm run sweep -- k:<destination public key> --send     the same, then submit, wait for mining, re-read balances
//
// The key is the feeder's own (BH_FEEDER_KEY, default out/feeder-key.json) and never leaves this
// machine. The destination must be a `k:` account: its guard is derived from its name, so the
// transfer is a `transfer-create` that works whether or not the account exists on a chain yet,
// and can never create an account under a guard nobody holds.
//
// Per chain the amount is the balance minus the gas this transaction may buy (GAS_LIMIT × gas
// price); the node refunds the gas it did not use, so a few millionths of a KDA stay behind. A
// chain whose balance does not cover the gas is left alone and said so. A chain that could not be
// READ is reported as an error, never as empty.
//
// Refuses to run while the feeder service is active on this machine: the feeder spends from the
// same account, so a sweep under it is a moving target.
import type { ChainId } from '@kadena/client';
import { execFileSync } from 'node:child_process';
import {
  API, NETWORK_ID, GAS_PRICE, client, parseChains, loadOrCreateKey, keyPath, accountOf, buildSigned, sendBuilt, errorText, local, retrying,
} from './lib.js';

export const GAS_LIMIT = 2000;          // coin.transfer-create needs well under this (measured on devnet: see tools-check.ts)
const SCALE = 12n;                      // coin's decimal precision
const ONE = 10n ** SCALE;

// "4.52312136" | "22" | "0.1e-3" are NOT all accepted: only a plain decimal literal is, which is what
// (format "{}" [decimal]) gives. Anything else is refused — a misparsed balance must never become an amount.
export function toUnits(s: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a plain decimal: ${JSON.stringify(s)}`);
  const frac = (m[2] ?? '').padEnd(Number(SCALE), '0');
  if (frac.length > Number(SCALE)) throw new Error(`more than ${SCALE} decimals: ${s}`);
  return BigInt(m[1]) * ONE + BigInt(frac);
}
export function fromUnits(u: bigint): string {
  if (u < 0n) throw new Error('negative amount');
  const whole = u / ONE, frac = (u % ONE).toString().padStart(Number(SCALE), '0');
  return `${whole}.${frac}`;
}
export const feeUnits = (gasLimit: number, gasPrice: number): bigint => toUnits(gasPrice.toFixed(Number(SCALE))) * BigInt(gasLimit);

export function destinationKey(acct: string): string {
  const m = /^k:([0-9a-f]{64})$/.exec(acct);
  if (!m) throw new Error(`destination must be a k: account (k: + 64 hex), got ${JSON.stringify(acct)}`);
  return m[1];
}

export type Plan = { chain: ChainId; balance: string; amount: string | null; note: string };
export function plan(chain: ChainId, balance: string, fee: bigint): Plan {
  const b = toUnits(balance);
  if (b <= fee) return { chain, balance, amount: null, note: b === 0n ? 'empty' : `only dust: ${balance} does not cover the ${fromUnits(fee)} gas` };
  return { chain, balance, amount: fromUnits(b - fee), note: '' };
}

function feederIsActive(): boolean | null {
  try { execFileSync('systemctl', ['is-active', '--quiet', 'block-history-feeder'], { stdio: 'ignore' }); return true; }
  catch (e: any) {
    if (e?.code === 'ENOENT') return null;          // no systemd here: unknown
    return false;                                    // is-active exits non-zero when inactive or unknown
  }
}

async function readBalance(acct: string, chain: ChainId): Promise<string> {
  // (format ...) hands back the exact decimal the chain holds; a JS number could round it.
  try { return String(await local(`(format "{}" [(coin.get-balance ${JSON.stringify(acct)})])`, { chainId: chain })); }
  catch (e: any) {
    if (/No value found|row not found|not found in table/i.test(String(e?.message ?? e))) return '0.0';
    throw e;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sendIt = args.includes('--send');
  const dest = args.find((a) => !a.startsWith('--'));
  if (!dest) { console.error('usage: npm run sweep -- k:<destination public key> [--send]'); process.exit(2); }
  const destKey = destinationKey(dest);

  const active = feederIsActive();
  if (active === true) { console.error('REFUSED: the block-history-feeder service is active on this machine. Stop it first:\n  systemctl disable --now block-history-feeder'); process.exit(2); }
  if (active === null && sendIt && process.env.BH_SWEEP_NO_SERVICE_CHECK !== '1') {
    console.error('REFUSED: no systemd here, so the feeder service could not be checked. If no feeder runs anywhere with this key, set BH_SWEEP_NO_SERVICE_CHECK=1.');
    process.exit(2);
  }

  const kp = loadOrCreateKey(keyPath('BH_FEEDER_KEY', 'out/feeder-key.json'), false);
  const from = accountOf(kp);
  const fee = feeUnits(GAS_LIMIT, GAS_PRICE);
  const CHAINS = parseChains();
  console.log(`\n=== sweep ${sendIt ? '— SENDING' : '(dry run: nothing is submitted)'} → ${API}  network ${NETWORK_ID}`);
  console.log(`    from ${from}\n    to   ${dest}\n    gas  limit ${GAS_LIMIT} × price ${GAS_PRICE} = at most ${fromUnits(fee)} KDA per chain, unused gas refunded\n`);
  if (from === dest) { console.error('REFUSED: destination is the feeder account itself'); process.exit(2); }

  // 1. Read every balance. One unreadable chain stops everything: a sweep that silently skips a chain leaves money behind unreported.
  const plans: Plan[] = [];
  for (const c of CHAINS) plans.push(plan(c, await readBalance(from, c), fee));
  console.log('chain   balance KDA        amount to move');
  for (const p of plans) console.log(`${p.chain.padStart(5)}   ${p.balance.padStart(16)}   ${p.amount ? p.amount : `— ${p.note}`}`);
  const moving = plans.filter((p) => p.amount !== null);
  const total = moving.reduce((a, p) => a + toUnits(p.amount!), 0n);
  console.log(`\n  ${moving.length} of ${plans.length} chain(s) to sweep, ${fromUnits(total)} KDA in total\n`);
  if (moving.length === 0) { console.log('nothing to move'); return; }

  // 2. Build + sign every transfer, and have the node preflight each one (gas purchase simulated, nothing submitted).
  const signed: { p: Plan; tx: Awaited<ReturnType<typeof buildSigned>> }[] = [];
  for (const p of moving) {
    const amount = p.amount!;
    const tx = await buildSigned({
      label: `sweep chain ${p.chain}`, chainId: p.chain, sender: from, gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE, ttl: 1800,
      nonce: `bh-sweep:${p.chain}:${Date.now()}`,
      code: `(coin.transfer-create ${JSON.stringify(from)} ${JSON.stringify(dest)} (read-keyset "ks") ${amount})`,
      data: { ks: { keys: [destKey], pred: 'keys-all' } },
      signers: [{ kp, caps: (wc) => [wc('coin.GAS'), wc('coin.TRANSFER', from, dest, { decimal: amount })] }],
    });
    const pre = await retrying('preflight', () => client.local(tx, { preflight: true, signatureVerification: true }));
    if (pre.result.status !== 'success') { console.error(`  ✗ chain ${p.chain}: preflight FAILED: ${errorText(pre)}`); process.exit(1); }
    console.log(`  ✓ chain ${p.chain}: preflight ok, ${amount} KDA, gas ${(pre as any).gas}`);
    signed.push({ p, tx });
  }
  if (!sendIt) { console.log(`\nDRY RUN complete: ${signed.length} transfer(s) preflighted, none submitted. Add --send to move the funds.`); return; }

  // 3. Submit all, wait for every one to be mined. A failure here is reported per chain; the others still complete.
  console.log('\nsubmitting…');
  const landed = await Promise.allSettled(signed.map(({ p, tx }) => sendBuilt(tx, p.chain, `sweep chain ${p.chain}`)));
  let failed = 0;
  landed.forEach((r, i) => { if (r.status === 'rejected') { failed++; console.error(`  ✗ chain ${signed[i].p.chain}: ${r.reason?.message ?? r.reason}`); } });

  // 4. What is actually there now, on both sides, read back from the chain.
  console.log('\nafter:');
  let left = 0n, received = 0n;
  for (const p of moving) {
    const a = await readBalance(from, p.chain), b = await readBalance(dest, p.chain);
    left += toUnits(a); received += toUnits(b);
    console.log(`  chain ${p.chain.padStart(2)}: feeder ${a.padStart(16)}   destination ${b.padStart(16)}`);
  }
  console.log(`\n  feeder keeps ${fromUnits(left)} KDA (gas dust) on the swept chains; destination holds ${fromUnits(received)} KDA there`);
  if (failed) { console.error(`\n${failed} chain(s) FAILED — re-run; a chain already swept is reported as dust and skipped`); process.exit(1); }
  console.log('\nSWEEP COMPLETE');
}

if (process.argv[1] && /sweep\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`sweep FAILED: ${e?.message ?? e}`); process.exit(2); });
}
