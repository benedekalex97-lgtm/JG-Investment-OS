import { DEMO_USERS } from "@/domain/constants";
import { DemoRepository, type Result } from "./repository";
import { emptySnapshot, type CallOutcome, type DataSnapshot, type ProcessStatus, type ProcessType } from "@/domain/types";

/**
 * KIZÁRÓLAG FIKTÍV DEMÓADAT. Minden név, telefonszám és e-mail kitalált; az e-mail-címek a fenntartott `.example` TLD-t használják.
 * Nincs valós pénzügyi adat. A szolgáltatói mérföldkövek SZIMULÁLTAK.
 *
 * A seedet a valódi repository-műveletekkel építjük fel (órával léptetve), így a státusz-, igazolási és aktivitásnapló
 * szabályai ugyanazok, mint élesben, és a napló mindig konzisztens az állapottal.
 */
const [U1, U2] = [DEMO_USERS[0].id, DEMO_USERS[1].id];

function must<T>(r: Result<T>, label: string): T {
  if (!r.ok) throw new Error(`Seed hiba (${label}): ${JSON.stringify(r.errors)}`);
  return r.value;
}

const FULL_PATH: Record<ProcessType, ProcessStatus[]> = {
  inbound_inquiry: ["contact_in_progress", "contact_established", "interest_identified", "needs_assessment", "account_prep", "account_opening", "account_opened", "awaiting_first_deposit", "first_deposit_verified"],
  outbound_outreach: ["contact_in_progress", "contact_established", "interest_identified", "needs_assessment", "account_prep", "account_opening", "account_opened", "awaiting_first_deposit", "first_deposit_verified"],
};

