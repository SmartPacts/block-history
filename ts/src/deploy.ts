// deploy.ts — put block-history on every configured chain, in one pass.
//   npm run deploy                 deploy (devnet: creates + funds the admin and feeder keys)
//   npm run deploy -- --unsigned   write each chain's command as a file instead of sending; sign + send with send-signed
//
// Per chain: ONE transaction carries the module source, with {"ns": BH_NS} in its data. Nothing has to
// exist on chain first. The module is immutable, so a chain that already carries it is reported and
// left alone — there is no upgrade path by design. On a devnet the result is verified by reading the
// module hash and the empty `latest` back.
//
// Namespace: `free` on both devnet and mainnet — this is a public utility module. `free`'s user guard
// is `ns.success`, so a module name there is first-come and its first deploy needs no signature but
// the gas payer's. `npm run preflight` reports a chain whose name is held by a different module as LOST.
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainId } from '@kadena/client';
import {
  API, NETWORK_ID, NS, MODULE, OUT, ROOT, SENDER00, isDevnet, keyPath,
  loadOrCreateKey, accountOf, keysetOf, parseChains, local, send, balance, chainTime, type Keypair,
  buildUnsignedGasOnly, MODULE_GAS_LIMIT,
} from './lib.js';

const UNSIGNED = process.argv.includes('--unsigned');
const CHAINS = parseChains();
const SOURCE = readFileSync(join(ROOT, 'pact', 'modules', 'block-history.pact'), 'utf8');

// Keys are loaded LAZILY. In unsigned mode against a public network we need no secret at all —
// only the PUBLIC key that will sign, so the file we emit names the right signer. Loading the
// local devnet key files there would silently list a devnet public key as the signer and produce
// commands the real gas payer cannot sign (measured: the emitted file named a devnet key instead
// of the gas payer, which the node would reject).
const PUBKEY = /^[0-9a-f]{64}$/;
let _admin: Keypair | null = null, _feeder: Keypair | null = null;
const adminKey = (): Keypair => (_admin ??= loadOrCreateKey(keyPath('BH_ADMIN_KEY', 'out/admin-key.json')));
const feederKey = (): Keypair => (_feeder ??= loadOrCreateKey(keyPath('BH_FEEDER_KEY', 'out/feeder-key.json')));

const ENV_ACCT = process.env.BH_ADMIN_ACCOUNT;
const adminAcct = ENV_ACCT ?? accountOf(adminKey());
// The public key the emitted commands will name as signer.
const adminPubKey: string = (() => {
  const explicit = process.env.BH_ADMIN_PUBKEY;
  if (explicit) {
    if (!PUBKEY.test(explicit)) throw new Error(`BH_ADMIN_PUBKEY must be 64 hex characters, got ${JSON.stringify(explicit)}`);
    return explicit;
  }
  if (ENV_ACCT?.startsWith('k:') && PUBKEY.test(ENV_ACCT.slice(2))) return ENV_ACCT.slice(2);
  if (ENV_ACCT && UNSIGNED) throw new Error(`BH_ADMIN_ACCOUNT ${ENV_ACCT} is not a k: account, so the signing public key cannot be derived — set BH_ADMIN_PUBKEY to the key that will actually sign`);
  return adminKey().publicKey;
})();

// One file per chain, so a re-run replaces its own stale file instead of adding a second, in a directory
// per network, so files written for one network never sit beside another's.
const UNSIGNED_DIR = join(OUT, 'unsigned', NETWORK_ID);
const LABEL = `deploy ${MODULE}`;
const unsignedPath = (c: ChainId) =>
  join(UNSIGNED_DIR, `chain${String(c).padStart(2, '0')}-${LABEL.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.json`);
// The gas payer is the only signer, scoped to coin.GAS (lib.ts: buildUnsignedGasOnly). Sign and send
// the files with `npm run send-signed -- --gas-key <key.json> …`, which accepts nothing else.
async function writeUnsigned(c: ChainId): Promise<void> {
  const now = await chainTime(c);
  const tx = buildUnsignedGasOnly({
    code: SOURCE, data: { ns: NS }, chainId: c, sender: adminAcct, signerPubKey: adminPubKey,
    gasLimit: MODULE_GAS_LIMIT, creationTime: Math.floor(now.getTime() / 1000) - 15,
  });
  mkdirSync(UNSIGNED_DIR, { recursive: true });
  const p = unsignedPath(c);
  writeFileSync(p, JSON.stringify(tx, null, 2) + '\n');
  console.log(`  ✎ chain ${c}: ${LABEL} → ${p}`);
}

