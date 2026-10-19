"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Natív <dialog> alapú modál: a `showModal()` a háttér inert-té tételével fókuszcsapdát ad, Esc és backdrop-kattintás bezár.
 * Bezáráskor a fókusz visszakerül a megnyitó elemre; ha az közben eltűnt (pl. a lezárt feladat kikerült a listából), a `fallbackFocus`
 * elemre. Mobilon a tartalom a képernyő magasságán belül görgethető.
 */
export function Modal({ open, onClose, title, children, fallbackFocus }: { open: boolean; onClose: () => void; title: string; children: ReactNode; fallbackFocus?: () => HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const fallback = useRef(fallbackFocus);
  useEffect(() => {
    fallback.current = fallbackFocus;
  }, [fallbackFocus]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
    }
    if (!open && d.open) d.close();
    if (!open && opener.current) {
      const back = opener.current.isConnected ? opener.current : fallback.current?.() ?? null;
      opener.current = null;
      back?.focus();
    }
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
        <div className="max-h-[85dvh] overflow-y-auto overscroll-contain p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <h2 className="min-w-0 break-words text-lg font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Bezárás" className="-mr-2 -mt-2 min-h-11 min-w-11 shrink-0 rounded-md text-xl text-ink-muted hover:bg-surface-muted">×</button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
