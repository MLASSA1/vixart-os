/**
 * VIXART OS — interface primitives.
 *
 * Two colours, never a third. Hierarchy and state are carried by weight, case,
 * border thickness, fill and achromatic opacity — never by hue.
 *
 *   primary text     opacity 1
 *   secondary text   opacity 0.68
 *   metadata         opacity 0.52
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Pipeline status
//
// Encoded without colour: the further along the pipeline, the denser the chip.
// Client = solid black. Prospect = thick rule. Lead = hairline rule.
// Dormant = hairline rule, pushed back by opacity.
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  client: 'bg-void text-pure border-2 border-void',
  prospect: 'border-2 border-void text-void',
  lead: 'border border-void text-void',
  dormant: 'border border-void/40 text-void/50',
};

const STATUS_LABELS: Record<string, string> = {
  client: 'Client',
  prospect: 'Prospect',
  lead: 'Lead',
  dormant: 'Dormant',
};

export function Status({ value }: { value: string }) {
  return (
    <span
      className={`meta inline-block whitespace-nowrap px-2.5 py-1 leading-none ${
        STATUS_STYLES[value] ?? STATUS_STYLES.lead
      }`}
    >
      {STATUS_LABELS[value] ?? value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page structure
// ---------------------------------------------------------------------------

export function PageHeader({
  eyebrow,
  title,
  actions,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-10 flex flex-wrap items-end justify-between gap-4 border-b-2 border-void pb-5">
      <div>
        {eyebrow && (
          <p className="meta" style={{ opacity: 0.52 }}>
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1.5 text-3xl font-bold tracking-tight">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-12">
      <div className="flex items-center justify-between gap-4 border-b border-void pb-2">
        <h2 className="meta">{title}</h2>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Key/value row, right-aligned like a column of figures. */
export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-void/10 py-2.5">
      <span className="meta shrink-0" style={{ opacity: 0.52 }}>
        {label}
      </span>
      <span className="amount text-right break-words">{value || '—'}</span>
    </div>
  );
}

export function Empty({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="border border-dashed border-void/30 px-6 py-10 text-center">
      <p className="meta" style={{ opacity: 0.52 }}>
        {message}
      </p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Error banner: heavy rule, inverted fill, uppercase. No alert colour. */
export function ErrorBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-6 border-2 border-void bg-void px-4 py-3 text-pure">
      <p className="meta">Error</p>
      <p className="prose-vixart mt-1">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons and action links
// ---------------------------------------------------------------------------

export function ButtonLink({
  href,
  children,
  inverse,
}: {
  href: string;
  children: ReactNode;
  inverse?: boolean;
}) {
  return (
    <Link href={href} className={`btn inline-block ${inverse ? 'btn-inverse' : ''}`}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Inputs — labels in mono uppercase, typed values in Inter.
// ---------------------------------------------------------------------------

interface BaseInput {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  defaultValue?: string | null;
  fullWidth?: boolean;
}

function Wrapper({
  name,
  label,
  hint,
  required,
  fullWidth,
  children,
}: BaseInput & { children: ReactNode }) {
  return (
    <label className={`block ${fullWidth ? 'sm:col-span-2' : ''}`} htmlFor={name}>
      <span className="meta block" style={{ opacity: 0.68 }}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[15px]" style={{ opacity: 0.52 }}>
          {hint}
        </span>
      )}
    </label>
  );
}

const INPUT_CLASSES =
  'mt-1.5 w-full border border-void bg-pure px-3 py-2.5 text-[15px] ' +
  'focus:border-[3px] focus:px-[10px] focus:py-[8px] focus:outline-none';

export function TextInput(
  props: BaseInput & { type?: string; placeholder?: string; pattern?: string },
) {
  return (
    <Wrapper {...props}>
      <input
        id={props.name}
        name={props.name}
        type={props.type ?? 'text'}
        required={props.required}
        pattern={props.pattern}
        placeholder={props.placeholder}
        defaultValue={props.defaultValue ?? ''}
        className={INPUT_CLASSES}
      />
    </Wrapper>
  );
}

export function TextArea(props: BaseInput & { rows?: number }) {
  return (
    <Wrapper {...props}>
      <textarea
        id={props.name}
        name={props.name}
        rows={props.rows ?? 4}
        required={props.required}
        defaultValue={props.defaultValue ?? ''}
        className={`${INPUT_CLASSES} resize-y`}
      />
    </Wrapper>
  );
}

export function Select(
  props: BaseInput & { options: ReadonlyArray<{ value: string; label: string }> },
) {
  return (
    <Wrapper {...props}>
      <select
        id={props.name}
        name={props.name}
        required={props.required}
        defaultValue={props.defaultValue ?? ''}
        className={INPUT_CLASSES}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Wrapper>
  );
}

export function Checkbox({
  name,
  label,
  hint,
  checked,
}: {
  name: string;
  label: string;
  hint?: string;
  checked?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 sm:col-span-2" htmlFor={name}>
      <input
        id={name}
        name={name}
        type="checkbox"
        defaultChecked={checked}
        className="mt-1 h-4 w-4 shrink-0 accent-[#0B0B0F]"
      />
      <span>
        <span className="meta block">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[15px]" style={{ opacity: 0.52 }}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

/** Form grid: two columns above mobile. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">{children}</div>;
}
