import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * PostgreSQL SCRAM-SHA-256 jelszó-verifier (a `PASSWORD '...'` helyén a szerver elfogadja az előre kódolt értéket).
 * Így a TISZTA jelszó soha nem kerül a szerverre, az SQL-utasítás szövegébe, a lekérdezés- vagy statisztikai naplókba - csak a verifier.
 * Formátum: SCRAM-SHA-256$<iteráció>:<só b64>$<StoredKey b64>:<ServerKey b64> (RFC 5802 / 7677, ahogy a libpq PQencryptPasswordConn is előállítja).
 * A jelszó ASCII (a SASLprep ekkor azonosság); a hívó ezt ellenőrzi.
 */
export function scramSha256Verifier(password: string, opts: { salt?: Buffer; iterations?: number } = {}): string {
  const salt = opts.salt ?? randomBytes(16);
  const iterations = opts.iterations ?? 4096;
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
