// send-signed.ts — submit a command that was signed elsewhere (a wallet) and wait for it.
//   npm run send-signed -- ts/out/unsigned/01-chain2-deploy.json   (after the wallet filled in sigs)
// The file must be the standard {cmd, hash, sigs:[{sig}]} command JSON.
import { readFileSync } from 'node:fs';
import { API, NETWORK_ID, client, pollMined, errorText, unwrap } from './lib.js';

const file = process.argv[2];
if (!file) { console.error('usage: npm run send-signed -- <signed-command.json>'); process.exit(2); }
const cmd = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(cmd.sigs) || cmd.sigs.some((s: any) => !s?.sig)) { console.error(`${file}: not every signer has signed yet`); process.exit(2); }
const meta = JSON.parse(cmd.cmd).meta;
console.log(`submitting ${file} → ${API} chain ${meta.chainId} (network ${NETWORK_ID})`);
const desc = await client.submit(cmd);
console.log(`  request key ${desc.requestKey}; waiting for a block …`);
const r = await pollMined(desc.requestKey, meta.chainId, file);
if (r.result.status !== 'success') { console.error(`  MINED BUT FAILED: ${errorText(r)}`); process.exit(1); }
console.log(`  ✓ mined at height ${(r as any).metaData?.blockHeight}, gas ${(r as any).gas}, result ${JSON.stringify(unwrap((r.result as any).data)).slice(0, 200)}`);
