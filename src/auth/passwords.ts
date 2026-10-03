import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );

// scrypt is memory-hard, so guessing passwords on GPUs is expensive. Parameters are
// stored with each hash, so they can be raised later without breaking old hashes.
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

/** Returns `scrypt$N$r$p$salt$hash`, with salt and hash in base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  // Constant-time comparison, so response timing doesn't reveal how much of the hash matched.
  return timingSafeEqual(actual, expected);
}

/** A real hash of a random password, used to spend the same time on logins for unknown emails. */
export const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));
