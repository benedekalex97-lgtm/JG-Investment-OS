"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useCrmData } from "@/data/store";
import { CRM_STATUS_LABELS, CUSTOMER_TYPE_LABELS } from "@/domain/constants";
import { customerName, primaryContactOf, searchCustomerHits, statusOf } from "@/domain/logic";
import type { Customer, DataSnapshot } from "@/domain/types";
import { cn } from "@/lib/cn";

const LIMIT = 8;

interface Hit { customer: Customer; why: string; contact: string }

/**
 * Találatok a meglévő (v0.9-ben bővített) `searchCustomerHits` logikával: név, cégnév, kapcsolati személy, telefonszám és e-mail
 * (az ügyfélé és a cég kapcsolattartóié). Ügyfelenként egy találat; ha nem a név egyezik, a találat megmutatja, miért jelent meg.
 */
function findHits(data: DataSnapshot, query: string): Hit[] {
  if (!query.trim()) return [];
  return searchCustomerHits(data, query).map(({ customer: c, matches }) => {
    const why = matches.filter((m) => m.field !== "name").slice(0, 2).map((m) => `${m.label}: ${m.value}`).join(" · ");
    const primary = c.type === "company" ? primaryContactOf(data, c.id) : undefined;
    const contact = why ? "" : [c.phone ?? primary?.phone, c.email ?? primary?.email].filter(Boolean).join(" · ");
    return { customer: c, why, contact };
  });
}

/**
 * Globális ügyfélkereső a közös fejlécben (v0.9): minden bejelentkezett oldalon elérhető. Kizárólag a már betöltött, hitelesített
 * snapshotban keres (nincs külön lekérdezés, így bejelentkezés nélkül nincs adat és nincs javaslat). Combobox-minta: Le/Fel nyíl a
 * találatok között, Enter megnyitja az ügyféladatlapot, Escape bezárja a listát; kattintással is navigálható.
 */
export function GlobalSearch({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { data, phase } = useCrmData();
  const router = useRouter();
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => (data ? findHits(data, query) : []), [data, query]);
  if (phase !== "ready" || !data) return null;

  const shown = hits.slice(0, LIMIT);
  const expanded = open && query.trim() !== "";
  const go = (c: Customer) => {
    setOpen(false);
    setQuery("");
    setActive(-1);
    input.current?.blur();
    router.push(`/customers/${c.id}`);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!shown.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      if (!expanded) return;
      e.preventDefault();
      const target = shown[active] ?? (shown.length === 1 ? shown[0] : undefined);
      if (target) go(target.customer);
    } else if (e.key === "Escape") {
      if (expanded) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (query) {
        setQuery("");
      }
    }
  };
  const optionId = (i: number) => `${id}-opt-${i}`;

  return (
    // Kompakt (mobil/tablet) módban a lista a teljes fejlécsáv szélességében nyílik (a legközelebbi pozicionált szülőhöz igazodik).
    <div className={cn("min-w-0", !compact && "relative", className)}>
      <label htmlFor={id} className="sr-only">Ügyfél keresése</label>
      <input
        ref={input}
        id={id}
        type="search"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        placeholder={compact ? "Ügyfél keresése" : "Ügyfél keresése (név, cég, telefon, e-mail)"}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="block min-h-11 w-full min-w-0 rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-accent"
      />
      <div
        className={cn("absolute top-full z-40 mt-1", compact ? "inset-x-2" : "inset-x-0", "max-h-[min(24rem,70vh)] overflow-y-auto rounded-md bg-surface shadow-lg ring-1 ring-line", !expanded && "hidden")}
      >
        <ul id={listId} role="listbox" aria-label="Ügyféltalálatok" className={cn(!shown.length && "hidden")}>
          {shown.map((h, i) => (
            <li
              key={h.customer.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              // A mousedown nem veszi el a fókuszt a mezőtől, így a kattintás biztosan a találatra jut.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(h.customer)}
              className={cn("cursor-pointer border-b border-line px-3 py-2 last:border-b-0", i === active && "bg-accent-soft")}
            >
              <span className="block break-words text-sm font-medium text-ink">{customerName(h.customer)}</span>
              <span className="block text-[13px] text-ink-muted">
                {CUSTOMER_TYPE_LABELS[h.customer.type]} · {CRM_STATUS_LABELS[statusOf(h.customer)]}
              </span>
              {h.why ? <span className="block break-all text-[13px] text-ink">Egyezés — {h.why}</span> : null}
              {h.contact ? <span className="block break-all text-[13px] text-ink-muted">{h.contact}</span> : null}
            </li>
          ))}
        </ul>
        {expanded && !shown.length ? <p className="px-3 py-3 text-sm text-ink-muted">Nincs a keresésnek megfelelő ügyfél.</p> : null}
        {hits.length > LIMIT ? <p className="border-t border-line px-3 py-2 text-[13px] text-ink-muted">További {hits.length - LIMIT} találat — pontosítsd a keresést.</p> : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {expanded ? (hits.length ? `${hits.length} találat` : "Nincs találat") : ""}
      </p>
    </div>
  );
}
