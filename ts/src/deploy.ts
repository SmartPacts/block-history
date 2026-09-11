// deploy.ts — put block-history on every configured chain, in one pass.
//   npm run deploy                 deploy (devnet: creates + funds the admin and feeder keys)
//   npm run deploy -- --unsigned   write each chain's command as a file instead of sending; sign + send with send-signed
//
// Per chain: ONE transaction carries the module source, with {"ns": BH_NS} in its data. Nothing has to
// exist on chain first. The module is immutable, so there is no upgrade path by design: a chain that
// already carries it is left alone. It is reported as ours only when one of this operator's deploy files
// created it (lib.ts: ownership); any other holder of the name is LOST, whatever its hash, and no file is
// written for that chain. On a devnet the result is verified by reading the module hash and the empty
// `latest` back.
//
// A deploy file is never destroyed (lib.ts: fileFate, planChain). One whose command failed on its chain, or
// expired, is moved into superseded/ before a fresh file is written. One whose command can still land is
// kept, and nothing is regenerated for its chain. A LOST chain's file is moved into superseded/ too, so the
// send glob no longer includes it. Files in superseded/ still count as proof that a chain is ours.
//
// Namespace: `free` on both devnet and mainnet — this is a public utility module. `free`'s user guard
// is `ns.success`, so a module name there is first-come and its first deploy needs no signature but
// the gas payer's. `npm run preflight` reports a chain whose module none of these deploy files created as LOST.
//
// Exit 0 = done (with --unsigned, kept files included). Exit 1 = a failure, or a direct deploy that left a
// chain undeployed because its recorded command can still land. Exit 2 = a chain is LOST.
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ChainId, ICommand } from '@kadena/client';
import { signHash } from '@kadena/cryptography-utils';
import {
  API, NETWORK_ID, NS, MODULE, OUT, ROOT, SENDER00, DEPLOY_DIR, isDevnet, keyPath,
  loadOrCreateKey, accountOf, keysetOf, parseChains, local, send, sendBuilt, balance, chainTime, type Keypair,
  buildUnsignedGasOnly, MODULE_GAS_LIMIT, readDeployFiles, ownershipOn, fileFateOn, planChain, supersede,
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

// One file per chain, in a directory per network (lib.ts: DEPLOY_DIR), so files written for one network
// never sit beside another's. The file name carries the module, namespace included. These files are also
// the proof a later run needs that a chain's module is ours, so none is ever overwritten or deleted.
const LABEL = `deploy ${MODULE}`;
const unsignedPath = (c: ChainId) =>
  join(DEPLOY_DIR, `chain${String(c).padStart(2, '0')}-${LABEL.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.json`);
const EXPECT = { networkId: NETWORK_ID, ns: NS, source: SOURCE };
// Read once, before this run moves or writes any file.
const { files: FILES, refused: REFUSED } = readDeployFiles(EXPECT);
const LOST_STATUS = 'LOST (not ours) — no file written, nothing sent';
const KEPT = 'kept because';
// A direct deploy sends its command at once, so it is valid for 30 minutes: after an interrupted run, its
// chain is kept rather than regenerated for that long at most.
const DIRECT_TTL = 1800;

function record(c: ChainId, tx: { cmd: string; hash: string; sigs: unknown[] }): string {
  mkdirSync(DEPLOY_DIR, { recursive: true });
  const p = unsignedPath(c);
  writeFileSync(p, JSON.stringify(tx, null, 2) + '\n');
  return p;
}
const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
// Moves a chain's file into superseded/ (lib.ts: supersede) and says so.
function aside(c: ChainId, why: string): string {
  const name = basename(unsignedPath(c));
  const moved = supersede(DEPLOY_DIR, name);
  console.log(`  ↪ chain ${c}: ${name} moved to out/unsigned/${NETWORK_ID}/${moved} — ${why}`);
  return moved;
}

// The gas payer is the only signer, scoped to coin.GAS (lib.ts: buildUnsignedGasOnly). Sign and send
// the files with `npm run send-signed -- --gas-key <key.json> …`, which accepts nothing else.
async function writeUnsigned(c: ChainId): Promise<void> {
  const now = await chainTime(c);
  const tx = buildUnsignedGasOnly({
    code: SOURCE, data: { ns: NS }, chainId: c, sender: adminAcct, signerPubKey: adminPubKey,
    gasLimit: MODULE_GAS_LIMIT, creationTime: Math.floor(now.getTime() / 1000) - 15,
  });
  console.log(`  ✎ chain ${c}: ${LABEL} → ${record(c, tx)}`);
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

type Result = { chain: ChainId; hash: string; status: string; moved?: string };

async function deployChain(c: ChainId): Promise<Result> {
  if (isDevnet() && !UNSIGNED) {
    await fundOnDevnet(c, adminKey(), 100, 'admin');
    await fundOnDevnet(c, feederKey(), 100, 'feeder');
  }
  if (!UNSIGNED && (await balance(adminAcct, c)) <= 0) throw new Error(`chain ${c}: admin ${adminAcct} holds no KDA`);

  // The module is immutable: never redeploy. A chain that carries it is ours only if one of this operator's
  // deploy files created it; any other holder of the name is LOST, whatever its hash, and gets no file.
  const existing = await local(`(describe-module ${JSON.stringify(MODULE)})`, { chainId: c }).catch(() => null);
  const who = await ownershipOn(c, !!existing, FILES, EXPECT);
  // The file already at this chain's path, if any: whether its command can still land.
  const p = unsignedPath(c);
  const fate = who === 'ours' || !existsSync(p) ? null : await fileFateOn(c, readJson(p));
  const plan = planChain(who, fate);
  if (plan.do === 'untouched') return { chain: c, hash: existing.hash, status: 'already deployed (immutable) — untouched' };
  if (plan.do === 'lost') return { chain: c, hash: existing.hash, status: LOST_STATUS, moved: plan.moveAside ? aside(c, 'the chain is LOST') : undefined };
  if (plan.do === 'keep') return { chain: c, hash: '(kept)', status: `${KEPT} ${plan.why}, so nothing was regenerated` };
  if (plan.moveAside) aside(c, plan.why ?? '');
  if (UNSIGNED) {
    await writeUnsigned(c);
    return { chain: c, hash: '(unsigned)', status: 'MODULE command written' };
  }
  // Built by the same builder as an unsigned file, so it passes the same proof (lib.ts: proofChain); signed
  // here; recorded once the node's preflight has passed, just before it is submitted.
  const kp = adminKey();
  const now = await chainTime(c);
  const tx = buildUnsignedGasOnly({
    code: SOURCE, data: { ns: NS }, chainId: c, sender: adminAcct, signerPubKey: kp.publicKey,
    gasLimit: MODULE_GAS_LIMIT, creationTime: Math.floor(now.getTime() / 1000) - 15, ttl: DIRECT_TTL,
  });
  const signed = { cmd: tx.cmd, hash: tx.hash, sigs: [{ sig: signHash(tx.hash, kp).sig! }] };
  const landed = await sendBuilt(signed as unknown as ICommand, c, LABEL, () => { record(c, signed); });

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
  for (const f of REFUSED) console.log(`  note: out/unsigned/${NETWORK_ID}/${f.file} proves nothing — ${f.why}`);
  const results: Result[] = [];
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
  const kept = results.filter((r) => r.status.startsWith(KEPT));
  if (kept.length) {
    console.log(`\n  ${kept.length} file(s) kept, for chain(s) ${kept.map((r) => r.chain).join(',')}: nothing was regenerated for them (see the table).`);
    console.log(`  A kept file's command can still land. Move one aside by hand only once you know it cannot.`);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `deploy-${NETWORK_ID}.json`), JSON.stringify({ network: NETWORK_ID, ns: NS, module: MODULE, at: new Date().toISOString(), results }, null, 2) + '\n');
  const lost = results.filter((r) => r.status === LOST_STATUS);
  if (lost.length) {
    console.log(`\n  🔴 LOST: ${lost.map((r) => r.chain).join(',')} — ${MODULE} there was not created by any deploy file in out/unsigned/${NETWORK_ID}/`);
    console.log(`     (no request key of theirs succeeded there), whatever its hash, so no file was written for these chains.`);
    const moved = lost.filter((r) => r.moved);
    if (moved.length) console.log(`     Their deploy files (chain(s) ${moved.map((r) => r.chain).join(',')}) were moved into out/unsigned/${NETWORK_ID}/superseded/, where they still count as proof, so the send glob out/unsigned/${NETWORK_ID}/*.json no longer includes them.`);
    console.log(`     Run npm run preflight. A name in ${NS} is first-come: choose a different module name, or drop these chains.`);
    process.exit(2);
  }
  if (!UNSIGNED && kept.length) throw new Error(`nothing was sent for chain(s) ${kept.map((r) => r.chain).join(',')}: each kept file's command can still land (see the table) — re-run once it has landed or expired`);
  const hashes = new Set(results.map((r) => r.hash));
  if (!UNSIGNED && hashes.size !== 1) throw new Error(`module hash differs across chains: ${[...hashes].join(' ')} — the same source in the same namespace must hash identically`);
  if (!UNSIGNED && hashes.size === 1) console.log(`\nall ${results.length} chains carry module hash ${[...hashes][0]}`);
}
main().catch((e) => { console.error(`\nDEPLOY FAILED: ${e?.message ?? e}`); process.exit(1); });
