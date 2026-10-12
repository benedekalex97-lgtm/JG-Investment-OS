import { describe, expect, it } from "vitest";
import { tlsSettings } from "@/server/db/pg-driver";

describe("pg meghajtó TLS-beállítása", () => {
  it("nem helyi hoszthoz mindig ellenőrzött TLS (rejectUnauthorized), az sslmode az URL-ből kikerül (verziófüggetlen)", () => {
    const r = tlsSettings("postgres://u:p%40ss@ep-x.c-8.eu-central-1.aws.neon.tech/jg_os_preview?sslmode=require&channel_binding=require");
    expect(r.ssl).toEqual({ rejectUnauthorized: true });
    expect(r.url).not.toContain("sslmode");
    expect(r.url).toContain("channel_binding=require");
    expect(r.url).toContain("p%40ss");
  });
  it("sslmode nélküli nem helyi URL is ellenőrzött TLS-t kap", () => {
    expect(tlsSettings("postgres://u:p@db.example/x").ssl).toEqual({ rejectUnauthorized: true });
  });
  it("loopback hoszthoz nincs TLS (helyi fejlesztés/teszt)", () => {
    for (const h of ["localhost", "127.0.0.1"]) expect(tlsSettings(`postgres://u@${h}:5432/x`).ssl).toBe(false);
  });
});