async function fundOnDevnet(c: ChainId, kp: Keypair, amount: number, what: string) {
  const acct = accountOf(kp);
  if ((await balance(acct, c)) >= amount / 2) return;
  await send({
    label: `devnet faucet → ${what}`, chainId: c, sender: 'sender00',
    code: `(coin.transfer-create "sender00" ${JSON.stringify(acct)} (read-keyset "ks") ${amount.toFixed(1)})`,
    signers: [{ kp: SENDER00, caps: (wc) => [wc('coin.GAS'), wc('coin.TRANSFER', 'sender00', acct, { decimal: amount.toFixed(1) })] }],
    data: { ks: keysetOf(kp) }, gasLimit: 2500,
  });
}

async function deployChain(c: ChainId): Promise<{ chain: ChainId; hash: string; status: string }> {
  if (isDevnet() && !UNSIGNED) {
    await fundOnDevnet(c, adminKey(), 100, 'admin');
    await fundOnDevnet(c, feederKey(), 100, 'feeder');
  }
  if (!UNSIGNED && (await balance(adminAcct, c)) <= 0) throw new Error(`chain ${c}: admin ${adminAcct} holds no KDA`);

  // The module is immutable: never redeploy.
  const existing = await local(`(describe-module ${JSON.stringify(MODULE)})`, { chainId: c }).catch(() => null);
  if (existing) return { chain: c, hash: existing.hash, status: 'already deployed (immutable) — untouched' };
  if (UNSIGNED) {
    await writeUnsigned(c);
    return { chain: c, hash: '(unsigned)', status: 'MODULE command written' };
  }
  const landed = await send({ label: LABEL, chainId: c, sender: adminAcct, gasLimit: MODULE_GAS_LIMIT, code: SOURCE, signers: [{ kp: adminKey() }], data: { ns: NS } });

  // verify
  const mod = await local(`(describe-module ${JSON.stringify(MODULE)})`, { chainId: c });
  const latest = await local(`(${MODULE}.latest)`, { chainId: c });
  if (latest.height !== -1) throw new Error(`chain ${c}: latest is not the empty sentinel after deploy: ${JSON.stringify(latest)}`);
  return { chain: c, hash: mod.hash, status: `deployed, gas ${landed.gas}, height ${landed.height}` };
}

async function main() {
  console.log(`\n=== block-history deploy → ${API}  ns=${NS}  chains=${CHAINS.join(',')}${UNSIGNED ? '  (UNSIGNED: files for wallet signing)' : ''} ===`);
  console.log(`  admin    ${adminAcct} (signer ${adminPubKey.slice(0, 12)}…)\n  feeder   ${UNSIGNED ? '(not needed in unsigned mode)' : accountOf(feederKey())}`);
  if (!isDevnet() && UNSIGNED === false) {
    throw new Error(`refusing to sign and send on ${NETWORK_ID} directly: use --unsigned, then npm run send-signed -- --gas-key <key.json>`);
  }
  // Deploy files an earlier version wrote straight into out/unsigned/ are no longer read or cleaned up.
  const flat = existsSync(join(OUT, 'unsigned')) ? readdirSync(join(OUT, 'unsigned')).filter((f) => /^chain\d\d-.*\.json$/.test(f)) : [];
  if (UNSIGNED && flat.length) console.log(`  note: ${flat.length} deploy file(s) from an earlier version sit directly in out/unsigned/ and are ignored; this network's files are in out/unsigned/${NETWORK_ID}/`);
  const results: { chain: ChainId; hash: string; status: string }[] = [];
  // a few chains at a time: independent mempools, one node
  const queue = [...CHAINS];
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) { const c = queue.shift()!; results.push(await deployChain(c)); }
  });
  await Promise.all(workers);
  results.sort((a, b) => Number(a.chain) - Number(b.chain));
  console.log('\nchain  module hash                                    status');
  for (const r of results) console.log(`${r.chain.padStart(5)}  ${r.hash.padEnd(45)}  ${r.status}`);
  const written = results.filter((r) => r.status === 'MODULE command written');
  if (written.length) {
    console.log(`\n  ${written.length} module command(s) written, for chain(s) ${written.map((r) => r.chain).join(',')}.`);
    console.log(`  Check them with npm run send-signed -- --gas-key <key.json> out/unsigned/${NETWORK_ID}/*.json, then add --send to submit.`);
  }
  const hashes = new Set(results.map((r) => r.hash));
  if (!UNSIGNED && hashes.size !== 1) throw new Error(`module hash differs across chains: ${[...hashes].join(' ')} — the same source in the same namespace must hash identically`);
  if (!UNSIGNED && hashes.size === 1) console.log(`\nall ${results.length} chains carry module hash ${[...hashes][0]}`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `deploy-${NETWORK_ID}.json`), JSON.stringify({ network: NETWORK_ID, ns: NS, module: MODULE, at: new Date().toISOString(), results }, null, 2) + '\n');
}
main().catch((e) => { console.error(`\nDEPLOY FAILED: ${e?.message ?? e}`); process.exit(1); });
