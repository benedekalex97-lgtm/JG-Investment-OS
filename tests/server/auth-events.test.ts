import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceOf } from "@/server/auth/events";
import { handleGoogle, type GoogleClaims, type GoogleProvider } from "@/server/auth/google";
import { exportBackup, restoreBackup, type Backup } from "@/server/backup";
import { checkSchema, migrate, MIGRATIONS } from "@/server/db/migrate";
import { technicalRetention } from "@/server/privacy/retention-ops";
import { grant } from "./data-helpers";
import { addPilotUsers, client, DRIVERS, makeApi, makeTestDb, PASSWORD_A, PASSWORD_B, type TestDb } from "./helpers";

/**
 * v1.5 belépési napló: eszköz-felismerés, migráció és visszagörgetés, a sikeres / sikertelen belépés és a kilépés rögzítése (jelszó és
 * Google), jogosultság (API és RLS), megőrzés, mentés. Kizárólag fiktív adat.
 */
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const V14 = MIGRATIONS.slice(0, 13);

type Row = { event: string; method: string; user_id: string | null; email: string | null; reason: string | null; device: string | null };
const events = (t: TestDb) => t.db.system((tx) => tx.query<Row>("select event, method, user_id, email, reason, device from auth_events order by id"));

describe("eszköz-felismerés", () => {
  it("böngésző és rendszer durván, verzió nélkül; ismeretlen vagy hiányzó user-agent", () => {
    expect(deviceOf(CHROME_WIN)).toBe("Chrome · Windows");
    expect(deviceOf(SAFARI_IPHONE)).toBe("Safari · iOS (mobil)");
    expect(deviceOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")).toBe("Safari · macOS");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")).toBe("Edge · Windows");
    expect(deviceOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")).toBe("Chrome · Android (mobil)");
    expect(deviceOf("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")).toBe("Firefox · Linux");
    expect(deviceOf("curl/8.0")).toBe("Ismeretlen böngésző · Ismeretlen rendszer");
    expect(deviceOf(null)).toBeUndefined();
  });
});

