import { describe, expect, it } from "vitest";
import { BUILTIN_CRM_CONFIG, channelLabel, findChannel, isSelectableChannel, UNKNOWN_CHANNEL_KEY } from "@/domain/config";
import { evaluateRow, mappingProblems, resolveChannel, suggestMapping, type ColumnMapping } from "@/domain/data-import";
import { customerHistory } from "@/domain/history";
import { channelReport, searchCustomers } from "@/domain/logic";
import { emptySnapshot } from "@/domain/types";
import { U, errs, newRepo, tickRepo, val } from "./helpers";

/** v1.2: érkezési csatorna - tartományi szabályok (kötelező választás, aktív elem, előzmény, szűrés, kimutatás, import-feloldás). Fiktív adat. */
const person = { type: "individual", name: "Csatorna Csilla", acquisitionChannel: "weboldal", recordedBy: U } as const;
const fmt = (iso?: string) => (iso ? iso.slice(0, 10) : "—");

describe("katalógus (beépített kezdő elemek)", () => {
  const ch = BUILTIN_CRM_CONFIG.acquisitionChannels;
  it("a 12 kezdő elem a megadott kulccsal és megnevezéssel; csak az `ismeretlen` rendszerelem", () => {
    expect(ch.map((c) => [c.key, c.label])).toEqual([
      ["weboldal", "Weboldal (közvetlen kapcsolatfelvétel)"], ["google_kereses", "Google-keresés"], ["google_cegprofil", "Google Cégprofil"], ["facebook", "Facebook"],
      ["linkedin", "LinkedIn"], ["bemutatkozo_level", "Bemutatkozó levél"], ["ajanlas", "Ajánlás (ügyfél vagy ismerős)"], ["szemelyes_ismeretseg", "Személyes ismeretség"],
      ["kh_ertekpapir", "K&H Értékpapír közvetítése"], ["rendezveny", "Rendezvény, előadás"], ["egyeb", "Egyéb"], ["ismeretlen", "Ismeretlen"],
    ]);
    expect(ch.filter((c) => c.isSystem).map((c) => c.key)).toEqual([UNKNOWN_CHANNEL_KEY]);
    expect(channelLabel(BUILTIN_CRM_CONFIG, "weboldal")).toBe("Weboldal (közvetlen kapcsolatfelvétel)");
    expect(channelLabel(BUILTIN_CRM_CONFIG, "kivezetett")).toBe("kivezetett");
    expect(findChannel(BUILTIN_CRM_CONFIG, "nincs")).toBeUndefined();
  });
});

describe("új ügyfél: az érkezési csatorna kötelező választás", () => {
  it("hiányzó vagy üres csatorna elutasítva, alapértelmezés nincs; az `ismeretlen` kifejezetten választható", () => {
    const r = newRepo(emptySnapshot());
    const { acquisitionChannel: _omit, ...without } = person;
    void _omit;
    expect(errs(r.createCustomerFromForm(without)).acquisitionChannel).toMatch(/kötelező/);
    expect(errs(r.createCustomerFromForm({ ...person, acquisitionChannel: "" })).acquisitionChannel).toMatch(/kötelező/);
    expect(r.getSnapshot().customers).toHaveLength(0);
    expect(val(r.createCustomerFromForm({ ...person, acquisitionChannel: "ismeretlen" })).customer.acquisitionChannel).toBe("ismeretlen");
  });

  it("csak aktív, létező csatorna; a részlet opcionális, legfeljebb 200 karakter, vezérlőkarakter nélkül", () => {
    const snap = emptySnapshot();
    snap.config.acquisitionChannels = snap.config.acquisitionChannels.map((c) => (c.key === "facebook" ? { ...c, isActive: false } : c));
    const r = newRepo(snap);
    expect(errs(r.createCustomerFromForm({ ...person, acquisitionChannel: "facebook" })).acquisitionChannel).toMatch(/nem választható/);
    expect(errs(r.createCustomerFromForm({ ...person, acquisitionChannel: "nincs_ilyen" })).acquisitionChannel).toMatch(/nem választható/);
    expect(errs(r.createCustomerFromForm({ ...person, acquisitionDetail: "x".repeat(201) })).acquisitionDetail).toMatch(/200/);
    expect(errs(r.createCustomerFromForm({ ...person, acquisitionDetail: "sor\ntörés" })).acquisitionDetail).toMatch(/vezérlőkarakter/);
    const ok = val(r.createCustomerFromForm({ ...person, acquisitionDetail: "  TBSZ-útmutató  " })).customer;
    expect(ok).toMatchObject({ acquisitionChannel: "weboldal", acquisitionDetail: "TBSZ-útmutató" });
    expect(val(r.createCustomerFromForm({ ...person, name: "Részlet Nélkül" })).customer.acquisitionDetail).toBeUndefined();
    expect(val(r.createCustomerFromForm({ ...person, name: "Üres Részlet", acquisitionDetail: "   " })).customer.acquisitionDetail).toBeUndefined();
    expect(isSelectableChannel(snap.config, "facebook")).toBe(false);
  });

  it("a `source` (adat eredete) független és változatlan: a csatorna nem írja át, és fordítva", () => {
    const r = newRepo(emptySnapshot());
    const c = val(r.createCustomerFromForm({ ...person, source: "Fiktív import" })).customer;
    expect(c).toMatchObject({ source: "Fiktív import", acquisitionChannel: "weboldal" });
    const up = val(r.updateCustomer(c.id, { type: "individual", name: "Csatorna Csilla", acquisitionChannel: "ajanlas" }, U));
    expect(up).toMatchObject({ source: "Fiktív import", acquisitionChannel: "ajanlas" });
    const back = val(r.updateCustomer(c.id, { type: "individual", name: "Csatorna Csilla", source: "Másik forrás" }, U));
    expect(back).toMatchObject({ source: "Másik forrás", acquisitionChannel: "ajanlas" });
  });
});

