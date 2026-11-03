import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors whitespace-nowrap " +
  "disabled:cursor-not-allowed disabled:opacity-55";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "bg-surface text-ink ring-1 ring-line-strong hover:bg-surface-muted",
  ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger: "bg-surface text-danger ring-1 ring-line-strong hover:bg-danger-soft",
};
const SIZES: Record<Size, string> = { sm: "min-h-9 px-3 text-[13px]", md: "min-h-11 px-4 text-sm" };

export const buttonStyles = (variant: Variant = "primary", size: Size = "md", className?: string) =>
  cn(BASE, VARIANTS[variant], SIZES[size], className);

export function Button({ variant = "primary", size = "md", className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonStyles(variant, size, className)} {...props} />;
}

export function LinkButton({ variant = "primary", size = "md", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonStyles(variant, size, className)} {...props} />;
}

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "teal" | "indigo";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-muted text-ink-muted ring-line",
  ok: "bg-ok-soft text-ok ring-ok/20",
  warn: "bg-warn-soft text-warn ring-warn/25",
  danger: "bg-danger-soft text-danger ring-danger/25",
  info: "bg-info-soft text-info ring-info/20",
  accent: "bg-accent-soft text-accent ring-accent/20",
  teal: "bg-teal-soft text-teal ring-teal/20",
  indigo: "bg-indigo-soft text-indigo ring-indigo/20",
};
/** A Pipeline-státusz színjelölő pöttye (a palettaszín teli változata). */
export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-ink-subtle", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", info: "bg-info", accent: "bg-accent", teal: "bg-teal", indigo: "bg-indigo",
};
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone], className)}>{children}</span>;
}

export function Card({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return <section id={id} className={cn("rounded-lg bg-surface ring-1 ring-line", className)}>{children}</section>;
}

export function CardHeader({ title, action, count }: { title: string; action?: ReactNode; count?: number }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <h2 className="text-sm font-semibold text-ink">
        {title}
        {count !== undefined ? <span className="ml-2 font-normal text-ink-subtle">({count})</span> : null}
      </h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-ink-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ title = "Hiba történt", message }: { title?: string; message: string }) {
  return (
    <div role="alert" className="rounded-lg bg-danger-soft p-4 text-sm text-danger ring-1 ring-danger/25">
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{message}</p>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton h-4", className)} />;
}

export function LoadingState() {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <span className="sr-only">Betöltés…</span>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function DescriptionList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{i.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{i.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
