'use client';

import { AgentPanel } from '@/components/AgentPanel';

/** The work agent's panel. Wiring only — the panel itself is shared. */
export function Chef({ configured }: { configured: boolean }) {
  return (
    <AgentPanel
      endpoint="/api/agent/chef"
      name="Le Chef"
      blurb="Sees who is carrying what and hands work out. It cannot mark anything done — that stays with the person doing it and the moderator signing it off. It never notifies anyone."
      configured={configured}
      notConfiguredNote="Add ANTHROPIC_API_KEY to .env and restart the stack. Everything else on this screen works without it."
      suggestions={[
        'Who is carrying the most right now?',
        'What is unassigned?',
        'Which projects are slipping?',
        'Who should take the next task?',
      ]}
      toolLabels={{
        workload: 'who has what',
        unassigned: 'unassigned work',
        project_health: 'project health',
        assign_task: 'assigned a task',
        create_task: 'opened a task',
      }}
    />
  );
}
