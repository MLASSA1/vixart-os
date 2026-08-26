'use client';

import { AgentPanel } from '@/components/AgentPanel';

/** The finance agent's panel. Wiring only — the panel itself is shared. */
export function Comptable({ configured }: { configured: boolean }) {
  return (
    <AgentPanel
      endpoint="/api/agent/chat"
      name="Le Comptable"
      blurb="Reads the books and cites its rows. It drafts; you sign. It cannot issue a number, move money, or file anything — the database refuses it."
      configured={configured}
      notConfiguredNote="Add ANTHROPIC_API_KEY to .env and restart the stack. Everything else on this screen works without it — the agent only ever reads what is already here."
      suggestions={[
        'What came in this month?',
        'Who owes us, and how long has it been?',
        'What is due fiscally this quarter?',
        'What did we make on our biggest client?',
      ]}
      toolLabels={{
        treasury: 'ledger',
        receivables: 'unpaid invoices',
        expenses: 'costs',
        calendar: 'fiscal calendar',
        margin: 'margin per client',
        draft_invoice: 'drafted an invoice',
      }}
    />
  );
}
