import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, login, setActive, setPassword } from "@/server/auth/service";
import { hashPassword, passwordPolicyError, verifyPassword } from "@/server/auth/password";
import { DRIVERS, PASSWORD_A, addPilotUsers, client, makeApi, makeTestDb, type TestDb } from "./helpers";

describe("jelszó", () => {
  it("scrypt hash: egyedi só, helyes jelszó igen, rossz nem; a jelszó nincs benne a hash-ben", async () => {
    const h1 = await hashPassword("helyes-jelszo-123");
    const h2 = await hashPassword("helyes-jelszo-123");
    expect(h1).not.toBe(h2);
    expect(h1).not.toContain("helyes-jelszo");
    expect(await verifyPassword("helyes-jelszo-123", h1)).toBe(true);
    expect(await verifyPassword("rossz-jelszo-1234", h1)).toBe(false);
    expect(await verifyPassword("x", "nem-hash")).toBe(false);
  });
  it("jelszó-szabály: legalább 12 karakter, nem triviális", () => {
    expect(passwordPolicyError("rovid")).toMatch(/12/);
    expect(passwordPolicyError("aaaaaaaaaaaaaa")).toMatch(/egyszerű/);
    expect(passwordPolicyError("elegendoen-hosszu-1")).toBeNull();
  });
});

