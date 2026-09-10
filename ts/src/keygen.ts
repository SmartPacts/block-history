// keygen.ts — create a NEW signing key file, and refuse to overwrite one that already exists.
//
// Overwriting a funded key file loses control of whatever that account holds, permanently, so
// this never does it: the existence check is backed by an exclusive-create write ('wx'), which
// also fails if a file appears between the check and the write. The file is 0600 inside a 0700
// directory. Only the PUBLIC key and the account are printed; the secret never leaves the file.
//
//   npm run keygen -- out/feeder-key.json
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { genKeyPair } from '@kadena/cryptography-utils';

const target = process.argv[2];
if (!target) {
  console.error('usage: npm run keygen -- <path/to/new-key.json>');
  process.exit(2);
}
const path = resolve(target);
if (existsSync(path)) {
  console.error(`REFUSING: ${path} already exists. Overwriting a key file loses control of the account it funds.`);
  console.error('Move it aside yourself if you are certain it holds nothing, then run this again.');
  process.exit(1);
}
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const kp = genKeyPair();
if (!kp.secretKey || !/^[0-9a-f]{64}$/.test(kp.publicKey)) {
  console.error('key generation returned an unexpected shape; nothing was written');
  process.exit(1);
}
writeFileSync(path, JSON.stringify({ publicKey: kp.publicKey, secretKey: kp.secretKey }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(`key file   : ${path} (mode 0600)`);
console.log(`public key : ${kp.publicKey}`);
console.log(`account    : k:${kp.publicKey}`);
