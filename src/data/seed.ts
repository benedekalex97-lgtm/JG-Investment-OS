import { buildDisplayName } from "@/domain/logic";
import type {
  Activity, Case, CaseStage, ClosureStatus, CompanyContact, Customer, DataSnapshot, LifecycleStatus, Task, TaskStatus,
} from "@/domain/types";

/**
 * KIZÁRÓLAG FIKTÍV DEMÓADAT. Minden név, telefonszám és e-mail kitalált;
 * az e-mail-címek a fenntartott `.example` TLD-t használják.
 * A dátumok a `now` paraméterhez képest relatívak, így a dashboard mindig élő.
 */
export function createSeedData(now: Date = new Date()): DataSnapshot {
  const at = (days: number, hour = 10) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0);
    return d.toISOString();
  };
  const created = at(-60);

  const person = (n: number, lastName: string, firstName: string, status: LifecycleStatus, owner: string, notes?: string): Customer => ({
    id: `cust-p${n}`, type: "person", firstName, lastName, displayName: buildDisplayName(firstName, lastName),
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@minta-ugyfel.example`.normalize("NFD").replace(/[̀-ͯ]/g, ""),
    phone: `+36 30 555 01${String(n).padStart(2, "0")}`, lifecycleStatus: status, ownerId: owner, source: "fiktív demó",
    verificationStatus: "demo", notes, createdAt: created, updatedAt: created,
  });
  const company = (n: number, name: string, status: LifecycleStatus, owner: string, withEmail = true): Customer => ({
    id: `cust-c${n}`, type: "company", companyName: name, email: withEmail ? `iroda${n}@minta-ceg.example` : undefined,
    phone: withEmail ? `+36 1 555 02${String(n).padStart(2, "0")}` : undefined, lifecycleStatus: status, ownerId: owner,
    source: "fiktív demó", verificationStatus: "demo", createdAt: created, updatedAt: created,
  });
  const contact = (id: string, companyN: number, last: string, first: string, position: string | undefined, primary: boolean, hasEmail = true): CompanyContact => ({
    id, companyId: `cust-c${companyN}`, firstName: first, lastName: last, position,
    email: hasEmail ? `${id}@minta-ceg.example` : undefined, phone: hasEmail ? `+36 20 555 03${id.slice(-2)}` : undefined,
    isPrimaryContact: primary, createdAt: created, updatedAt: created,
  });

  const customers: Customer[] = [
    person(1, "Mintaváry", "Anna", "existing", "user-1", "Fiktív jegyzet: kéri a havi összefoglalót telefonon."),
    person(2, "Tesztelek", "Béla", "prospect", "user-2"),
    person(3, "Példafi", "Csilla", "existing", "user-1"),
    person(4, "Kitalált", "Dénes", "former", "user-2", "Fiktív jegyzet: korábbi kapcsolat, nincs aktív ügy."),
    person(5, "Demóházi", "Emese", "prospect", "user-1"),
    person(6, "Hosszúnevű-Különösen-Hosszú-Vezetéknevű", "Ferdinánd-Alexander-Maximilian", "archived", "user-2"),
    company(1, "Minta Építő Kft.", "existing", "user-1"),
    company(2, "Példa Logisztika Zrt.", "prospect", "user-2"),
    company(3, "Teszt Pékség Bt.", "existing", "user-1", false),
    company(4, "Demó Szoftver Kft.", "prospect", "user-1"),
    company(5, "Fiktív Kereskedelmi és Szolgáltató Korlátolt Felelősségű Társaság a Hosszú Név Tesztelésére", "former", "user-2"),
  ];

  const contacts: CompanyContact[] = [
    contact("kont-01", 1, "Gyakorlati", "Gábor", "Ügyvezető", true),
    contact("kont-02", 1, "Mintás", "Hajnalka", "Pénzügyi vezető", false),
    contact("kont-03", 1, "Próbai", "István", "Irodavezető", false, false),
    contact("kont-04", 2, "Kamu", "Judit", "Társaságvezető", true),
    contact("kont-05", 2, "Álnevy", "Kristóf", undefined, false),
    contact("kont-06", 4, "Szimulált", "Lilla", "Alapító", true),
    // A Teszt Pékség Bt.-nek nincs kapcsolattartója (0..N).
  ];

  const cs = (id: string, customerId: string, title: string, stage: CaseStage, owner: string, nextAction: string | undefined, due: string | undefined, contactId?: string, closure: ClosureStatus = "open"): Case => ({
    id, customerId, companyContactId: contactId, title, stage, closureStatus: closure, ownerId: owner,
    nextAction, nextActionDueAt: due, createdAt: created, updatedAt: created,
  });
  const cases: Case[] = [
    cs("case-01", "cust-p1", "Éves áttekintő egyeztetés", "consultation_set", "user-1", "Egyeztetési jegyzet előkészítése", at(2)),
    cs("case-02", "cust-p1", "Dokumentumkérés (fiktív)", "provider_in_progress", "user-1", "Visszajelzés kérése a szolgáltatótól", at(5)),
    cs("case-03", "cust-p2", "Első tájékoztató beszélgetés", "clarify_need", "user-2", "Időpont egyeztetése", at(1)),
    cs("case-04", "cust-p3", "Adategyeztetés", "next_step_set", "user-1", undefined, undefined, undefined, "won"),
    cs("case-05", "cust-p5", "Érdeklődés kezelése", "clarify_need", "user-1", "Visszahívás", at(-1)),
    cs("case-06", "cust-c1", "Céges kapcsolattartási csomag", "consultation_set", "user-1", "Konzultációs anyag küldése", at(3), "kont-01"),
    cs("case-07", "cust-c1", "Pénzügyi vezetői egyeztetés", "clarify_need", "user-1", "Meeting időpont", at(6), "kont-02"),
    cs("case-08", "cust-c2", "Ismerkedő egyeztetés", "clarify_need", "user-2", "Bemutatkozó hívás", at(0, 15), "kont-04"),
    cs("case-09", "cust-c3", "Éves felülvizsgálat", "next_step_set", "user-1", "Egyeztetés az irodában", at(9)),
    cs("case-10", "cust-c4", "Kezdeti igényfelmérés", "clarify_need", "user-1", undefined, undefined, "kont-06"),
    cs("case-11", "cust-c5", "Korábbi ügy lezárása", "clarify_need", "user-2", undefined, undefined, undefined, "lost"),
    cs("case-12", "cust-p4", "Visszavont megkeresés", "clarify_need", "user-2", undefined, undefined, undefined, "cancelled"),
  ];

  const tk = (id: string, customerId: string, title: string, assignee: string, due: string, status: TaskStatus, caseId?: string, contactId?: string, description?: string): Task => ({
    id, customerId, caseId, companyContactId: contactId, title, description, assigneeId: assignee, dueAt: due, status,
    createdAt: created, completedAt: status === "done" ? at(-1) : undefined,
  });
  const tasks: Task[] = [
    tk("task-01", "cust-p1", "Összefoglaló előkészítése", "user-1", at(0, 11), "open", "case-01", undefined, "Fiktív feladatleírás."),
    tk("task-02", "cust-c2", "Bemutatkozó hívás", "user-2", at(0, 15), "in_progress", "case-08", "kont-04"),
    tk("task-03", "cust-p5", "Visszahívás", "user-1", at(-2), "open", "case-05"),
    tk("task-04", "cust-c1", "Konzultációs anyag küldése", "user-1", at(-1), "in_progress", "case-06", "kont-01"),
    tk("task-05", "cust-p2", "Időpont egyeztetése", "user-2", at(1), "open", "case-03"),
    tk("task-06", "cust-c3", "Irodai találkozó szervezése", "user-1", at(4), "open", "case-09"),
    tk("task-07", "cust-c1", "Meeting időpont", "user-2", at(6), "open", "case-07", "kont-02"),
    tk("task-08", "cust-p3", "Adategyeztetés lezárása", "user-1", at(-3), "done", "case-04"),
  ];

  const ac = (id: string, customerId: string, type: Activity["type"], summary: string, days: number, owner: string, caseId?: string, contactId?: string): Activity => ({
    id, customerId, caseId, companyContactId: contactId, type, summary, occurredAt: at(days, 9 + (Math.abs(days) % 6)), ownerId: owner,
  });
  const activities: Activity[] = [
    ac("act-01", "cust-p1", "call", "Telefonos egyeztetés a havi összefoglalóról (fiktív).", -1, "user-1", "case-01"),
    ac("act-02", "cust-p1", "note", "Fiktív jegyzet: az ügyfél e-mailben kér visszajelzést.", -4, "user-1", "case-02"),
    ac("act-03", "cust-c1", "meeting", "Kapcsolatfelvételi meeting az irodában (fiktív).", -2, "user-1", "case-06", "kont-01"),
    ac("act-04", "cust-c1", "call", "Rövid hívás a pénzügyi vezetővel.", -6, "user-2", "case-07", "kont-02"),
    ac("act-05", "cust-c2", "follow_up", "Utánkövető üzenet előkészítve (nem küldött).", -3, "user-2", "case-08", "kont-04"),
    ac("act-06", "cust-p2", "call", "Első beszélgetés, érdeklődés felmérése.", -5, "user-2", "case-03"),
    ac("act-07", "cust-c3", "meeting", "Éves egyeztetés a pékségben (fiktív).", -20, "user-1", "case-09"),
    ac("act-08", "cust-c4", "note", "Fiktív jegyzet: igényfelmérés kezdődik.", -30, "user-1", "case-10", "kont-06"),
    ac("act-09", "cust-p5", "note", "Érdeklődés érkezett (fiktív forrás).", -18, "user-1", "case-05"),
    ac("act-10", "cust-p3", "call", "Adategyeztető hívás lezárva.", -3, "user-1", "case-04"),
  ];

  return { customers, contacts, cases, activities, tasks, contactability: [] };
}
