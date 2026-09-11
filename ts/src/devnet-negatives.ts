// devnet-negatives.ts — re-prove the refusals ON A NODE: a REPL pass is not node evidence.
// Every check here is a preflight (/local with signature verification), so nothing is mined and
// nothing is spent. A positive control proves the harness can tell a refusal from a broken call.
//   npm run devnet-negatives -- --chain 2
import type { ChainId } from '@kadena/client';
import { API, MODULE, keyPath, loadOrCreateKey, accountOf, sendExpectFail, buildSigned, client } from './lib.js';

const args = process.argv.slice(2);
const CHAIN = (args[args.indexOf('--chain') + 1] ?? '2') as ChainId;
const feeder = loadOrCreateKey(keyPath('BH_FEEDER_KEY', 'out/feeder-key.json'), false);
let fails = 0;
const step = async (name: string, fn: () => Promise<any>) => { try { await fn(); } catch (e: any) { fails++; console.log(`  ✗ ${name}: ${String(e?.message ?? e).slice(0, 300)}`); } };

async function main() {
  console.log(`\n=== devnet negatives → ${API} chain ${CHAIN} (preflight only; nothing mined) ===`);

  // reads and governance
  await step('get-attested on a missing height aborts', () => sendExpectFail({ label: 'missing read', chainId: CHAIN, sender: accountOf(feeder), code: `(${MODULE}.get-attested 999999999)`, signers: [{ kp: feeder, caps: (wc) => [wc('coin.GAS')] }], gasLimit: 2000 }, `No value found in table ${MODULE}_attested`));
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
