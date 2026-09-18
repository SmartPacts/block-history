// key-backup.ts — an encrypted, password-protected copy of a signing key file, and the drill that
// proves the copy works.
//
// WHY. The feeder's key is generated on the machine that runs it and never leaves it, which is what
// keeps it safe — and also what makes that machine a single point of failure. A dead disk takes the
// account and everything it holds with it, permanently: there is no seed phrase, no recovery,
// nothing to ask anyone for. This makes one file that can be kept somewhere else.
//
//   npm run key-backup -- save    out/feeder-key.json feeder-key.backup
//   npm run key-backup -- check   feeder-key.backup
//   npm run key-backup -- restore feeder-key.backup out/feeder-key.json
//
// `check` is the point. A backup nobody has restored is not a backup — it is a file you HOPE is a
// backup. It decrypts the blob in memory, derives the public key from the secret inside it, and
// confirms it matches the public key the blob names. It writes nothing and prints no secret, so it
// can be run at any time, anywhere, including on the machine you are about to rebuild.
//
// What it never does: print a secret key, take the passphrase from the command line (arguments are
// visible to every process on the machine, and land in a shell history), or write a blob it has not
// just decrypted and compared. If the passphrase is lost the blob is gone — that is the trade, and
// it is the right way round: a backup anyone can read turns one stolen file into a stolen account.
//
// The crypto is Node's own, no dependency: scrypt (N=2^16, r=8, p=1 — about 64 MB and a second of
// work per guess, which is what makes a human passphrase survive an offline attacker) and
// AES-256-GCM. The public key is stored in the clear and bound into the ciphertext as additional
// authenticated data, so two blobs can be told apart without decrypting either, and neither can be
// passed off as the other.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { resolve } from 'node:path';
import { restoreKeyPairFromSecretKey } from '@kadena/cryptography-utils';

const KDF = { name: 'scrypt', N: 65536, r: 8, p: 1, keylen: 32, maxmem: 160 * 1024 * 1024 };
const FORMAT = 'kadena-bot-key-backup/1';
const die = (m: string): never => { console.error(m); process.exit(1); };

