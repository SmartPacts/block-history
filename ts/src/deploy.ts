// deploy.ts — put block-history on every configured chain.
//   npm run deploy                 deploy (devnet: creates + funds the admin, feeder and backfill keys)
//   npm run deploy -- --unsigned   write each command as a file instead of sending; sign + send with send-signed
//
// Per chain, in order: (1) the backfill keyset `${NS}.block-history-backfill` is defined if absent
// (and REFUSED if present with other keys — a stranger could otherwise own backfill in an open
// namespace); (2) the module is deployed with `ns` in transaction data; (3) the result is verified
// by reading the module hash and the open backfill window back. The module is immutable, so an
// existing deployment is reported and left alone — there is no upgrade path by design.
//
// Namespace: `free` on both devnet and mainnet — this is a public utility module.
// `free`'s user guard is `ns.success`, so ANY name there is first-come and claiming an unclaimed
// keyset or module name needs no signature at all. Whoever claims `<ns>.block-history-backfill`
// owns backfill on that chain forever, because the module can never be upgraded. Hence the
// two-pass rule enforced below: the module is never emitted or sent until the keyset is
// confirmed on chain with our exact keys.
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainId } from '@kadena/client';
import {
  API, NETWORK_ID, NS, MODULE, BACKFILL_KEYSET, OUT, ROOT, SENDER00, isDevnet, keyPath,
  loadOrCreateKey, accountOf, keysetOf, parseChains, local, send, balance, chainTime, type TxSpec, type Keypair,
  sameKeyset, keysetDeployCode, buildUnsignedGasOnly, validateKeyset, KEYSET_GAS_LIMIT, MODULE_GAS_LIMIT,
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
let _admin: Keypair | null = null, _feeder: Keypair | null = null, _backfill: Keypair | null = null;
const adminKey = (): Keypair => (_admin ??= loadOrCreateKey(keyPath('BH_ADMIN_KEY', 'out/admin-key.json')));
const feederKey = (): Keypair => (_feeder ??= loadOrCreateKey(keyPath('BH_FEEDER_KEY', 'out/feeder-key.json')));
const backfillKey = (): Keypair => (_backfill ??= loadOrCreateKey(keyPath('BH_BACKFILL_KEY', 'out/backfill-key.json')));
// In unsigned mode a command carries no local signer: the file names the gas payer (adminPubKey) and
// no key file is opened. A public-network checkout has none, so opening one would stop the deploy.
const adminSigners = () => (UNSIGNED ? [] : [{ kp: adminKey() }]);

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
const backfillKeyset = (() => {
  const raw = process.env.BH_BACKFILL_KEYSET;
  if (!raw) return keysetOf(backfillKey());
  try { return validateKeyset(JSON.parse(raw)); } catch (e: any) { throw new Error(`BH_BACKFILL_KEYSET: ${e?.message ?? e}`); }
})();

// One file per chain and command, so a re-run replaces its own stale file instead of adding a second, in a
// directory per network, so files written for one network never sit beside another's.
const UNSIGNED_DIR = join(OUT, 'unsigned', NETWORK_ID);
const unsignedPath = (c: ChainId, label: string) =>
  join(UNSIGNED_DIR, `chain${String(c).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.json`);
// The gas payer is the only signer, scoped to coin.GAS (lib.ts: buildUnsignedGasOnly). Sign and send
// the files with `npm run send-signed -- --gas-key <key.json> …`, which accepts nothing else.
async function writeUnsigned(s: TxSpec, signerKey: string): Promise<void> {
  const now = await chainTime(s.chainId);
  const tx = buildUnsignedGasOnly({
    code: s.code, data: s.data ?? {}, chainId: s.chainId, sender: s.sender, signerPubKey: signerKey,
    gasLimit: s.gasLimit ?? MODULE_GAS_LIMIT, gasPrice: s.gasPrice, creationTime: Math.floor(now.getTime() / 1000) - 15,
  });
  mkdirSync(UNSIGNED_DIR, { recursive: true });
  const p = unsignedPath(s.chainId, s.label);
  writeFileSync(p, JSON.stringify(tx, null, 2) + '\n');
  console.log(`  ✎ chain ${s.chainId}: ${s.label} → ${p}`);
}
const step = (s: TxSpec) => (UNSIGNED ? writeUnsigned({ ...s, sender: adminAcct }, adminPubKey) : send(s));

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
    await fundOnDevnet(c, backfillKey(), 100, 'backfill');
  }
  if (!UNSIGNED && (await balance(adminAcct, c)) <= 0) throw new Error(`chain ${c}: admin ${adminAcct} holds no KDA`);

  // 1. THE KEYSET, AND NOTHING ELSE UNTIL IT IS CONFIRMED ON CHAIN.
  //
  // Defining an UNCLAIMED keyset name needs no signature at all — proven in the REPL: with
  // `env-sigs []`, `(define-keyset "free.block-history-backfill" …)` succeeds. Rotation of a
  // claimed name does require the current keys (1-of-3 refused, 2-of-3 accepted). So in an open
  // namespace the name is first-come, and whoever claims it owns the backfill power on that
  // chain FOREVER, because this module can never be upgraded.
  //
  // Therefore the module is never emitted or sent for a chain whose keyset is not already on
  // chain with OUR exact keys. In unsigned mode that means two passes: this run writes the
  // keyset command, you sign and send it, then re-run and this run writes the module command.
  // Emitting both at once would let the module be sent first, leaving a live module whose
  // keyset a stranger could then claim.
  const existingKs = await local(`(describe-keyset ${JSON.stringify(BACKFILL_KEYSET)})`, { chainId: c }).catch(() => null);
  if (existingKs && !sameKeyset(existingKs, backfillKeyset)) throw new Error(`chain ${c}: ${BACKFILL_KEYSET} exists with OTHER keys ${JSON.stringify(existingKs.keys)} (${existingKs.pred}) — not ours; refusing (this chain is lost: the module is immutable and cannot be pointed at another keyset)`);
  if (existingKs && UNSIGNED) {
    // The keyset is ours on chain, so its command file is spent. Removing it means a pass-1 file re-sent
    // late can never sit beside the module file and stop the next send.
    const spent = unsignedPath(c, `define keyset ${BACKFILL_KEYSET}`);
    if (existsSync(spent)) { unlinkSync(spent); console.log(`  ✓ chain ${c}: the keyset is ours — removed its spent file`); }
  }
  if (!existingKs) {
    await step({
      label: `define keyset ${BACKFILL_KEYSET}`, chainId: c, sender: adminAcct, gasLimit: KEYSET_GAS_LIMIT,
      code: keysetDeployCode(NS), signers: adminSigners(), data: { ks: backfillKeyset },
    });
    if (UNSIGNED) return { chain: c, hash: '(none yet)', status: 'KEYSET command written — sign and send it, then re-run for the module' };
    const confirmed = await local(`(describe-keyset ${JSON.stringify(BACKFILL_KEYSET)})`, { chainId: c }).catch(() => null);
    if (!sameKeyset(confirmed, backfillKeyset)) throw new Error(`chain ${c}: ${BACKFILL_KEYSET} is not confirmed on chain after definition — refusing to send the module`);
  }

  // 2. module (immutable: never redeploy)
  const existing = await local(`(describe-module ${JSON.stringify(MODULE)})`, { chainId: c }).catch(() => null);
  if (existing) return { chain: c, hash: existing.hash, status: 'already deployed (immutable) — untouched' };
  if (UNSIGNED) {
    await step({ label: `deploy ${MODULE}`, chainId: c, sender: adminAcct, gasLimit: MODULE_GAS_LIMIT, code: SOURCE, signers: adminSigners(), data: { ns: NS } });
    return { chain: c, hash: '(unsigned)', status: 'MODULE command written (keyset already confirmed on chain)' };
  }
  const landed = await send({ label: `deploy ${MODULE}`, chainId: c, sender: adminAcct, gasLimit: MODULE_GAS_LIMIT, code: SOURCE, signers: [{ kp: adminKey() }], data: { ns: NS } });

  // 3. verify
  const mod = await local(`(describe-module ${JSON.stringify(MODULE)})`, { chainId: c });
  const st = await local(`(${MODULE}.backfill-status)`, { chainId: c });
  const latest = await local(`(${MODULE}.latest)`, { chainId: c });
  if (!st.open || st['closed-at'] !== -1) throw new Error(`chain ${c}: backfill window is not open after deploy: ${JSON.stringify(st)}`);
  if (latest.height !== -1) throw new Error(`chain ${c}: latest is not the empty sentinel after deploy: ${JSON.stringify(latest)}`);
  return { chain: c, hash: mod.hash, status: `deployed, gas ${landed.gas}, height ${landed.height}` };
}

