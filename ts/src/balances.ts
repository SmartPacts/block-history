// balances.ts — READ-ONLY. An account's KDA on every chain, and the feeder runway it buys.
//
//   npm run balances -- k:<public key>
//
// Runway uses the MAINNET block rate (2,878 blocks per chain per day, measured over 40,000
// consecutive blocks) and the gas one feeder spends per block, measured on mainnet (lib.ts: feederGasPerBlock),
// for the BH_WAITING_INTERVAL this environment sets: about 189 gas reacting to blocks only, about 552 with an
// attest waiting every 10 s. A second feeder's own no-ops cost it less, so for it this errs on the long side.
//
// "unfunded" means the chain answered and the account holds nothing there. A chain that could not
// be READ is reported as an error, never as zero — an unreachable node must not look like an
// empty wallet. Exit 0 = funded on every chain; 1 = at least one chain unfunded; 2 = unreadable.
import type { ChainId } from '@kadena/client';
import { API, NETWORK_ID, GAS_PRICE, parseChains, local, feederGasPerBlock, parseWaitingInterval } from './lib.js';

const BLOCKS_PER_DAY = 2878;
const WAITING = parseWaitingInterval(process.env.BH_WAITING_INTERVAL);
const PER_DAY = BLOCKS_PER_DAY * feederGasPerBlock(WAITING) * GAS_PRICE;

const acct = process.argv[2];
if (!acct) {
  console.error('usage: npm run balances -- k:<public key>');
  process.exit(2);
}
const CHAINS = parseChains();

type Row = { chain: ChainId; kda: number | null; note: string };
async function read(c: ChainId): Promise<Row> {
  try {
    const v = await local(`(coin.get-balance ${JSON.stringify(acct)})`, { chainId: c });
    return { chain: c, kda: Number(v), note: '' };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // the account row does not exist on this chain yet: that is "unfunded", a real answer
    if (/No value found|row not found|not found in table/i.test(msg)) return { chain: c, kda: 0, note: 'no account on this chain yet' };
    return { chain: c, kda: null, note: `UNREADABLE: ${msg.slice(0, 80)}` };
  }
}

async function main() {
  console.log(`\n=== balances (read-only) → ${API}  network ${NETWORK_ID}\n    account ${acct}`);
  console.log(`    one feeder burns ≈${PER_DAY.toFixed(5)} KDA per chain per day on mainnet${WAITING === null ? ', reacting to blocks only' : `, with an attest waiting every ${WAITING} s`}\n`);
  const rows = await Promise.all(CHAINS.map(read));
  let total = 0, unfunded = 0, unreadable = 0, minDays = Infinity;
  console.log('chain   balance KDA    runway');
  for (const r of rows) {
    if (r.kda === null) { unreadable++; console.log(`${r.chain.padStart(5)}   ${'—'.padStart(11)}    ${r.note}`); continue; }
    total += r.kda;
    const days = r.kda / PER_DAY;
    if (r.kda <= 0) unfunded++; else minDays = Math.min(minDays, days);
    console.log(`${r.chain.padStart(5)}   ${r.kda.toFixed(6).padStart(11)}    ${r.kda <= 0 ? `UNFUNDED ${r.note}` : `${Math.floor(days)} days`}`);
  }
  console.log(`\n  total ${total.toFixed(6)} KDA on ${rows.length - unreadable} readable chain(s)`);
  if (unreadable) { console.log(`  🔴 ${unreadable} chain(s) could not be read — this is NOT a balance; check the node and re-run`); process.exit(2); }
  if (unfunded) { console.log(`  NOT READY: ${unfunded} chain(s) hold nothing. The feeder refuses to start until every chain is funded.`); process.exit(1); }
  console.log(`  READY: funded on all ${rows.length} chains. Shortest runway ${Math.floor(minDays)} days — top up before then.`);
}
main().catch((e) => { console.error(`balances FAILED: ${e?.message ?? e}`); process.exit(2); });
