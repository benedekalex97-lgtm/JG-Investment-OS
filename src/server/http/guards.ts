/**
 * Közös HTTP-védelmek (CSRF, korlátozott törzsolvasás). A CSRF-szabály: a módosító kérés csak azonos eredetű lehet (Origin vagy
 * Sec-Fetch-Site), és a megadott tartalomtípusú (JSON, illetve a fájlfeltöltésnél multipart/form-data).
 */
export function csrfProblem(req: Request, contentType: "json" | "multipart" = "json"): string | null {
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin) {
    let ok = origin === url.origin;
    try {
      ok = ok || (host !== null && new URL(origin).host === host);
    } catch {
      ok = false;
    }
    if (!ok) return "cross_origin";
  } else if (!["same-origin", "none"].includes(req.headers.get("sec-fetch-site") ?? "")) return "missing_origin";
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType === "json" && !ct.startsWith("application/json")) return "bad_content_type";
  if (contentType === "multipart" && !ct.startsWith("multipart/form-data")) return "bad_content_type";
  return null;
}

/** A kérés törzse legfeljebb `max` bájtig; nagyobb törzsnél (vagy hibás Content-Length-nél) null - a túllépő részt nem olvassa be. */
export async function readBodyLimited(req: Request, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