async function main() {
  console.log(`\n=== block-history deploy → ${API}  ns=${NS}  chains=${CHAINS.join(',')}${UNSIGNED ? '  (UNSIGNED: files for wallet signing)' : ''} ===`);
  console.log(`  admin    ${adminAcct} (signer ${adminPubKey.slice(0, 12)}…)\n  feeder   ${UNSIGNED ? '(not needed in unsigned mode)' : accountOf(feederKey())}\n  backfill keyset ${BACKFILL_KEYSET} = ${backfillKeyset.keys.length} key(s), ${backfillKeyset.pred}`);
  if (!isDevnet() && UNSIGNED === false) {
    throw new Error(`refusing to sign and send on ${NETWORK_ID} directly: use --unsigned, then npm run send-signed -- --gas-key <key.json>`);
  }
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
  const pending = results.filter((r) => r.status.startsWith('KEYSET command written'));
  if (pending.length) {
    console.log(`\n  ${pending.length} chain(s) need their KEYSET sent first: ${pending.map((r) => r.chain).join(',')}`);
    console.log(`  Sign and send them (npm run send-signed -- --gas-key <key.json> [--send] out/unsigned/${NETWORK_ID}/*.json), confirm with 'npm run preflight', then re-run this command for the module files.`);
  }
  const hashes = new Set(results.filter((r) => !r.status.startsWith('KEYSET')).map((r) => r.hash));
  if (!UNSIGNED && hashes.size !== 1) throw new Error(`module hash differs across chains: ${[...hashes].join(' ')} — the same source in the same namespace must hash identically`);
  if (!UNSIGNED && hashes.size === 1) console.log(`\nall ${results.length} chains carry module hash ${[...hashes][0]}`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `deploy-${NETWORK_ID}.json`), JSON.stringify({ network: NETWORK_ID, ns: NS, module: MODULE, at: new Date().toISOString(), results }, null, 2) + '\n');
}
main().catch((e) => { console.error(`\nDEPLOY FAILED: ${e?.message ?? e}`); process.exit(1); });
