import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createApi } from "@/server/http/api";
import { handleGoogle, allowedGoogleUser, type GoogleProvider, type GoogleClaims } from "@/server/auth/google";
import { authMode, googleSettings } from "@/server/auth/mode";
import { client, makeApi, makeTestDb, addPilotUsers, PASSWORD_A, type TestDb } from "./helpers";

const BASE = "https://crm.example.test";
const settings = () => {
  vi.stubEnv("JG_ENV", "local");
  vi.stubEnv("JG_AUTH_MODE", "google");
  vi.stubEnv("JG_APP_URL", BASE);
  vi.stubEnv("GOOGLE_CLIENT_ID", "test.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fiktiv-client-secret");
};
let t: TestDb;
let state = "";
let claim: GoogleClaims;
let exchange: Mock<GoogleProvider["exchange"]>;
let provider: GoogleProvider;

beforeEach(async () => {
  t = await makeTestDb("pglite");
  await addPilotUsers(t.db);
  settings();
  claim = { sub: "google-user-123", email: "pilot.egy@example.test", email_verified: true };
  exchange = vi.fn<GoogleProvider["exchange"]>(async () => claim);
  provider = {
    authorize: async (_settings, flow) => { state = flow.state; return new URL("https://accounts.google.com/o/oauth2/v2/auth?state=" + state); },
    exchange,
  };
});
afterEach(async () => { await t.cleanup(); vi.unstubAllEnvs(); });

async function start() {
  const res = await handleGoogle(new Request(BASE + "/api/auth/google"), t.db, provider);
  expect(res.status).toBe(303);
  return res.headers.get("set-cookie")!.split(";")[0];
}
async function finish(cookie: string, query = "code=test-code&state=" + state) {
  return handleGoogle(new Request(BASE + "/api/auth/google/callback?" + query, { headers: { cookie } }), t.db, provider);
}
const loginError = (res: Response, code: string) => expect(res.headers.get("location")).toBe(BASE + "/?login_error=" + code);

describe("Google-only production authentication", () => {
  it("production never enables password login; incomplete or unsafe Google configuration is rejected", async () => {
    expect(authMode({ JG_ENV: "production", JG_AUTH_MODE: "password" })).toBe("google");
    expect(googleSettings({ JG_ENV: "production", JG_APP_URL: "http://crm.example.test", GOOGLE_CLIENT_ID: "x.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "secret" })).toBeNull();
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const api = createApi(async () => ({ state: "ok", db: t.db, env: "production" }));
    const status = await api(new Request(BASE + "/api/status"));
    expect(status.status).toBe(503);
    expect(await status.json()).toMatchObject({ state: "auth_not_configured", auth: { mode: "google", configured: false } });
    expect((await handleGoogle(new Request(BASE + "/api/auth/google"), t.db, provider)).status).toBe(503);
  });

  it("an allowed verified identity gets an HttpOnly Google session, the same CRM user ID and existing records", async () => {
    const cookie = await start();
    const res = await finish(cookie);
    expect(res.headers.get("location")).toBe(BASE + "/");
    const cookies = res.headers.getSetCookie();
    expect(cookies.join(" ")).toContain("HttpOnly");
    expect(cookies.join(" ")).toContain("Secure");
    expect(cookies.join(" ")).toContain("SameSite=Lax");
    const c = client(makeApi(t.db));
    c.cookie = cookies.find((s) => s.startsWith("__Host-jg_session="))!.split(";")[0].replace("__Host-jg_session=", "jg_session=");
    const me = await c.get("/api/auth/me");
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.user.email).toBe("pilot.egy@example.test");
    const identities = await t.db.system((tx) => tx.query<{ user_id: string }>("select user_id from oauth_identities"));
    expect(identities[0].user_id).toBe(body.user.id);
    const session = await t.db.system((tx) => tx.query<{ auth_method: string }>("select auth_method from sessions"));
    expect(session[0].auth_method).toBe("google");
    const snapshot = await c.get("/api/crm/snapshot");
    expect(snapshot.status).toBe(200);
    loginError(await finish(cookie), "expired");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("unknown or unverified Google users cannot register themselves or create a session", async () => {
    for (const claims of [
      { sub: "outsider", email: "outsider@example.test", email_verified: true },
      { sub: "unverified", email: "pilot.egy@example.test", email_verified: false },
    ]) {
      claim = claims;
      loginError(await finish(await start()), "not_allowed");
    }
    const counts = await t.db.system((tx) => tx.query<{ n: string }>("select count(*) as n from sessions union all select count(*) from oauth_identities"));
    expect(counts.map((x) => Number(x.n))).toEqual([0, 0]);
  });

  it("bad state, missing cookie, expired flow and rejected provider token never create a session", async () => {
    loginError(await finish(await start(), "code=test-code&state=wrong"), "expired");
    expect(exchange).not.toHaveBeenCalled();
    loginError(await finish(""), "expired");
    const expired = await start();
    await t.db.system((tx) => tx.query("update oauth_flows set expires_at = now() - interval '1 second'"));
    loginError(await finish(expired), "expired");
    exchange.mockRejectedValueOnce(new Error("provider rejected ID token"));
    loginError(await finish(await start()), "failed");
    const rows = await t.db.system((tx) => tx.query<{ n: string }>("select count(*) as n from sessions"));
    expect(Number(rows[0].n)).toBe(0);
  });

  it("identity binding is stable and cannot be replaced with another subject using the same email", async () => {
    const user = await allowedGoogleUser(t.db, claim);
    expect(user).not.toBeNull();
    expect(await allowedGoogleUser(t.db, { ...claim, sub: "different-subject" })).toBeNull();
    const renamed = await allowedGoogleUser(t.db, { ...claim, email: "renamed@gmail.com" });
    expect(renamed?.id).toBe(user?.id);
    await t.db.system((tx) => tx.query("update users set active=false where id=$1", [user!.id]));
    expect(await allowedGoogleUser(t.db, claim)).toBeNull();
  });

  it("password login and previously issued password sessions are refused after the Google-only cutover", async () => {
    vi.stubEnv("JG_AUTH_MODE", "password");
    const c = client(makeApi(t.db));
    expect((await c.login("pilot.egy@example.test", PASSWORD_A)).status).toBe(200);
    vi.stubEnv("JG_AUTH_MODE", "google");
    expect((await c.get("/api/crm/snapshot")).status).toBe(401);
    expect((await c.login("pilot.egy@example.test", PASSWORD_A)).status).toBe(403);
  });
});
