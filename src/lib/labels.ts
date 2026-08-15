/**
 * VIXART OS — display labels shared by server and client components.
 *
 * Deliberately free of any database import. Client components need these
 * lists to build <select> options; importing them from `db/schema` would pull
 * the whole Drizzle schema into the browser bundle.
 *
 * The `value` strings are the database enum values and must not be renamed
 * here — that would need a migration and would orphan existing rows. Only
 * `label` is display text.
 */

export const CLIENT_STATUSES = [
  { value: 'lead', label: 'Lead' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'client', label: 'Client' },
  { value: 'dormant', label: 'Dormant' },
] as const;

export const INTERACTION_KINDS = [
  { value: 'note', label: 'Note' },
  { value: 'reunion', label: 'Meeting' },
  { value: 'appel', label: 'Call' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'proposition', label: 'Proposal' },
] as const;

export const INTERACTION_KIND_LABELS: Record<string, string> = Object.fromEntries(
  INTERACTION_KINDS.map((k) => [k.value, k.label]),
);
