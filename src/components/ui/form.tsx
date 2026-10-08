"use client";

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const CONTROL =
  "block w-full min-h-11 rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control placeholder:text-ink-subtle " +
  "focus-visible:outline-2 focus-visible:outline-accent aria-[invalid=true]:ring-danger";

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: (p: { id: string; "aria-invalid": boolean; "aria-describedby"?: string; "aria-required": boolean }) => ReactNode;
  className?: string;
}

/** Címkézett, hibajelzéses mező (aria-invalid + aria-describedby). */
export function Field({ label, error, hint, required, children, className }: FieldProps) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {required ? <span aria-hidden className="ml-0.5 text-danger">*</span> : null}
      </label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": error || hint ? msgId : undefined, "aria-required": Boolean(required) })}
      {error ? (
        <p id={msgId} role="alert" className="text-[13px] text-danger">{error}</p>
      ) : hint ? (
        <p id={msgId} className="text-[13px] text-ink-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput({ label, error, hint, required, className, ...rest }: { label: string; error?: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      {(a) => <input {...a} {...rest} className={CONTROL} />}
    </Field>
  );
}

export function TextArea({ label, error, hint, required, className, ...rest }: { label: string; error?: string; hint?: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      {(a) => <textarea rows={3} {...a} {...rest} className={cn(CONTROL, "py-2")} />}
    </Field>
  );
}

export function SelectInput({ label, error, hint, required, className, children, ...rest }: { label: string; error?: string; hint?: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      {(a) => <select {...a} {...rest} className={CONTROL}>{children}</select>}
    </Field>
  );
}

/** Szűrősoron használt, vizuálisan kompakt, de címkézett select. */
export function FilterSelect({ label, className, children, ...rest }: { label: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className={cn("block text-xs font-medium text-ink-muted", className)}>
      {label}
      <select {...rest} className={cn(CONTROL, "mt-1")}>{children}</select>
    </label>
  );
}
