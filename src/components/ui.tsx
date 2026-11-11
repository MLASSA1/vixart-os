/**
 * VIXART OS — interface primitives.
 *
 * Theme "Studio dusk": warm paper ground, white cards, ink text, one saffron
 * accent that is spent deliberately. Status may carry hue — muted tints from
 * globals.css (.tone-*), never raw traffic-light colour. The two-colour law
 * still governs the printed PDF, where it belongs.
 */

import Link from 'next/link';
import { Breadcrumb } from './Breadcrumb';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Pipeline status
//
// Encoded without colour: the further along the pipeline, the denser the chip.
// Client = solid black. Prospect = thick rule. Lead = hairline rule.
// Dormant = hairline rule, pushed back by opacity.
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  // A client is won: green. A prospect is warm. A lead is quiet ink.
  client: 'tone-ok',
  prospect: 'tone-accent',
  lead: 'tone-quiet',
  dormant: 'tone-quiet opacity-70',
};

const STATUS_LABELS: Record<string, string> = {
  client: 'Client',
  prospect: 'Prospect',
  lead: 'Lead',
  dormant: 'Dormant',
};

export function Status({ value }: { value: string }) {
  return (
    <span className={`chip ${STATUS_STYLES[value] ?? STATUS_STYLES.lead}`}>
      {STATUS_LABELS[value] ?? value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page structure
// ---------------------------------------------------------------------------

/**
 * The top of every screen answers three questions, in this order:
 *
 *   where am I       the trail, from the sidebar's own map (<Breadcrumb/>)
 *   what is this     the title — the sidebar's label on a list page
 *   what is it for   `intro`: ONE short line, never a paragraph
 *
 * and puts what you can do (`actions`) top right, in the same place on every
 * screen. The page no longer chooses its own eyebrow: twenty pages had chosen
 * twenty different ones, none of which said where you were.
 */
export function PageHeader({
  title,
  intro,
  actions,
}: {
  title: string;
  /** One line. If it needs a paragraph, the screen needs simplifying instead. */
  intro?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4 pb-1">
      <div className="min-w-0">
        <Breadcrumb />
        <h1 className="mt-1.5 text-3xl font-bold tracking-tight">{title}</h1>
        {intro && <p className="hint mt-1.5 max-w-[62ch] text-[14px]">{intro}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  action,
  filterGroup = false,
  children,
}: {
  title: string;
  action?: ReactNode;
  /** Hidden by a <ListFilter> above it when none of its rows match. */
  filterGroup?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="card mt-8 px-6 py-5" data-filter-group={filterGroup || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-void/10 pb-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
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
      <span className="label shrink-0">
        {label}
      </span>
      <span className="code text-right break-words">{value || '—'}</span>
    </div>
  );
}

export function Empty({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="rounded-[14px] border border-dashed border-void/25 bg-paper px-6 py-10 text-center">
      <p className="label">
        {message}
      </p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Error banner: the danger tone. Red is reserved for exactly this. */
export function ErrorBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="tone-danger mb-6 rounded-[10px] px-4 py-3">
      <p className="text-[12.5px] font-bold tracking-wide uppercase">Error</p>
      <p className="prose-vixart mt-1">{message}</p>
    </div>
  );
}

/**
 * It worked, with a caveat. Warn tone, never danger: red is for something that
 * did not happen, and this happened.
 */
export function NoticeBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="tone-warn mb-6 rounded-[10px] px-4 py-3">
      <p className="text-[12.5px] font-bold tracking-wide uppercase">Done, with a note</p>
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
      <span className="label block">
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
  'mt-1.5 w-full rounded-[9px] border border-void/25 bg-surface px-3 py-2.5 text-[15px] ' +
  'transition-[border-color,box-shadow] focus:border-accent ' +
  'focus:shadow-[0_0_0_3px_rgba(109,40,217,0.22)] focus:outline-none';

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
        className="mt-1 h-4 w-4 shrink-0 accent-accent"
      />
      <span>
        <span className="label block">{label}</span>
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
