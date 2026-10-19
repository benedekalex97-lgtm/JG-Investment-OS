"use client";

import { useRef, useState, type FormEvent } from "react";
import { useUserName } from "@/components/common";
import { TextArea } from "@/components/ui/form";
import { Button, Card, CardHeader, EmptyState } from "@/components/ui/primitives";
import { useCrmData } from "@/data/store";
import type { Customer, DataSnapshot } from "@/domain/types";
import { formatDateTime } from "@/lib/format";

export function CustomerNotes({ customer, data }: { customer: Customer; data: DataSnapshot }) {
  const { repo } = useCrmData();
  const userName = useUserName();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const notes = data.activities.filter((a) => a.customerId === customer.id && a.type === "note")
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || !text.trim()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await repo.createNote(customer.id, text);
      if (!result.ok) {
        setError(result.errors._form ?? Object.values(result.errors)[0] ?? "A jegyzet mentése nem sikerült.");
        return;
      }
      setText("");
      setSaved(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <Card id="jegyzetek">
      <CardHeader title="Ügyféljegyzetek" count={notes.length} />
      <form onSubmit={submit} className="space-y-3 border-b border-line p-4">
        <TextArea label="Új ügyféljegyzet" value={text} onChange={(event) => { setText(event.target.value); setSaved(false); }}
          maxLength={2000} rows={3} required disabled={busy} hint={`${text.length} / 2000 karakter`} />
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || !text.trim()} aria-busy={busy}>Jegyzet mentése</Button>
          {saved ? <p role="status" className="text-sm text-ok">A jegyzet elmentve.</p> : null}
        </div>
      </form>
      {notes.length ? (
        <ol className="divide-y divide-line">
          {notes.map((note) => (
            <li key={note.id} className="space-y-1 p-4">
              <p className="text-xs text-ink-muted">{formatDateTime(note.occurredAt)} · {userName(note.recordedBy)}</p>
              <p className="whitespace-pre-wrap break-words text-sm">{note.summary}</p>
            </li>
          ))}
        </ol>
      ) : <EmptyState title="Még nincs ügyféljegyzet" hint="Ide írd a beszélgetés lényegét és a megbeszélt következő lépést." />}
    </Card>
  );
}