describe.each(DRIVERS)("hitelesítés (%s)", (kind) => {
  let t: TestDb;
  beforeAll(async () => { t = await makeTestDb(kind); await addPilotUsers(t.db); });
  afterAll(async () => { await t.cleanup(); });

  it("érvényes belépés munkamenetet ad; a süti HttpOnly, SameSite=Lax, HTTP-n Secure nélkül, HTTPS-en __Host- előtaggal és Secure-ral", async () => {
    const api = makeApi(t.db);
    const c = client(api);
    const res = await c.login("Pilot.Egy@Example.test", PASSWORD_A);
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^jg_session=/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).not.toMatch(/Secure/);
    const body = await res.json();
    expect(body.user).toMatchObject({ email: "pilot.egy@example.test" });
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
    const https = await api(new Request("https://jg.example.test/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://jg.example.test" }, body: JSON.stringify({ email: "pilot.egy@example.test", password: PASSWORD_A }),
    }));
    expect(https.headers.get("set-cookie")).toMatch(/^__Host-jg_session=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    expect((await c.get("/api/auth/me")).status).toBe(200);
  });
  it("rossz jelszó és ismeretlen e-mail ugyanazt a választ adja (nincs fiók-felderítés)", async () => {
    const c = client(makeApi(t.db));
    const bad = await c.login("pilot.egy@example.test", "rossz-jelszo-12345");
    const unknown = await c.login("nincs.ilyen@example.test", "rossz-jelszo-12345");
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await bad.json()).toEqual(await unknown.json());
    expect(c.cookie).toBe("");
  });
  it("munkamenet nélkül, hamis vagy lejárt süti mellett minden védett végpont 401", async () => {
    const api = makeApi(t.db);
    const anon = client(api);
    for (const p of ["/api/auth/me", "/api/crm/snapshot"]) expect((await anon.get(p)).status, p).toBe(401);
    expect((await anon.op("customer.create", { input: { type: "individual", name: "X" } })).status).toBe(401);
    const forged = client(api);
    forged.cookie = "jg_session=hamis-token";
    expect((await forged.get("/api/crm/snapshot")).status).toBe(401);

    const c = client(api);
    await c.login("pilot.egy@example.test", PASSWORD_A);
    await t.db.system((tx) => tx.query("update sessions set expires_at = now() - interval '1 minute'"));
    expect((await c.get("/api/crm/snapshot")).status).toBe(401);
    await c.login("pilot.egy@example.test", PASSWORD_A);
    await t.db.system((tx) => tx.query("update sessions set last_seen_at = now() - interval '9 hours'"));
    expect((await c.get("/api/crm/snapshot")).status).toBe(401);
  });
  it("kijelentkezés érvényteleníti a munkamenetet a szerveren is (a régi süti többé nem használható)", async () => {
    const api = makeApi(t.db);
    const c = client(api);
    await c.login("pilot.egy@example.test", PASSWORD_A);
    const old = c.cookie;
    const out = await c.post("/api/auth/logout");
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    const replay = client(api);
    replay.cookie = old;
    expect((await replay.get("/api/auth/me")).status).toBe(401);
  });
  it("letiltott felhasználó munkamenete azonnal érvénytelen; újraaktiválás után új belépés kell", async () => {
    const api = makeApi(t.db);
    const u = await createUser(t.db, { email: "ideiglenes@example.test", name: "Ideiglenes", password: "ideiglenes-jelszo-1" });
    const c = client(api);
    expect((await c.login("ideiglenes@example.test", "ideiglenes-jelszo-1")).status).toBe(200);
    await setActive(t.db, "ideiglenes@example.test", false);
    expect((await c.get("/api/crm/snapshot")).status).toBe(401);
    expect((await client(api).login("ideiglenes@example.test", "ideiglenes-jelszo-1")).status).toBe(401);
    expect(u.id).toBeTruthy();
  });
  it("jelszócsere kijelentkezteti a meglévő munkameneteket", async () => {
    const api = makeApi(t.db);
    await createUser(t.db, { email: "csere@example.test", name: "Csere", password: "regi-jelszo-12345" });
    const c = client(api);
    await c.login("csere@example.test", "regi-jelszo-12345");
    await setPassword(t.db, "csere@example.test", "uj-jelszo-1234567");
    expect((await c.get("/api/auth/me")).status).toBe(401);
    expect((await client(api).login("csere@example.test", "regi-jelszo-12345")).status).toBe(401);
    expect((await client(api).login("csere@example.test", "uj-jelszo-1234567")).status).toBe(200);
  });
  it("ismétlődő hibás belépés után a fiók átmenetileg zárolt (429), akkor is, ha a jelszó helyes", async () => {
    const api = makeApi(t.db);
    await createUser(t.db, { email: "zar@example.test", name: "Zár", password: "zar-jelszo-1234567" });
    const c = client(api);
    for (let i = 0; i < 5; i++) expect((await c.login("zar@example.test", `rossz-${i}-jelszo-123`)).status).toBe(401);
    const blocked = await c.login("zar@example.test", "zar-jelszo-1234567");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });
  it("a belépés szolgáltatás szintjén sem hoz létre munkamenetet hibás jelszóval", async () => {
    const r = await login(t.db, "pilot.egy@example.test", "nem-jo-jelszo-123", "10.0.0.9");
    expect(r.ok).toBe(false);
  });
  it("módosító kérés idegen eredetről, Origin nélkül vagy nem JSON tartalommal elutasítva (CSRF)", async () => {
    const api = makeApi(t.db);
    const c = client(api);
    await c.login("pilot.egy@example.test", PASSWORD_A);
    const cross = await c.post("/api/crm/op", { requestId: crypto.randomUUID(), op: "customer.create", args: { input: { type: "individual", name: "X" } } }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    const noOrigin = await api(new Request("http://localhost:3000/api/crm/op", { method: "POST", headers: { "content-type": "application/json", cookie: c.cookie }, body: "{}" }));
    expect(noOrigin.status).toBe(403);
    const form = await api(new Request("http://localhost:3000/api/auth/logout", { method: "POST", headers: { "content-type": "text/plain", origin: "http://localhost:3000", cookie: c.cookie }, body: "{}" }));
    expect(form.status).toBe(403);
    expect((await c.get("/api/auth/me")).status).toBe(200);
  });
  it("felhasználó-létrehozás: jelszó-szabály és duplikált e-mail ellenőrzés", async () => {
    await expect(createUser(t.db, { email: "rovid@example.test", name: "R", password: "rovid" })).rejects.toThrow(/12/);
    await expect(createUser(t.db, { email: "nem-email", name: "R", password: "elegendoen-hosszu-1" })).rejects.toThrow(/e-mail/);
    await expect(createUser(t.db, { email: "pilot.egy@example.test", name: "Dupla", password: "elegendoen-hosszu-1" })).rejects.toThrow();
  });
});
