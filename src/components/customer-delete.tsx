"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { TextInput } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Button, Card } from "@/components/ui/primitives";
import { useCrmData } from "@/data/store";
import { customerName } from "@/domain/logic";
import type { Customer } from "@/domain/types";

const WORD = "TÖRLÉS";

/**
 * CRM-006: tesztfázisban létrehozott ügyfél eltávolítása az aktív CRM-ből. Csak akkor jelenik meg, ha a szerver a funkciót engedélyezte
 * (JG_TEST_CUSTOMER_DELETE_ENABLED); a szerver ettől függetlenül minden kérésnél újra ellenőriz. Logikai, visszaállítható törlés: a
 * feladatok, Outputok, jegyzetek, előzmények és kapcsolattartók megmaradnak, csak az aktív felületekről tűnik el az ügyfél.
 */
export function CustomerDeleteCard({ customer }: { customer: Customer }) {
  const { features } = useCrmData();
  const [open, setOpen] = useState(false);
  if (!features.testCustomerDelete) return null;
  return (
    <Card id="ugyfel-torlese">
      <div className="space-y-2 p-4">
        <h2 className="text-sm font-semibold">Tesztfázis: ügyfél eltávolítása</h2>
        <p className="text-[13px] text-ink-muted">A tesztelés közben létrehozott ügyfél eltávolítható az aktív CRM-ből. A kapcsolódó adatok megmaradnak, és az üzemeltető visszaállíthatja.</p>
        <Button variant="danger" size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>Ügyfél törlése</Button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Ügyfél törlése">
        <DeleteForm customer={customer} onCancel={() => setOpen(false)} />
      </Modal>
    </Card>
  );
}

function DeleteForm({ customer, onCancel }: { customer: Customer; onCancel: () => void }) {
  const { repo } = useCrmData();
  const router = useRouter();
  const [word, setWord] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const ready = word.trim() === WORD;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current) return;
    if (!ready) return setError(`A törléshez írd be pontosan: ${WORD}`);
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await repo.deleteCustomer(customer.id, word.trim());
      if (!r.ok) return setError(r.errors.confirmation ?? r.errors._form ?? "A törlés nem sikerült.");
      router.push("/customers?eltavolitva=1");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <p className="text-sm">Biztosan eltávolítod az aktív CRM-ből ezt az ügyfelet?</p>
      <p className="break-words rounded-md bg-canvas p-3 text-base font-semibold ring-1 ring-line">{customerName(customer)}</p>
      <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-muted">
        <li>Eltűnik az ügyféllistából, a Pipeline-ból, a keresőből és a feladatlistákból.</li>
        <li>A feladatok, Outputok, jegyzetek, előzmények és kapcsolattartók megmaradnak; az üzemeltető visszaállíthatja.</li>
      </ul>
      <TextInput label={`A megerősítéshez írd be: ${WORD}`} value={word} autoComplete="off" spellCheck={false} autoFocus error={error}
        onChange={(e) => { setWord(e.target.value); setError(""); }} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Mégse</Button>
        <Button type="submit" variant="danger" disabled={busy || !ready} aria-busy={busy}>Ügyfél törlése</Button>
      </div>
    </form>
  );
}
