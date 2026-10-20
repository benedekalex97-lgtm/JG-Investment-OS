import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** Jelszó-tárolás: scrypt, egyedi sóval; a paraméterek a hash-ben tárolódnak (később emelhetők). Jelszó soha nem naplózódik. */
const N = 32768, R = 8, P = 1, KEYLEN = 32, MAXMEM = 128 * 1024 * 1024;
export const PASSWORD_MIN_LENGTH = 12;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number, keylen: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password.normalize("NFKC"), salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEYLEN);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/** Ismeretlen e-mail esetén is ugyanannyi munkát végzünk (nem derül ki, hogy létezik-e a fiók). */
export const dummyHash = () => (dummy ??= hashPassword("jg-os-dummy-password-not-a-secret"));

export function passwordPolicyError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `A jelszó legalább ${PASSWORD_MIN_LENGTH} karakter legyen.`;
  if (new Set(password).size < 5) return "A jelszó túl egyszerű.";
  return null;
}
