import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "@/server/http/api";
import type { Runtime } from "@/server/db";
import { PASSWORD_A, addPilotUsers, makeApi, makeTestDb, type TestDb } from "./helpers";

const BAD_STATES = ["not_configured", "invalid_config", "environment_mismatch", "schema_missing", "schema_outdated", "unreachable"] as const;

describe("API állapota hibás/hiányzó adatbázis esetén", () => {
  it.each(BAD_STATES)("%s: az állapot-végpont 503, minden más végpont 503 - nincs adat, süti vagy személyes adat", async (state) => {
    const api = createApi(async () => ({ state }) as Runtime);
    const call = (path: string, init?: RequestInit) => api(new Request(`http://localhost:3000${path}`, init));
    const status = await call("/api/status");
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ state });
    for (const path of ["/api/auth/me", "/api/crm/snapshot"]) {
      const r = await call(path);
      expect(r.status, path).toBe(503);
      expect(r.headers.get("set-cookie")).toBeNull();
      expect(await r.json()).toEqual({ state });
    }
    const login = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ email: "a@b.hu", password: "x" }) });
    expect(login.status).toBe(503);
    expect(login.headers.get("set-cookie")).toBeNull();
  });
});

describe("API reverse proxy mögött (Vercel-szerű: HTTPS a peremen, belül továbbított fejlécek)", () => {
  let t: TestDb;
  beforeAll(async () => { t = await makeTestDb("pglite"); await addPilotUsers(t.db); });
  afterAll(async () => { await t.cleanup(); });

  it("az állapot-végpont működő DB-nél 200 és csak a környezet-címkét adja, a környezet-címke nem szivárog személyes adatot", async () => {
    const r = await makeApi(t.db, "preview")(new Request("https://jg-preview.example/api/status"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ state: "ok", environment: "preview", environmentLabel: "ELŐNÉZET (fiktív adat)" });
  });

  it("x-forwarded-proto/host mellett a belépés __Host- előtagú, Secure, HttpOnly, SameSite=Lax sütit ad; az azonos eredetű kérés elfogadott, az idegen elutasított", async () => {
    const api = makeApi(t.db, "preview");
    const headers = { "content-type": "application/json", "x-forwarded-proto": "https", "x-forwarded-host": "jg-preview.example", host: "internal:3000", origin: "https://jg-preview.example" };
    const res = await api(new Request("http://internal:3000/api/auth/login", { method: "POST", headers, body: JSON.stringify({ email: "pilot.egy@example.test", password: PASSWORD_A }) }));
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^__Host-jg_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    expect(set).not.toMatch(/Domain=/i);
    const cookie = set.split(";")[0];
    const me = await api(new Request("http://internal:3000/api/auth/me", { headers: { cookie, "x-forwarded-proto": "https" } }));
    expect(me.status).toBe(200);
    const evil = await api(new Request("http://internal:3000/api/auth/logout", { method: "POST", headers: { ...headers, origin: "https://evil.example", cookie } }));
    expect(evil.status).toBe(403);
    // a HTTP-n (proxy-fejléc nélkül) érkező kérés nem kapja meg a __Host- sütit: nincs hitelesítés
    const plain = await api(new Request("http://internal:3000/api/auth/me", { headers: { cookie } }));
    expect(plain.status).toBe(401);
  });
});