describe("ügyfél-adatlap: módosítás és ügyféltörténet (ki, mikor, régi → új)", () => {
  const setup = () => {
    const r = tickRepo(emptySnapshot());
    const c = val(r.createCustomerFromForm({ ...person, acquisitionDetail: "első megkeresés" })).customer;
    return { r, c };
  };
  const hist = (r: ReturnType<typeof setup>["r"], id: string) => customerHistory(r.getSnapshot(), id, fmt).filter((h) => h.title === "Érkezési csatorna módosítva");

  it("a csatorna- és részlet-módosítás előzménybejegyzést ír a módosítóval; a bejegyzés régi → új értéket mutat", () => {
    const { r, c } = setup();
    val(r.updateCustomer(c.id, { type: "individual", name: "Csatorna Csilla", acquisitionChannel: "bemutatkozo_level", acquisitionDetail: "bemutatkozó levél, 2026. nov." }, "user-2"));
    const [e] = hist(r, c.id);
    expect(e.recordedBy).toBe("user-2");
    expect(e.details).toEqual([
      { label: "Korábbi érkezési csatorna", value: "Weboldal (közvetlen kapcsolatfelvétel)" }, { label: "Új érkezési csatorna", value: "Bemutatkozó levél" },
      { label: "Korábbi részlet", value: "első megkeresés" }, { label: "Új részlet", value: "bemutatkozó levél, 2026. nov." },
    ]);
    const act = r.getSnapshot().activities.find((a) => a.type === "acquisition_change")!;
    expect(act.meta).toMatchObject({ fromAcquisitionChannel: "weboldal", toAcquisitionChannel: "bemutatkozo_level", fromAcquisitionDetail: "első megkeresés", toAcquisitionDetail: "bemutatkozó levél, 2026. nov." });
    expect(act.summary).toContain("→");
  });

  it("csak a részlet változik / törlődik: külön bejegyzés, a csatorna sora nélkül; változatlan mentés nem naplóz", () => {
    const { r, c } = setup();
    const same = { type: "individual" as const, name: "Csatorna Csilla", acquisitionChannel: "weboldal", acquisitionDetail: "első megkeresés" };
    val(r.updateCustomer(c.id, same, U));
    expect(hist(r, c.id)).toHaveLength(0);
    val(r.updateCustomer(c.id, { ...same, acquisitionDetail: "" }, U));
    const [e] = hist(r, c.id);
    expect(e.details).toEqual([{ label: "Korábbi részlet", value: "első megkeresés" }, { label: "Új részlet", value: "törölve" }]);
    expect(r.getSnapshot().customers[0].acquisitionDetail).toBeUndefined();
    // Hiányzó mező = változatlan (régi kliens): a csatorna és a részlet megmarad.
    val(r.updateCustomer(c.id, { type: "individual", name: "Csatorna Csilla (átírt)" }, U));
    expect(r.getSnapshot().customers[0]).toMatchObject({ acquisitionChannel: "weboldal" });
    expect(hist(r, c.id)).toHaveLength(1);
  });

  it("módosítás csak aktív csatornára; az archivált csatornán lévő ügyfél más adata változatlan csatornával menthető; rögzítő nélkül nincs csatornamódosítás", () => {
    const { r, c } = setup();
    const snap = r.getSnapshot();
    snap.config.acquisitionChannels = snap.config.acquisitionChannels.map((x) => (x.key === "linkedin" || x.key === "weboldal" ? { ...x, isActive: false } : x));
    const base = { type: "individual" as const, name: "Csatorna Csilla" };
    expect(errs(r.updateCustomer(c.id, { ...base, acquisitionChannel: "linkedin" }, U)).acquisitionChannel).toMatch(/nem választható/);
    expect(errs(r.updateCustomer(c.id, { ...base, acquisitionChannel: "nincs" }, U)).acquisitionChannel).toMatch(/nem választható/);
    expect(val(r.updateCustomer(c.id, { ...base, name: "Csatorna Csilla Új", acquisitionChannel: "weboldal" }, U)).acquisitionChannel).toBe("weboldal");
    expect(errs(r.updateCustomer(c.id, { ...base, acquisitionChannel: "facebook" }))._form).toMatch(/rögzítő/);
    expect(r.getSnapshot().customers[0].acquisitionChannel).toBe("weboldal");
    // Archivált csatorna neve az előzményben is a katalógusé (nincs kitalált név).
    val(r.updateCustomer(c.id, { ...base, acquisitionChannel: "facebook" }, U));
    expect(customerHistory(r.getSnapshot(), c.id, fmt)[0].details[0]).toEqual({ label: "Korábbi érkezési csatorna", value: "Weboldal (közvetlen kapcsolatfelvétel)" });
  });
});

