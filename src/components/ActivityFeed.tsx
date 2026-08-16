import { formatDateTime } from '@/lib/format';

export interface ActivityItem {
  id: string;
  actor_name: string;
  entity_type: string;
  entity_label: string | null;
  action: string;
  created_at: string;
}

const ENTITY_LABELS: Record<string, string> = {
  company: 'Client',
  deal: 'Deal',
  project: 'Project',
  task: 'Task',
  service: 'Service',
  user: 'Account',
};

/** Raw status keys become sentences: "moved to meeting_booked" → "moved to Meeting booked". */
function humanise(action: string): string {
  return action.replace(/^moved to (.+)$/, (_, s: string) => {
    const words = String(s).replace(/_/g, ' ');
    return `moved to ${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  });
}

/**
 * Team activity, written by database triggers rather than by application code —
 * an audit trail that relies on every call site remembering to log has holes.
 */
export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return <p className="hint">Nothing recorded yet.</p>;
  }

  return (
    <ul className="border-t border-void/10">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-void/10 py-2.5"
        >
          <span>
            <span className="font-medium">{item.actor_name}</span>{' '}
            <span style={{ opacity: 0.7 }}>{humanise(item.action)}</span>{' '}
            <span className="hint">{ENTITY_LABELS[item.entity_type] ?? item.entity_type}</span>{' '}
            <span className="font-medium">{item.entity_label ?? ''}</span>
          </span>
          <span className="hint whitespace-nowrap">{formatDateTime(item.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}