// The passphrase is read from the terminal with echo off, and ONLY from a terminal: no argument, no
// environment variable, no pipe. Each of those would leave it somewhere it outlives this run — a
// shell history, a process list, a log. Raw mode is what suppresses the echo; `pending` keeps
// whatever arrived after the newline, so asking twice in a row cannot lose the second answer.
let pending = '';
function passphrase(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) die('this must be run from a terminal: the passphrase is never taken from an argument, a pipe or the environment');
  process.stdout.write(prompt);
  return new Promise<string>((done) => {
    let buf = '';
    const finish = () => {
      process.stdin.setRawMode(false); process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      done(buf);
    };
    const eat = (chunk: string) => {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (c === '\n' || c === '\r' || c === '') { pending = chunk.slice(i + 1); finish(); return true; }
        if (c === '') { process.stdout.write('\n'); process.exit(130); }        // Ctrl-C
        if (c === '' || c === '\b') { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
      return false;
    };
    const onData = (chunk: Buffer | string) => eat(String(chunk));
    const carried = pending; pending = '';
    if (carried && eat(carried)) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

type Keypair = { publicKey: string; secretKey: string };

// This tool is aimed at a key file, whatever wrote it: a bare { publicKey, secretKey } as keygen.ts
// writes, or a pair nested under a name, as other bots write. Find the pair wherever it is rather
// than assuming one shape, and refuse anything else.
function findKey(obj: any): Keypair | null {
  if (obj && typeof obj === 'object') {
    if (typeof obj.publicKey === 'string' && typeof obj.secretKey === 'string') return obj as Keypair;
    for (const v of Object.values(obj)) { const hit = findKey(v); if (hit) return hit; }
  }
  return null;
}
const readKeyFile = (p: string): Keypair => {
  if (!existsSync(p)) die(`no key file at ${p}`);
  const k = findKey(JSON.parse(readFileSync(p, 'utf8')));
  if (!k) die(`${p} holds no { publicKey, secretKey } pair`);
  if (!/^[0-9a-f]{64}$/.test(k!.publicKey)) die(`${p}: public key is not 64 hex characters`);
  return k!;
};
// The one check that makes a restore trustworthy: the secret in hand really does produce the public
// key we expect. Everything else is bookkeeping.
const derives = (secretKey: string, publicKey: string) => {
  try { return restoreKeyPairFromSecretKey(secretKey).publicKey === publicKey; }
  catch { return false; }
};

const [verb, a, b] = process.argv.slice(2);

if (verb === 'save') {
  if (!a) die('usage: npm run key-backup -- save <key-file> [out-file]');
  const src = resolve(a);
  const out = resolve(b ?? `${a.split('/').pop()}.backup`);
  if (existsSync(out)) die(`REFUSING: ${out} already exists. Move it aside if you mean to replace it.`);
  const key = readKeyFile(src);
  if (!derives(key.secretKey, key.publicKey)) die(`${src}: the secret key does not produce its own public key — refusing to back up a file that is already wrong`);

  const p1 = await passphrase('passphrase (nothing is echoed): ');
  if (p1.length < 12) die('use at least 12 characters: this file is the account, and an offline attacker gets unlimited guesses');
  const p2 = await passphrase('again: ');
  if (p1 !== p2) die('the two passphrases differ; nothing was written');

  const salt = randomBytes(32), iv = randomBytes(12);
  const dk = scryptSync(p1, salt, KDF.keylen, KDF);
  const aad = Buffer.from(key.publicKey, 'utf8');
  const c = createCipheriv('aes-256-gcm', dk, iv);
  c.setAAD(aad);
  // The WHOLE FILE, verbatim — not the key pair parsed out of it. One bot reads its key from a
  // named entry and another reads a bare pair; restoring the inner object would produce a file the
  // bot cannot use, and that would only show up on the machine where it is needed. A restore must
  // reproduce what was saved, byte for byte.
  const ct = Buffer.concat([c.update(readFileSync(src, 'utf8'), 'utf8'), c.final()]);
  const blob = {
    format: FORMAT,
    publicKey: key.publicKey, account: `k:${key.publicKey}`,
    kdf: { ...KDF, salt: salt.toString('base64') },
    iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'),
  };

  // Never hand over a blob that has not just been proven to open. This is the same check `check`
  // runs, executed here so that a bad write can never reach the place you keep it.
  const d = createDecipheriv('aes-256-gcm', dk, iv);
  d.setAAD(aad); d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const back = findKey(JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8')));
  if (!back || back.secretKey !== key.secretKey || !derives(back.secretKey, key.publicKey)) die('the blob did not decrypt back to the same key; nothing was written');

  writeFileSync(out, JSON.stringify(blob, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`wrote      ${out} (mode 0600)`);
  console.log(`for        ${blob.account}`);
  console.log('verified   it decrypts back to this key, and the secret inside derives that public key');
  console.log('');
  console.log('Copy it OFF this machine — a backup on the disk it protects is not one — and keep the');
  console.log('passphrase somewhere else again. Then run `check` on the copy where it will live.');

} else if (verb === 'check' || verb === 'restore') {
  if (!a) die(`usage: npm run key-backup -- ${verb} <backup-file>${verb === 'restore' ? ' <key-file>' : ''}`);
  const from = resolve(a);
  if (!existsSync(from)) die(`no backup at ${from}`);
  const blob = JSON.parse(readFileSync(from, 'utf8'));
  if (blob.format !== FORMAT) die(`${from}: not a key backup this tool wrote (format ${blob.format})`);
  console.log(`backup for ${blob.account ?? `k:${blob.publicKey}`}`);
  if (verb === 'restore' && !b) die('usage: npm run key-backup -- restore <backup-file> <key-file>');
  const to = verb === 'restore' ? resolve(b!) : '';
  if (verb === 'restore' && existsSync(to)) die(`REFUSING: ${to} already exists. A running bot may be using it; move it aside yourself.`);

  const dk = scryptSync(await passphrase('passphrase: '), Buffer.from(blob.kdf.salt, 'base64'), blob.kdf.keylen ?? 32, { ...blob.kdf, salt: undefined, maxmem: KDF.maxmem });
  let plain: string;
  try {
    const d = createDecipheriv('aes-256-gcm', dk, Buffer.from(blob.iv, 'base64'));
    d.setAAD(Buffer.from(blob.publicKey, 'utf8'));
    d.setAuthTag(Buffer.from(blob.tag, 'base64'));
    plain = Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    die('WRONG PASSPHRASE, or this file has been altered.\n'
      + 'Those are the only two causes: the ciphertext carries an authentication tag, so a blob\n'
      + 'that has been changed by even one byte fails here exactly as a bad passphrase does.');
  }
  const key = findKey(JSON.parse(plain!));
  if (!key || !derives(key.secretKey, blob.publicKey)) die("decrypted, but the secret inside does not produce this backup's public key — do not trust this file");

  if (verb === 'check') {
    console.log('OK         it opens, and the secret inside derives exactly that public key');
    console.log('           (nothing was written, and no secret was printed)');
  } else {
    writeFileSync(to, plain!, { mode: 0o600, flag: 'wx' });
    console.log(`restored   ${to} (mode 0600) — chown it to the service user, then start the bot`);
  }

} else {
  console.error('usage:');
  console.error('  npm run key-backup -- save    <key-file> [out-file]     encrypt a copy, verified before it is written');
  console.error('  npm run key-backup -- check   <backup-file>             prove it opens — run this on the copy you keep');
  console.error('  npm run key-backup -- restore <backup-file> <key-file>  write the key back on a new machine');
  process.exit(2);
}