describe.each(DRIVERS)("v1.5 migráció és visszagörgetés (%s)", (kind) => {
  it("additív; CHECK-ek; az alkalmazás szerepköre közvetlenül nem írhat; a rollback adatvesztés ellen véd, és újra előre alkalmazható", async () => {
    const t = await makeTestDb(kind, { migrate: false });
    const sql15 = readFileSync(join(__dirname, "../../scripts/sql/v1.5-schema-rollback.sql"), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    try {
      await migrate(t.db, { env: "local", migrations: V14 });
      const { a } = await addPilotUsers(t.db);
      expect((await migrate(t.db, { env: "local" })).applied).toEqual(["0014_auth_events"]);
      const rec = (...args: unknown[]) => t.db.system((tx) => tx.query("select auth_record_event($1, $2, $3, $4, $5, $6)", args));
      await rec("login_success", "google", a.id, "Pilot.Egy@Example.TEST", null, "Chrome · Windows");
      // Ismeretlen felhasználó-azonosító nem kerül be (az e-mail igen).
      await rec("login_failure", "google", "u-nincs-ilyen", "idegen@example.test", "not_allowed", null);
      expect(await events(t)).toEqual([
        { event: "login_success", method: "google", user_id: a.id, email: "pilot.egy@example.test", reason: null, device: "Chrome · Windows" },
        { event: "login_failure", method: "google", user_id: null, email: "idegen@example.test", reason: "not_allowed", device: null },
      ]);
      for (const bad of [
        ["login_success", "google", null, null, null, null], // sikeres belépés felhasználó nélkül
        ["login_failure", "google", null, null, null, null], // sikertelen ok nélkül
        ["login_success", "google", a.id, null, "failed", null], // sikeres okkal
        ["hack", "google", a.id, null, null, null],
        ["logout", "sms", a.id, null, null, null],
        ["login_failure", "google", null, null, "egyeb", null],
        ["logout", "google", a.id, "nem email", null, null],
        ["logout", "google", a.id, null, null, "x\ny"],
      ]) await expect(rec(...bad), JSON.stringify(bad)).rejects.toThrow();
      // Az alkalmazás szerepköre (jg_app) közvetlenül nem írhat, nem módosíthat, nem törölhet; jog nélkül nem is olvashat.
      for (const sql of ["insert into auth_events (event, method, user_id) values ('logout', 'google', $1)", "update auth_events set email = null", "delete from auth_events"]) {
        await expect(t.db.asUser(a.id, (tx) => tx.query(sql, sql.includes("$1") ? [a.id] : [])), sql).rejects.toThrow(/permission denied/);
      }
      expect(await t.db.asUser(a.id, (tx) => tx.query("select * from auth_events"))).toEqual([]);
      await grant(t.db, a.email, "crm.settings.audit.read");
      expect(await t.db.asUser(a.id, (tx) => tx.query("select * from auth_events"))).toHaveLength(2);

      // Rollback: bejegyzés mellett megáll; tudatos vállalással a v1.4 sémára áll vissza; újra alkalmazható.
      await expect(t.db.system((tx) => tx.exec(sql15))).rejects.toThrow(/belépési naplóban 2 bejegyzés/);
      expect(await checkSchema(t.db, "local")).toEqual({ ok: true });
      await t.db.system(async (tx) => { await tx.query("select set_config('jg.rollback_discard_auth_events', 'yes', true)"); await tx.exec(sql15); });
      expect(await checkSchema(t.db, "local", V14)).toEqual({ ok: true });
      expect(await t.db.system((tx) => tx.query("select to_regclass('auth_events') as t, to_regprocedure('auth_record_event(text,text,text,text,text,text)') as f"))).toEqual([{ t: null, f: null }]);
      expect((await migrate(t.db, { env: "local" })).applied).toEqual(["0014_auth_events"]);
    } finally {
      await t.cleanup();
    }
  });
});

describe.each(DRIVERS)("belépési napló - jelszavas belépés, API, megőrzés, mentés (%s)", (kind) => {
  let t: TestDb;
  beforeEach(async () => { t = await makeTestDb(kind); });
  afterEach(async () => { await t.cleanup(); });

  it("sikeres belépés, hibás jelszó, ismeretlen e-mail, kilépés - jelszó soha; a túl sok próbálkozás is naplózódik", async () => {
    const { a } = await addPilotUsers(t.db);
    const api = makeApi(t.db);
    const ua = { "user-agent": CHROME_WIN };
    const c = client(api);
    const post = (body: unknown) => api(new Request("http://localhost:3000/api/auth/login", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", ...ua }, body: JSON.stringify(body) }));
    expect((await post({ email: "pilot.egy@example.test", password: "rossz-jelszo-12345" })).status).toBe(401);
    expect((await post({ email: "Nincs.Ilyen@Example.test", password: "rossz-jelszo-12345" })).status).toBe(401);
    expect((await c.login("pilot.egy@example.test", PASSWORD_A)).status).toBe(200);
    expect((await c.post("/api/auth/logout")).status).toBe(200);
    const rows = await events(t);
    expect(rows.map((r) => [r.event, r.method, r.user_id, r.email, r.reason])).toEqual([
      ["login_failure", "password", a.id, "pilot.egy@example.test", "invalid_credentials"],
      ["login_failure", "password", null, "nincs.ilyen@example.test", "invalid_credentials"],
      ["login_success", "password", a.id, "pilot.egy@example.test", null],
      ["logout", "password", a.id, "pilot.egy@example.test", null],
    ]);
    expect(rows[0].device).toBe("Chrome · Windows");
    expect(JSON.stringify(rows)).not.toMatch(/rossz-jelszo|fiktiv-jelszo/);
    // Túl sok sikertelen próbálkozás: 429 és „rate_limited” bejegyzés.
    for (let i = 0; i < 5; i++) await post({ email: "pilot.ketto@example.test", password: "rossz-jelszo-12345" });
    expect((await post({ email: "pilot.ketto@example.test", password: PASSWORD_B })).status).toBe(429);
    expect((await events(t)).at(-1)).toMatchObject({ event: "login_failure", reason: "rate_limited", email: "pilot.ketto@example.test" });
    // Kijelentkezés munkamenet nélkül: nincs bejegyzés.
    const before = (await events(t)).length;
    expect((await client(api).post("/api/auth/logout")).status).toBe(200);
    expect(await events(t)).toHaveLength(before);
  });

  it("a napló olvasása: jog nélkül 403 (és az RLS sem ad sort), joggal a legújabb elöl, szűrés eseményre és felhasználóra, lapozás", async () => {
    const { a, b } = await addPilotUsers(t.db);
    const api = makeApi(t.db);
    const admin = client(api), worker = client(api);
    await worker.login("pilot.ketto@example.test", PASSWORD_B);
    await admin.login("pilot.egy@example.test", PASSWORD_A);
    expect((await admin.get("/api/settings/logins")).status).toBe(403);
    await grant(t.db, "pilot.egy@example.test", "crm.settings.audit.read");
    const res = await admin.get("/api/settings/logins");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { entries: { event: string; userId: string; userName: string; email: string }[]; nextBefore: number | null };
    expect(body.entries.map((e) => [e.event, e.userId, e.userName])).toEqual([["login_success", a.id, "Teszt Pilot Egy"], ["login_success", b.id, "Teszt Pilot Kettő"]]);
    const one = (await (await admin.get(`/api/settings/logins?userId=${b.id}&limit=1`)).json()) as { entries: { userId: string }[]; nextBefore: number | null };
    expect(one.entries.map((e) => e.userId)).toEqual([b.id]);
    const paged = (await (await admin.get("/api/settings/logins?limit=1")).json()) as { entries: unknown[]; nextBefore: number | null };
    expect(paged.entries).toHaveLength(1);
    expect(paged.nextBefore).not.toBeNull();
    expect((await (await admin.get("/api/settings/logins?event=logout")).json()).entries).toEqual([]);
    expect((await admin.get("/api/settings/logins?event=hack")).status).toBe(400);
    expect((await worker.get("/api/settings/logins")).status).toBe(403);
    expect(await t.db.asUser(b.id, (tx) => tx.query("select * from auth_events"))).toEqual([]);
  });

  it("megőrzés: a 12 hónapnál régebbi bejegyzés törölhető, az újabb marad; mentés és visszaállítás", async () => {
    const { a } = await addPilotUsers(t.db);
    await client(makeApi(t.db)).login("pilot.egy@example.test", PASSWORD_A);
    await t.db.system((tx) => tx.query("insert into auth_events (at, event, method, user_id, email) values (now() - interval '13 months', 'logout', 'password', $1, 'pilot.egy@example.test')", [a.id]));
    const settings = { requestLogDays: 30 } as Parameters<typeof technicalRetention>[1]["settings"];
    const preview = await technicalRetention(t.db, { env: "local", settings, apply: false });
    expect(preview.counts.authEvents).toBe(1);
    await technicalRetention(t.db, { env: "local", settings, apply: true, operator: "Teszt Üzemeltető" });
    expect((await events(t)).map((e) => e.event)).toEqual(["login_success"]);

    const backup = JSON.parse(JSON.stringify(await exportBackup(t.db, "local"))) as Backup;
    expect(backup.counts.auth_events).toBe(1);
    const dst = await makeTestDb(kind);
    try {
      await restoreBackup(dst.db, backup, "local");
      expect((await events(dst)).map((e) => [e.event, e.email])).toEqual([["login_success", "pilot.egy@example.test"]]);
      // A sorszám a visszaállítás után folytatódik (nincs kulcsütközés).
      await dst.db.system((tx) => tx.query("select auth_record_event('logout', 'password', $1, null, null, null)", [a.id]));
      expect(await events(dst)).toHaveLength(2);
    } finally { await dst.cleanup(); }
    // A v1.4 (0013) formátumú mentés (belépési napló nélkül) is visszaállítható.
    const old = JSON.parse(JSON.stringify(backup)) as Backup;
    old.migration = "0013_customer_extra_phones";
    delete old.tables.auth_events;
    delete old.counts.auth_events;
    const dst2 = await makeTestDb(kind);
    try {
      await restoreBackup(dst2.db, old, "local");
      expect(await events(dst2)).toEqual([]);
    } finally { await dst2.cleanup(); }
  });
});

describe("belépési napló - Google-belépés", () => {
  const BASE = "https://crm.example.test";
  let t: TestDb;
  let state = "";
  let claim: GoogleClaims;
  let provider: GoogleProvider;
  beforeEach(async () => {
    t = await makeTestDb("pglite");
    await addPilotUsers(t.db);
    vi.stubEnv("JG_ENV", "local");
    vi.stubEnv("JG_AUTH_MODE", "google");
    vi.stubEnv("JG_APP_URL", BASE);
    vi.stubEnv("GOOGLE_CLIENT_ID", "test.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "fiktiv-client-secret");
    claim = { sub: "google-user-123", email: "pilot.egy@example.test", email_verified: true };
    provider = {
      authorize: async (_s, flow) => { state = flow.state; return new URL("https://accounts.google.com/o/oauth2/v2/auth?state=" + state); },
      exchange: vi.fn(async () => claim),
    };
  });
  afterEach(async () => { await t.cleanup(); vi.unstubAllEnvs(); });

  const start = async () => (await handleGoogle(new Request(BASE + "/api/auth/google"), t.db, provider)).headers.get("set-cookie")!.split(";")[0];
  const finish = (cookie: string, query = "code=c&state=" + state) =>
    handleGoogle(new Request(BASE + "/api/auth/google/callback?" + query, { headers: { cookie, "user-agent": SAFARI_IPHONE } }), t.db, provider);

  it("sikeres belépés eszközzel; nem engedélyezett fiók az igazolt e-maillel; megszakítás; hiba; a cookie nélküli visszahívás nem naplózódik; kilépés", async () => {
    const ok = await finish(await start());
    expect(ok.headers.get("location")).toBe(BASE + "/");
    claim = { sub: "google-idegen-1", email: "Idegen@Example.test", email_verified: true };
    expect((await finish(await start())).headers.get("location")).toBe(BASE + "/?login_error=not_allowed");
    claim = { sub: "google-idegen-2", email: "nem.igazolt@example.test", email_verified: false };
    await finish(await start());
    await finish(await start(), "error=access_denied&state=" + state);
    (provider.exchange as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("invalid_grant"));
    expect((await finish(await start())).headers.get("location")).toBe(BASE + "/?login_error=failed");
    // Cookie nélküli / hamis visszahívás: nem azonosítható belépési kísérlet, nem kerül a naplóba.
    await handleGoogle(new Request(BASE + "/api/auth/google/callback?code=x&state=y"), t.db, provider);
    // Kilépés a Google-munkamenetből.
    const sessionCookie = ok.headers.getSetCookie().find((c) => c.startsWith("__Host-jg_session="))!.split(";")[0];
    const api = makeApi(t.db);
    expect((await api(new Request(BASE + "/api/auth/logout", { method: "POST", headers: { origin: BASE, cookie: sessionCookie, "content-type": "application/json" } }))).status).toBe(200);
    const rows = await events(t);
    expect(rows.map((r) => [r.event, r.method, r.email, r.reason])).toEqual([
      ["login_success", "google", "pilot.egy@example.test", null],
      ["login_failure", "google", "idegen@example.test", "not_allowed"],
      ["login_failure", "google", null, "not_allowed"],
      ["login_failure", "google", null, "cancelled"],
      ["login_failure", "google", null, "failed"],
      ["logout", "google", "pilot.egy@example.test", null],
    ]);
    expect(rows[0].device).toBe("Safari · iOS (mobil)");
    expect(rows[0].user_id).not.toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/google-user-123|google-idegen|code=|invalid_grant/);
  });
});
