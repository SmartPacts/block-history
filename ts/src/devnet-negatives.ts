// devnet-negatives.ts — re-prove the refusals ON A NODE: a REPL pass is not node evidence.
// Every check here is a preflight (/local with signature
// verification), so nothing is mined and nothing is spent. One positive control per class proves
// the harness can tell a refusal from a broken call.
//   npm run devnet-negatives -- --chain 2
import type { ChainId } from '@kadena/client';
import { API, MODULE, keyPath, loadOrCreateKey, accountOf, local, cut, sendExpectFail, buildSigned, client, canonicalHeaders, pactTime } from './lib.js';

const args = process.argv.slice(2);
const CHAIN = (args[args.indexOf('--chain') + 1] ?? '2') as ChainId;
const backfill = loadOrCreateKey(keyPath('BH_BACKFILL_KEY', 'out/backfill-key.json'), false);
const feeder = loadOrCreateKey(keyPath('BH_FEEDER_KEY', 'out/feeder-key.json'), false);
const bfSigner = { kp: backfill, caps: (wc: any) => [wc('coin.GAS'), wc(`${MODULE}.BACKFILL`)] };
const H43 = 'QqNvtjXzPCn8J1UD_MicQvSQs8ogzAIGfAIe9boWC9s';
let fails = 0;
const step = async (name: string, fn: () => Promise<any>) => { try { await fn(); } catch (e: any) { fails++; console.log(`  ✗ ${name}: ${String(e?.message ?? e).slice(0, 300)}`); } };

