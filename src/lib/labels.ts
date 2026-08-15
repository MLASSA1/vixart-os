/**
 * VIXART OS — display labels shared by server and client components.
 *
 * Deliberately free of any database import: client components need these lists
 * to build <select> options, and importing them from `db/schema` would pull the
 * whole Drizzle schema into the browser bundle.
 *
 * The `value` strings are the stored values. Renaming one needs a migration —
 * only `label` is display text.
 */

export const COMPANY_STAGES = [
  { value: 'lead', label: 'Lead' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'client', label: 'Client' },
  { value: 'dormant', label: 'Dormant' },
] as const;

export const RELATIONSHIPS = [
  { value: 'client', label: 'Client' },
  { value: 'supplier', label: 'Supplier' },
  { value: 'partner', label: 'Partner' },
  { value: 'other', label: 'Other' },
] as const;

export const INTERACTION_KINDS = [
  { value: 'note', label: 'Note' },
  { value: 'reunion', label: 'Meeting' },
  { value: 'appel', label: 'Call' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'proposition', label: 'Proposal' },
] as const;

export const DEAL_STAGES = [
  { value: 'proposal', label: 'Proposal' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
] as const;

export const PROJECT_STATUSES = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'delivered', label: 'Delivered' },
] as const;

export const TASK_STATUSES = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'submitted', label: 'Awaiting sign-off' },
  { value: 'completed', label: 'Completed' },
] as const;

export const TASK_PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
] as const;

export const ROLE_LABELS: Record<string, string> = {
  admin: 'Management',
  moderator: 'Work moderator',
  member: 'Team',
};

function toMap(list: ReadonlyArray<{ value: string; label: string }>) {
  return Object.fromEntries(list.map((i) => [i.value, i.label])) as Record<string, string>;
}

export const COMPANY_STAGE_LABELS = toMap(COMPANY_STAGES);
export const RELATIONSHIP_LABELS = toMap(RELATIONSHIPS);
export const INTERACTION_KIND_LABELS = toMap(INTERACTION_KINDS);
export const DEAL_STAGE_LABELS = toMap(DEAL_STAGES);
export const PROJECT_STATUS_LABELS = toMap(PROJECT_STATUSES);
export const TASK_STATUS_LABELS = toMap(TASK_STATUSES);
export const TASK_PRIORITY_LABELS = toMap(TASK_PRIORITIES);