export function createSeedData(now: Date = new Date()): DataSnapshot {
  let clock = now;
  const counters: Record<string, number> = {};
  const repo = new DemoRepository(emptySnapshot(), {
    clock: () => clock,
    idGen: (prefix) => `${prefix}-${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`,
  });
  /** A seed-idő beállítása: `days` nappal a mai nap előtt (negatív = múlt), adott órában. */
  const at = (days: number, hour = 10) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0);
  const setClock = (days: number, hour = 10) => { clock = at(days, hour); };

  const individual = (days: number, lastName: string, firstName: string, owner: string, extra: { phone?: string; notes?: string; source?: string } = {}) => {
    setClock(days);
    const slug = `${firstName}.${lastName}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z.]/g, "");
    return must(repo.createCustomer({ type: "individual", firstName, lastName, ownerId: owner, email: `${slug}@minta-ugyfel.example`, phone: extra.phone, notes: extra.notes, source: extra.source ?? "fiktív demó" }), lastName);
  };
  const company = (days: number, companyName: string, owner: string, source = "fiktív demó", withContact = true) => {
    setClock(days);
    return must(repo.createCustomer({ type: "company", companyName, ownerId: owner, email: withContact ? `iroda-${counters.cust ?? 0}@minta-ceg.example` : undefined, phone: withContact ? `+36 1 555 02${String(counters.cust ?? 0).padStart(2, "0")}` : undefined, source }), companyName);
  };
  const contact = (companyId: string, last: string, first: string, position: string | undefined, primary = false) =>
    must(repo.addContact(companyId, { firstName: first, lastName: last, position, email: `${last}.${first}@minta-ceg.example`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""), phone: `+36 20 555 03${String((counters.kont ?? 0) + 10)}`, isPrimaryContact: primary }), last);
  const process = (days: number, customerId: string, type: ProcessType, title: string, owner: string, opts: { contactId?: string; channel?: "phone" | "email" | "web_form" | "referral" | "in_person" | "other"; source?: "contact_database" | "web_inquiry" | "referral" | "existing_customer" | "other" } = {}) => {
    setClock(days);
    return must(repo.createProcess({ customerId, companyContactId: opts.contactId, type, title, channel: opts.channel ?? (type === "inbound_inquiry" ? "web_form" : "phone"), source: opts.source ?? (type === "inbound_inquiry" ? "web_inquiry" : "contact_database"), ownerId: owner, recordedBy: owner }), title);
  };
  /** Státuszok lépésenkénti bejárása (a szolgáltatói mérföldköveknél szimulált igazolással). */
  const advance = (procId: string, type: ProcessType, until: ProcessStatus, startDay: number, by: string) => {
    let day = startDay;
    for (const to of FULL_PATH[type]) {
      setClock(day);
      const milestone = to === "account_opening" || to === "account_opened" || to === "first_deposit_verified";
      must(repo.changeProcessStatus(procId, { toStatus: to, recordedBy: by, verification: milestone ? { sourceCategory: "provider_notification", complianceAcknowledged: true } : undefined }), `${procId}→${to}`);
      day += 1;
      if (to === until) break;
    }
  };
  const call = (days: number, hour: number, customerId: string, procId: string, outcome: CallOutcome, summary: string, by: string, contactId?: string) => {
    setClock(days, hour);
    must(repo.createActivity({ customerId, processId: procId, companyContactId: contactId, type: "call", summary, occurredAt: at(days, hour).toISOString(), recordedBy: by, callOutcome: outcome }), summary);
  };
  const note = (days: number, hour: number, type: "note" | "meeting" | "follow_up", customerId: string, procId: string | undefined, summary: string, by: string, contactId?: string) => {
    setClock(days, hour);
    must(repo.createActivity({ customerId, processId: procId, companyContactId: contactId, type, summary, occurredAt: at(days, hour).toISOString(), recordedBy: by }), summary);
  };
  const task = (createdDays: number, customerId: string, title: string, assignee: string, dueDays: number, dueHour: number, procId?: string, contactId?: string, status: "open" | "in_progress" = "open") => {
    setClock(createdDays);
    return must(repo.createTask({ customerId, processId: procId, companyContactId: contactId, title, assigneeId: assignee, dueAt: at(dueDays, dueHour).toISOString(), status, recordedBy: assignee }), title);
  };
  const contactStatus = (days: number, customerId: string, to: "existing_verified" | "former_verified" | "archived", by: string, reason: string) => {
    setClock(days);
    must(repo.changeContactStatus(customerId, { to, reason, recordedBy: by, verification: to === "archived" ? undefined : { sourceCategory: "other_documented", complianceAcknowledged: true } }), `${customerId}→${to}`);
  };

  // 1) Meglévő magánszemély ügyfél, két külön folyamattal (egy sikeresen lezárt, egy új érdeklődésből induló, aktív)
  const anna = individual(-90, "Mintaváry", "Anna", U1, { phone: "+36 30 555 0101", notes: "Fiktív jegyzet: telefonon kéri a visszajelzést." });
  const annaOld = process(-80, anna.id, "inbound_inquiry", "Értékpapírszámla — első megtakarítás (korábbi)", U1);
  advance(annaOld.id, "inbound_inquiry", "first_deposit_verified", -78, U1);
  setClock(-60);
  must(repo.closeProcess(annaOld.id, { outcome: "success", recordedBy: U1 }), "close success");
  contactStatus(-59, anna.id, "existing_verified", U1, "Demó: a korábbi szimulált folyamat alapján, külön döntéssel.");
  const annaNew = process(-5, anna.id, "inbound_inquiry", "Gyermek megtakarítási számla — új érdeklődés", U1, { channel: "phone", source: "existing_customer" });
  advance(annaNew.id, "inbound_inquiry", "needs_assessment", -4, U1);
  note(-2, 14, "meeting", anna.id, annaNew.id, "Konzultáció az igényekről (fiktív): az ügyfél a gyermek számára gyűjtene.", U1);
  task(-2, anna.id, "Konzultációs összefoglaló elkészítése", U1, 0, 11, annaNew.id);

  // 2) Bejövő érdeklődő (még nem kezdődött meg a kapcsolatfelvétel)
  const bela = individual(-1, "Tesztelek", "Béla", U2, { phone: "+36 30 555 0102", source: "weboldali űrlap (fiktív)" });
  const belaProc = process(-1, bela.id, "inbound_inquiry", "Érdeklődés a weboldalról", U2);
  task(-1, bela.id, "Első visszahívás az érdeklődőnek", U2, 0, 9, belaProc.id);

  // 3) Megnyitott, de még nem finanszírozott szimulált számla
  const csilla = individual(-40, "Példafi", "Csilla", U1, { phone: "+36 30 555 0103" });
  const csillaProc = process(-38, csilla.id, "inbound_inquiry", "Értékpapírszámla — ajánlás útján", U1, { channel: "referral", source: "referral" });
  advance(csillaProc.id, "inbound_inquiry", "awaiting_first_deposit", -37, U1);
  task(-3, csilla.id, "Egyeztetés az első pénzelhelyezés időzítéséről", U1, 2, 10, csillaProc.id);

  // 4) Későbbre halasztott (eredmény nélkül lezárt) folyamat + korábbi ügyfél
  const denes = individual(-120, "Kitalált", "Dénes", U2, { phone: "+36 30 555 0104" });
  const denesProc = process(-70, denes.id, "outbound_outreach", "Számlanyitási lehetőség — későbbre halasztva", U2);
  advance(denesProc.id, "outbound_outreach", "needs_assessment", -69, U2);
  setClock(-20);
  must(repo.closeProcess(denesProc.id, { outcome: "no_result", reason: "postponed", reasonNote: "Az ügyfél jövő negyedévben jelentkezik.", followUpDueAt: at(14, 10).toISOString(), recordedBy: U2 }), "postponed");
  contactStatus(-19, denes.id, "former_verified", U2, "Demó: korábbi kapcsolat.");

  // 5) Eredmény nélkül lezárt folyamat + megkeresési tiltakozás (archivált)
  const emese = individual(-100, "Demóházi", "Emese", U1);
  const emeseProc = process(-60, emese.id, "outbound_outreach", "Kimenő megkeresés", U1);
  call(-59, 10, emese.id, emeseProc.id, "not_interested", "Az ügyfél nem érdeklődik.", U1);
  setClock(-58);
  must(repo.closeProcess(emeseProc.id, { outcome: "no_result", reason: "not_interested", recordedBy: U1 }), "no result");
  setClock(-57);
  must(repo.setRestriction(emese.id, { kind: "objection", note: "Fiktív: az ügyfél tiltakozott a további megkeresés ellen.", recordedBy: U1 }), "restriction");
  contactStatus(-56, emese.id, "archived", U1, "Tiltakozás miatt archiválva.");

  // 6) Hosszú nevű magánszemély (megjelenítési teszt)
  individual(-10, "Hosszúnevű-Különösen-Hosszú-Vezetéknevű", "Ferdinánd-Alexander-Maximilian", U2);

  // 7) Több kapcsolattartós cég, konzultációs szakaszban lévő folyamat
  const epito = company(-45, "Minta Építő Kft.", U1);
  const gabor = contact(epito.id, "Gyakorlati", "Gábor", "Ügyvezető", true);
  const hajni = contact(epito.id, "Mintás", "Hajnalka", "Pénzügyi vezető");
  contact(epito.id, "Próbai", "István", "Irodavezető");
  const epitoProc = process(-30, epito.id, "outbound_outreach", "Céges megtakarítási számla", U1, { contactId: gabor.id });
  advance(epitoProc.id, "outbound_outreach", "needs_assessment", -29, U1);
  note(-3, 15, "meeting", epito.id, epitoProc.id, "Konzultáció a pénzügyi vezetővel (fiktív).", U1, hajni.id);
  task(-3, epito.id, "Ajánlati anyag küldése a pénzügyi vezetőnek", U1, -1, 12, epitoProc.id, hajni.id, "in_progress");

  // 8) Új, céges kontaktadatbázisból származó kapcsolat (még nem keresték meg)
  const delta = company(-2, "Delta Minta Kft.", U2, "kontaktadatbázis (fiktív lista)");
  const judit = contact(delta.id, "Kamu", "Judit", "Társaságvezető", true);
  process(-2, delta.id, "outbound_outreach", "Kimenő kapcsolatépítés — kontaktadatbázis", U2, { contactId: judit.id });
  task(-2, delta.id, "Megkeresési jogalap és adatforrás ellenőrzése, majd első hívás", U2, 1, 10, undefined, judit.id);

  // 9) Sikertelen híváskísérletek (nem vette fel, foglalt)
  const eszaki = company(-12, "Északi Példa Bt.", U1, "kontaktadatbázis (fiktív lista)");
  const kristof = contact(eszaki.id, "Álnevy", "Kristóf", "Tulajdonos", true);
  const eszakiProc = process(-10, eszaki.id, "outbound_outreach", "Kimenő kapcsolatépítés", U1, { contactId: kristof.id });
  advance(eszakiProc.id, "outbound_outreach", "contact_in_progress", -9, U1);
  call(-9, 10, eszaki.id, eszakiProc.id, "not_answered", "Nem vette fel.", U1, kristof.id);
  call(-6, 14, eszaki.id, eszakiProc.id, "busy", "Foglalt, később próbálkozunk.", U1, kristof.id);
  task(-6, eszaki.id, "Újabb híváskísérlet", U1, 1, 15, eszakiProc.id, kristof.id);

  // 10) Visszahívást kérő kapcsolattartó
  const logisztika = company(-25, "Példa Logisztika Zrt.", U2);
  contact(logisztika.id, "Szimulált", "Lilla", "Alapító", true);
  const kori = contact(logisztika.id, "Tesztes", "Ottó", "Pénzügyi igazgató");
  const logProc = process(-8, logisztika.id, "outbound_outreach", "Cégvezetői megkeresés", U2, { contactId: kori.id });
  advance(logProc.id, "outbound_outreach", "contact_in_progress", -7, U2);
  call(-1, 11, logisztika.id, logProc.id, "callback_requested", "A pénzügyi igazgató visszahívást kért ma délutánra.", U2, kori.id);
  task(-1, logisztika.id, "Visszahívás — pénzügyi igazgató", U2, 0, 15, logProc.id, kori.id);

  // 11) Számlanyitás folyamatban (szimulált szolgáltatói mérföldkő)
  const pekseg = company(-50, "Teszt Pékség Bt.", U1, "fiktív demó", false);
  const pekProc = process(-35, pekseg.id, "outbound_outreach", "Céges értékpapírszámla", U1);
  advance(pekProc.id, "outbound_outreach", "account_opening", -34, U1);
  task(-4, pekseg.id, "Szolgáltatói visszaigazolás ellenőrzése", U1, 3, 10, pekProc.id);

  // 12) Hosszú nevű cég (megjelenítési teszt), korábbi ügyfél, folyamat nélkül
  const hosszu = company(-200, "Fiktív Kereskedelmi és Szolgáltató Korlátolt Felelősségű Társaság a Hosszú Név Tesztelésére", U2);
  contactStatus(-190, hosszu.id, "former_verified", U2, "Demó: korábbi kapcsolat.");

  return repo.getSnapshot();
}
