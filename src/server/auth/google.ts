import { createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import type { Db } from "../db/types";
import { clientIp, createGoogleSession, sessionCookie, type AuthUser } from "./service";
import { googleSettings, type GoogleSettings } from "./mode";

const ISSUER = "https://accounts.google.com";
const CALLBACK = "/api/auth/google/callback";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const flowName = (secure: boolean) => secure ? "__Host-jg_google_flow" : "jg_google_flow";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
interface Flow { state: string; nonce: string; code_verifier: string }
export interface GoogleClaims { sub: string; email?: string; email_verified?: boolean }
export interface GoogleProvider {
  authorize(settings: GoogleSettings, flow: Flow): Promise<URL>;
  exchange(settings: GoogleSettings, url: URL, flow: Flow): Promise<GoogleClaims>;
}
let cached: { key: string; config: Promise<oidc.Configuration> } | undefined;
async function configuration(settings: GoogleSettings) {
  const key = sha(settings.clientId + settings.clientSecret);
  if (!cached || cached.key !== key) {
    const config = oidc.discovery(new URL(ISSUER), settings.clientId, settings.clientSecret).then((value) => {
      oidc.enableNonRepudiationChecks(value);
      return value;
    });
    cached = { key, config };
    config.catch(() => { if (cached?.config === config) cached = undefined; });
  }
  return cached.config;
}
export function createGoogleProvider(getConfig: (settings: GoogleSettings) => Promise<oidc.Configuration> = configuration): GoogleProvider { return {
  async authorize(settings, flow) {
    const config = await getConfig(settings);
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: settings.origin + CALLBACK, scope: "openid email profile", response_type: "code",
      state: flow.state, nonce: flow.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(flow.code_verifier),
      code_challenge_method: "S256", prompt: "select_account",
    });
  },
  async exchange(settings, url, flow) {
    const config = await getConfig(settings);
    const tokens = await oidc.authorizationCodeGrant(config, url, {
      pkceCodeVerifier: flow.code_verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error("invalid_google_identity");
    return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined, email_verified: claims.email_verified === true };
  },
}; }
export const googleProvider = createGoogleProvider();

function flowCookie(token: string, secure: boolean, clear = false) {
  return `${flowName(secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 600}${secure ? "; Secure" : ""}`;
}
function readFlowCookie(req: Request, secure: boolean) {
  const found = (req.headers.get("cookie") ?? "").split(";").map((x) => x.trim()).find((x) => x.startsWith(flowName(secure) + "="));
  const token = found?.slice(found.indexOf("=") + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/** Only an already active CRM user may bind an identity. Future logins use Google's stable subject, not an email alias. */
export async function allowedGoogleUser(db: Db, claims: GoogleClaims): Promise<AuthUser | null> {
  if (!claims.email_verified || !claims.email || !claims.sub || claims.sub.length > 255) return null;
  const email = claims.email.trim().toLowerCase();
  return db.system(async (tx) => {
    const existing = await tx.query<AuthUser>(
      "select u.id, u.name, u.email from oauth_identities i join users u on u.id = i.user_id where i.issuer = $1 and i.subject = $2 and u.active",
      [ISSUER, claims.sub],
    );
    if (existing[0]) return existing[0];
    // A disabled identity must never be rebound through a different active email.
    const bound = await tx.query("select user_id from oauth_identities where issuer = $1 and subject = $2", [ISSUER, claims.sub]);
    if (bound.length) return null;
    const users = await tx.query<AuthUser>("select id, name, email from users where email = $1 and active for update", [email]);
    const user = users[0];
    if (!user) return null;
    const other = await tx.query<{ subject: string }>("select subject from oauth_identities where issuer = $1 and user_id = $2", [ISSUER, user.id]);
    if (other.length) return null;
    await tx.query("insert into oauth_identities (issuer, subject, user_id) values ($1, $2, $3)", [ISSUER, claims.sub, user.id]);
    return user;
  });
}

export async function handleGoogle(req: Request, db: Db, provider: GoogleProvider = googleProvider): Promise<Response> {
  const settings = googleSettings();
  if (!settings) return Response.json({ error: "google_not_configured" }, { status: 503, headers });
  const secure = settings.origin.startsWith("https:");
  const url = new URL(req.url);
  const callback = url.pathname === CALLBACK;
  if (req.method !== "GET") return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  const fail = (code: string) => new Response(null, { status: 303, headers: { ...headers, Location: `${settings.origin}/?login_error=${code}`, "Set-Cookie": flowCookie("", secure, true) } });
  try {
    if (!callback) {
      const clientKey = sha(clientIp(req));
      const count = await db.system((tx) => tx.query<{ n: string }>("select count(*) as n from oauth_flows where client_key = $1 and created_at > now() - interval '15 minutes'", [clientKey]));
      if (Number(count[0]?.n ?? 0) >= 30) return Response.json({ error: "too_many_attempts" }, { status: 429, headers: { ...headers, "Retry-After": "900" } });
      const token = randomBytes(32).toString("base64url");
      const flow = { state: oidc.randomState(), nonce: oidc.randomNonce(), code_verifier: oidc.randomPKCECodeVerifier() };
      const redirect = await provider.authorize(settings, flow);
      await db.system(async (tx) => {
        await tx.query("delete from oauth_flows where expires_at < now()");
        await tx.query("insert into oauth_flows (token_hash, state, nonce, code_verifier, client_key, expires_at) values ($1,$2,$3,$4,$5,now() + interval '10 minutes')", [sha(token), flow.state, flow.nonce, flow.code_verifier, clientKey]);
      });
      return new Response(null, { status: 303, headers: { ...headers, Location: redirect.href, "Set-Cookie": flowCookie(token, secure) } });
    }
    const token = readFlowCookie(req, secure);
    if (!token) return fail("expired");
    const flows = await db.system((tx) => tx.query<Flow>("delete from oauth_flows where token_hash = $1 and expires_at > now() returning state, nonce, code_verifier", [sha(token)]));
    if (!flows[0] || url.searchParams.get("state") !== flows[0].state) return fail("expired");
    if (url.searchParams.has("error")) return fail("cancelled");
    const callbackUrl = new URL(settings.origin + CALLBACK + url.search);
    const claims = await provider.exchange(settings, callbackUrl, flows[0]);
    const user = await allowedGoogleUser(db, claims);
    if (!user) return fail("not_allowed");
    const session = await createGoogleSession(db, user.id);
    if (!session) return fail("not_allowed");
    const responseHeaders = new Headers({ ...headers, Location: settings.origin + "/" });
    responseHeaders.append("Set-Cookie", flowCookie("", secure, true));
    responseHeaders.append("Set-Cookie", sessionCookie(session.token, secure));
    return new Response(null, { status: 303, headers: responseHeaders });
  } catch {
    // OAuth codes, tokens, profile claims and provider error payloads are never logged.
    return fail("failed");
  }
}
