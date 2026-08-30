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
  { value: 'new_lead', label: 'New lead' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'meeting_booked', label: 'Meeting booked' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
] as const;

/** Stages that are still in play — everything before won/lost. */
export const OPEN_DEAL_STAGES = [
  'new_lead',
  'contacted',
  'meeting_booked',
  'proposal',
  'negotiation',
] as const;

export const PROJECT_TYPES = [
  { value: 'branding', label: 'Branding' },
  { value: 'website', label: 'Website' },
  { value: 'ads_campaign', label: 'Ads campaign' },
  { value: 'video', label: 'Video' },
  { value: 'other', label: 'Other' },
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
export const PROJECT_TYPE_LABELS = toMap(PROJECT_TYPES);
export const PROJECT_STATUS_LABELS = toMap(PROJECT_STATUSES);
export const TASK_STATUS_LABELS = toMap(TASK_STATUSES);
export const TASK_PRIORITY_LABELS = toMap(TASK_PRIORITIES);

export const PILLARS = [
  { value: 'brand_architecture', label: 'Brand Architecture' },
  { value: 'cinematic_production', label: 'Cinematic Production' },
  { value: 'digital_presence', label: 'Digital Presence' },
  { value: 'social_media', label: 'Social Media' },
  { value: 'growth_marketing', label: 'Growth Marketing' },
  { value: 'app_automation', label: 'App & Automation' },
  { value: 'codex_ai', label: 'Codex AI' },
] as const;

export const SERVICE_UNITS = [
  { value: 'forfait', label: 'Fixed fee' },
  { value: 'mois', label: 'Per month' },
  { value: 'jour', label: 'Per day' },
] as const;

export const PILLAR_LABELS = toMap(PILLARS);
export const SERVICE_UNIT_LABELS = toMap(SERVICE_UNITS);

export const DOCUMENT_TYPES = [
  { value: 'devis', label: 'Quote' },
  { value: 'facture', label: 'Invoice' },
  { value: 'avoir', label: 'Credit note' },
] as const;

export const DOCUMENT_STATUSES = [
  { value: 'brouillon', label: 'Draft' },
  { value: 'emis', label: 'Issued' },
  { value: 'paye', label: 'Paid' },
  { value: 'annule', label: 'Cancelled' },
] as const;

export const DOCUMENT_TYPE_LABELS = toMap(DOCUMENT_TYPES);
export const DOCUMENT_STATUS_LABELS = toMap(DOCUMENT_STATUSES);

/** French wording printed on the document itself, whatever the interface language. */
export const DOCUMENT_TITLE_FR: Record<string, string> = {
  devis: 'DEVIS',
  facture: 'FACTURE',
  avoir: 'AVOIR',
};

/**
 * Ledger categories. Stored values are French because that is what the
 * accountant's chart of accounts uses; the labels are English for the screen.
 */
export const INCOME_CATEGORIES = [
  { value: 'facture', label: 'Client invoice' },
  { value: 'autre_revenu', label: 'Other income' },
] as const;

/**
 * Expenses, grouped the way the agency actually spends.
 *
 * `fixed` — the same number every month, and the ones that go on the monthly
 * checklist. `metered` — recurs monthly but the amount moves, so the checklist
 * asks for it. `variable` — happens when it happens, logged as it happens.
 */
export const EXPENSE_CATEGORIES = [
  // Fixed, month after month
  { value: 'loyer', label: 'Rent', group: 'fixed' },
  { value: 'salaires', label: 'Salaries', group: 'fixed' },
  { value: 'internet', label: 'Internet', group: 'fixed' },
  { value: 'telephone', label: 'Phone', group: 'fixed' },
  { value: 'logiciel', label: 'Software & subscriptions', group: 'fixed' },
  { value: 'impots', label: 'Taxes', group: 'fixed' },
  { value: 'frais_bancaires', label: 'Bank fees', group: 'fixed' },
  // Metered — arrives every month, never the same amount
  { value: 'electricite', label: 'Electricity', group: 'metered' },
  { value: 'eau', label: 'Water', group: 'metered' },
  // Variable — as and when
  { value: 'carburant', label: 'Fuel', group: 'variable' },
  { value: 'repas', label: 'Food & meals', group: 'variable' },
  { value: 'deplacement', label: 'Travel', group: 'variable' },
  { value: 'equipement', label: 'Equipment & rentals', group: 'variable' },
  { value: 'fournitures', label: 'Supplies', group: 'variable' },
  { value: 'sous_traitance', label: 'Subcontractors', group: 'variable' },
  { value: 'marketing', label: 'Marketing', group: 'variable' },
  { value: 'autre_depense', label: 'Other expense', group: 'variable' },
] as const;

/** The ones a recurring charge can use — everything except pure one-offs. */
export const CHARGE_CATEGORIES = EXPENSE_CATEGORIES;

export const EXPENSE_GROUP_LABELS: Record<string, string> = {
  fixed: 'Fixed — same every month',
  metered: 'Metered — every month, amount varies',
  variable: 'Variable — as and when',
};

export const PAYMENT_METHODS = [
  { value: 'virement', label: 'Bank transfer' },
  { value: 'especes', label: 'Cash' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'carte', label: 'Card' },
  { value: 'autre', label: 'Other' },
] as const;

export const CATEGORY_LABELS = {
  ...toMap(INCOME_CATEGORIES),
  ...toMap(EXPENSE_CATEGORIES),
};
export const PAYMENT_METHOD_LABELS = toMap(PAYMENT_METHODS);

export const EQUIPMENT_CATEGORIES = [
  { value: 'camera', label: 'Camera' },
  { value: 'lens', label: 'Lens' },
  { value: 'audio', label: 'Audio & mics' },
  { value: 'lighting', label: 'Lighting' },
  { value: 'computer', label: 'Computer' },
  { value: 'phone', label: 'Phone & tablet' },
  { value: 'drone', label: 'Drone' },
  { value: 'storage', label: 'Storage & drives' },
  { value: 'accessory', label: 'Accessory' },
  { value: 'autre', label: 'Other' },
] as const;

export const EQUIPMENT_STATUSES = [
  { value: 'available', label: 'In the office' },
  { value: 'assigned', label: 'Checked out' },
  { value: 'repair', label: 'In repair' },
  { value: 'retired', label: 'Retired' },
  { value: 'lost', label: 'Lost or stolen' },
] as const;

export const EQUIPMENT_CATEGORY_LABELS = toMap(EQUIPMENT_CATEGORIES);
export const EQUIPMENT_STATUS_LABELS = toMap(EQUIPMENT_STATUSES);

export const RECURRING_FREQUENCIES = [
  { value: 'monthly', label: 'Every month' },
  { value: 'quarterly', label: 'Every quarter' },
  { value: 'yearly', label: 'Every year' },
] as const;

export const RECURRING_FREQUENCY_LABELS = toMap(RECURRING_FREQUENCIES);
