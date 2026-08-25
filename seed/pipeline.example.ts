/**
 * The pipeline the seed uses when there is no local override.
 *
 * Deliberately generic. Copy this to `seed/pipeline.local.ts` and put the real
 * clients there — that file is gitignored, so a public repository never carries
 * the agency's client list or its open prospects.
 */

export interface SeedCompany {
  name: string;
  status: 'lead' | 'prospect' | 'client' | 'dormant';
  city?: string;
  website?: string;
  engagementSummary: string;
  notes: string | null;
}

export const PIPELINE: SeedCompany[] = [
  {
    name: 'Example Client',
    status: 'client',
    city: 'Agadir',
    engagementSummary: 'Replace this with a real engagement, or delete it once you have your own.',
    notes: 'Seeded placeholder. Safe to delete.',
  },
  {
    name: 'Example Prospect',
    status: 'prospect',
    city: 'Agadir',
    engagementSummary: 'Proposal stage.',
    notes: 'Seeded placeholder. Safe to delete.',
  },
];