describe("ügyféllista szűrése és „Csatornák” kimutatás", () => {
  const T = (d: string) => `${d}T10:00:00.000Z`;
  const build = () => {
    const snap = emptySnapshot();
    const mk = (id: string, channel: string, status: string | undefined, createdAt: string) => snap.customers.push({
      id, type: "individual", firstName: "F", lastName: id, displayName: `${id} F`, contactStatus: "prospect", ...(status ? { crmStatus: status } : {}), ownerId: U, source: "",
      acquisitionChannel: channel, verificationStatus: "demo", createdAt, updatedAt: createdAt,
    });
    mk("a1", "weboldal", undefined, T("2026-10-01"));
    mk("a2", "weboldal", "meeting", T("2026-10-15"));
    mk("a3", "weboldal", "capital_placed", T("2026-11-10"));
    mk("b1", "ajanlas", "contact", T("2026-10-20"));
    mk("c1", "ismeretlen", "lost", T("2026-09-01"));
    mk("d1", "kivezetett_kulcs", "contact", T("2026-10-02"));
    snap.config.acquisitionChannels = snap.config.acquisitionChannels.map((x) => (x.key === "linkedin" ? { ...x, isActive: false } : x));
    mk("e1", "linkedin", undefined, T("2026-10-05"));
    return snap;
  };

  it("szűrés csatornára (a keresővel és a többi szűrővel kombinálható)", () => {
    const snap = build();
    expect(searchCustomers(snap, { acquisitionChannel: "weboldal" }).map((c) => c.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(searchCustomers(snap, { acquisitionChannel: "weboldal", crmStatus: "meeting" }).map((c) => c.id)).toEqual(["a2"]);
    expect(searchCustomers(snap, { acquisitionChannel: "linkedin" }).map((c) => c.id)).toEqual(["e1"]);
    expect(searchCustomers(snap, { acquisitionChannel: "" })).toHaveLength(7);
    expect(searchCustomers(snap, { acquisitionChannel: "nincs" })).toHaveLength(0);
  });

  it("csatornánként az ügyfelek száma státuszonként bontva; a hiányzó státusz az alapértelmezett (Feldolgozásra vár)", () => {
    const rep = channelReport(build());
    const row = (k: string) => rep.rows.find((r) => r.channel === k)!;
    expect(row("weboldal")).toMatchObject({ total: 3, byStatus: { waiting_for_contact: 1, meeting: 1, capital_placed: 1 } });
    expect(row("ajanlas")).toMatchObject({ total: 1, byStatus: { contact: 1 } });
    expect(row("ismeretlen")).toMatchObject({ total: 1, byStatus: { lost: 1 } });
    expect(row("kivezetett_kulcs")).toMatchObject({ total: 1, label: "kivezetett_kulcs" });
    expect(row("linkedin")).toMatchObject({ total: 1 });
    expect(rep.totals).toEqual({ total: 7, byStatus: { waiting_for_contact: 2, meeting: 1, capital_placed: 1, contact: 2, lost: 1 } });
    expect(rep.rows.reduce((n, r) => n + r.total, 0)).toBe(rep.totals.total);
    // Aktív, de üres csatorna is látszik; archivált csak ha van ügyfele.
    expect(row("facebook")).toMatchObject({ total: 0 });
    expect(rep.statuses.map((s) => s.key)).toEqual(BUILTIN_CRM_CONFIG.statuses.map((s) => s.key));
    const empty = channelReport(emptySnapshot());
    expect(empty.rows.every((r) => r.def?.isActive)).toBe(true);
    expect(empty.totals.total).toBe(0);
  });

  it("időszakszűrő a létrehozás napja szerint (budapesti nap, mindkét végpont beleértve)", () => {
    const snap = build();
    const t = (f: Parameters<typeof channelReport>[1]) => channelReport(snap, f).totals.total;
    expect(t({ from: "2026-10-01", to: "2026-10-31" })).toBe(5);
    expect(t({ from: "2026-10-15", to: "2026-10-15" })).toBe(1);
    expect(t({ from: "2026-11-01" })).toBe(1);
    expect(t({ to: "2026-09-30" })).toBe(1);
    expect(t({ from: "2027-01-01" })).toBe(0);
    // Budapest-határ: 2026-10-14 23:30 UTC már október 15. (CEST), 2026-10-31 23:30 UTC már november 1. (CET).
    const edge = build();
    edge.customers[0].createdAt = "2026-10-14T22:30:00.000Z";
    edge.customers[1].createdAt = "2026-10-31T23:30:00.000Z";
    expect(channelReport(edge, { from: "2026-10-15", to: "2026-10-15" }).rows.find((r) => r.channel === "weboldal")!.total).toBe(1);
    expect(channelReport(edge, { to: "2026-10-31" }).rows.find((r) => r.channel === "weboldal")!.total).toBe(1);
  });
});

describe("import: érkezési csatorna oszlop", () => {
  const cfg = BUILTIN_CRM_CONFIG.acquisitionChannels;
  const M: ColumnMapping = ["type", "fullName", "email", "acquisitionChannel"];
  const row = (channel: string) => ["Magánszemély", "Import Imre", "imre@example.test", channel];

  it("az oszlopnév felismerhető; megnevezés és kulcs is feloldható (kis-/nagybetű és ékezet nélkül)", () => {
    expect(suggestMapping(["Ügyféltípus", "Név", "Érkezési csatorna"])).toEqual(["type", "fullName", "acquisitionChannel"]);
    expect(mappingProblems(M, null)).toEqual([]);
    expect(resolveChannel(cfg, "GOOGLE-KERESÉS")).toEqual({ key: "google_kereses" });
    expect(resolveChannel(cfg, "bemutatkozo_level")).toEqual({ key: "bemutatkozo_level" });
    expect(resolveChannel(cfg, "Ajánlás (ügyfél vagy ismerős)")).toEqual({ key: "ajanlas" });
    expect(resolveChannel(cfg, "Hirdetés")).toEqual({ problem: "unknown" });
  });

  it("ismert érték átvétele; hiányzó érték csendben `ismeretlen`; felismerhetetlen vagy archivált érték `ismeretlen` + figyelmeztetés", () => {
    expect(evaluateRow(row("LinkedIn"), M, null).draft?.acquisitionChannel).toBe("linkedin");
    const blank = evaluateRow(row(""), M, null);
    expect(blank.status).toBe("valid");
    expect(blank.draft?.acquisitionChannel).toBe("ismeretlen");
    const unknown = evaluateRow(row("Hirdetés"), M, null);
    expect(unknown.status).toBe("warning");
    expect(unknown.issues.map((i) => i.code)).toEqual(["unknown_channel"]);
    expect(unknown.draft?.acquisitionChannel).toBe("ismeretlen");
    const archived = evaluateRow(row("Facebook"), M, null, () => ({}), cfg.map((c) => (c.key === "facebook" ? { ...c, isActive: false } : c)));
    expect(archived.issues.map((i) => i.code)).toEqual(["channel_archived"]);
    expect(archived.draft?.acquisitionChannel).toBe("ismeretlen");
    // Oszlop nélkül (régi fájl): változatlan viselkedés, nincs figyelmeztetés, alapérték `ismeretlen`.
    const old = evaluateRow(["Magánszemély", "Import Imre", "imre@example.test"], ["type", "fullName", "email"], null);
    expect(old.status).toBe("valid");
    expect(old.draft?.acquisitionChannel).toBe("ismeretlen");
  });
});
