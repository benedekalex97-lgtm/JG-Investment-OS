"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Natív <dialog> alapú modál: fókuszcsapda, Esc és backdrop-kattintás beépítve. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg bg-surface p-0 text-ink shadow-xl backdrop:bg-carbon/50"
    >
      {open ? (
        <div className="max-h-[85vh] overflow-y-auto p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Bezárás" className="-mr-2 -mt-2 min-h-11 min-w-11 rounded-md text-xl text-ink-muted hover:bg-surface-muted">×</button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