async function main() {
  console.log(`\n=== devnet negatives → ${API} chain ${CHAIN} (preflight only; nothing mined) ===`);
  const top = (await cut())[CHAIN].height;
  const st = await local(`(${MODULE}.backfill-status)`, { chainId: CHAIN });
  const [hdr] = await canonicalHeaders(CHAIN, 3, 3);
  const row = (h: number) => ({ height: { int: h }, hash: H43, time: pactTime(1_700_000_000_000_000) });

  // authority
  await step('unsigned backfill', () => sendExpectFail({ label: 'unsigned backfill', chainId: CHAIN, sender: accountOf(feeder), code: `(${MODULE}.backfill (read-msg 'rows))`, data: { rows: [row(3)] }, signers: [{ kp: feeder, caps: (wc) => [wc('coin.GAS')] }], gasLimit: 5000 }, 'Keyset failure ('));
  await step('backfill key scoped only to coin.GAS', () => sendExpectFail({ label: 'GAS-only scope', chainId: CHAIN, sender: accountOf(backfill), code: `(${MODULE}.backfill (read-msg 'rows))`, data: { rows: [row(3)] }, signers: [{ kp: backfill, caps: (wc) => [wc('coin.GAS')] }], gasLimit: 5000 }, 'Keyset failure ('));
  await step('unsigned close', () => sendExpectFail({ label: 'unsigned close', chainId: CHAIN, sender: accountOf(feeder), code: `(${MODULE}.close-backfill)`, signers: [{ kp: feeder, caps: (wc) => [wc('coin.GAS')] }], gasLimit: 2000 }, 'Keyset failure ('));

  // row validation (only meaningful while the window is open; after the close the first refusal is the window)
  const frontierMsg = st.open ? 'height is attestable, not backfillable' : 'the backfill window is closed';
  await step('backfill at the frontier', () => sendExpectFail({ label: 'frontier', chainId: CHAIN, sender: accountOf(backfill), code: `(${MODULE}.backfill (read-msg 'rows))`, data: { rows: [row(top)] }, signers: [bfSigner], gasLimit: 5000 }, frontierMsg));
  if (st.open) {
    await step('malformed hash', () => sendExpectFail({ label: 'bad hash', chainId: CHAIN, sender: accountOf(backfill), code: `(${MODULE}.backfill (read-msg 'rows))`, data: { rows: [{ height: { int: 3 }, hash: 'not-a-hash', time: pactTime(1) }] }, signers: [bfSigner], gasLimit: 5000 }, 'malformed block hash'));
    const attestedTop = (await local(`(${MODULE}.latest)`, { chainId: CHAIN })).height;
    if (attestedTop > 3) await step('backfill over an attested height', () => sendExpectFail({ label: 'shadow', chainId: CHAIN, sender: accountOf(backfill), code: `(${MODULE}.backfill (read-msg 'rows))`, data: { rows: [{ height: { int: attestedTop }, hash: H43, time: pactTime(1) }] }, signers: [bfSigner], gasLimit: 5000 }, 'height is already attested'));
    const bf3 = await local(`(${MODULE}.has-backfilled 3)`, { chainId: CHAIN });
    if (bf3) await step('conflicting hash for a backfilled height', () => sendExpectFail({ label: 'conflict', chainId: CHAIN, sender: accountOf(backfill), code: `(${MODULE}.backfill (read-msg 'rows))`, data: { rows: [{ height: { int: 3 }, hash: H43, time: pactTime(1) }] }, signers: [bfSigner], gasLimit: 5000 }, 'conflicting hash'));
    // positive control: the true header for height 3 is accepted (skipped if present, written if not) — preflight only
    await step('positive control: a true row preflights', async () => {
      const signed = await buildSigned({ label: 'true row', chainId: CHAIN, sender: accountOf(backfill), code: `(${MODULE}.backfill (read-msg 'rows))`, data: { rows: [{ height: { int: 3 }, hash: hdr.hash, time: pactTime(hdr.creationTime) }] }, signers: [bfSigner], gasLimit: 5000 });
      const r = await client.local(signed, { preflight: true, signatureVerification: true });
      if (r.result.status !== 'success') throw new Error(`true row refused: ${JSON.stringify((r.result as any).error).slice(0, 200)}`);
      console.log(`  ✓ positive control: true row for height 3 preflights (${JSON.stringify((r.result as any).data)})`);
    });
  } else {
    await step('backfill after the close', () => sendExpectFail({ label: 'after close', chainId: CHAIN, sender: accountOf(backfill), code: `(${MODULE}.backfill (read-msg 'rows))`, data: { rows: [row(3)] }, signers: [bfSigner], gasLimit: 5000 }, 'the backfill window is closed'));
    await step('close twice', () => sendExpectFail({ label: 'close twice', chainId: CHAIN, sender: accountOf(backfill), code: `(${MODULE}.close-backfill)`, signers: [bfSigner], gasLimit: 2000 }, 'already closed'));
  }

  // reads and governance
  await step('get-block on a missing height aborts', () => sendExpectFail({ label: 'missing read', chainId: CHAIN, sender: accountOf(feeder), code: `(${MODULE}.get-block 999999999)`, signers: [{ kp: feeder, caps: (wc) => [wc('coin.GAS')] }], gasLimit: 2000 }, 'no record for this height'));
  await step('external table write needs module admin', () => sendExpectFail({ label: 'external write', chainId: CHAIN, sender: accountOf(feeder), code: `(write ${MODULE}.attested "000000000003" { "hash": "FORGED", "time": (time "1970-01-01T00:00:00Z"), "by": "mallory" })`, signers: [{ kp: feeder }], gasLimit: 5000 }, 'Module admin'));
  await step('acquire-module-admin is refused', () => sendExpectFail({ label: 'acquire admin', chainId: CHAIN, sender: accountOf(feeder), code: `(acquire-module-admin ${MODULE})`, signers: [{ kp: feeder }], gasLimit: 5000 }, 'immutable'));
  // positive control: attest preflights for anyone
  await step('positive control: attest preflights', async () => {
    const signed = await buildSigned({ label: 'attest', chainId: CHAIN, sender: accountOf(feeder), code: `(${MODULE}.attest)`, signers: [{ kp: feeder, caps: (wc) => [wc('coin.GAS')] }], gasLimit: 400 });
    const r = await client.local(signed, { preflight: true, signatureVerification: true });
    if (r.result.status !== 'success') throw new Error(`attest refused: ${JSON.stringify((r.result as any).error).slice(0, 200)}`);
    console.log(`  ✓ positive control: attest preflights → ${JSON.stringify((r.result as any).data)} (gas ${(r as any).gas})`);
  });
  console.log(fails ? `\n${fails} node-layer negative(s) FAILED` : '\nall node-layer negatives hold');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
