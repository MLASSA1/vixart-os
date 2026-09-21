import { redirect } from 'next/navigation';
import { requireClientSession } from '@/auth';
import { withClient } from '@/db/session';
import { listPortalMessages } from '@/lib/client-portal-queries';
import { SupportComposer } from './Composer';

export const dynamic = 'force-dynamic';

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export default async function SupportPage() {
  const session = await requireClientSession();
  if (session.user.mustChangePassword) redirect('/portal/account');

  const messages = await withClient(session.user.id, (tx) => listPortalMessages(tx));

  return (
    <>
      <p className="label" style={{ opacity: 0.6 }}>{session.user.companyName}</p>
      <h1 className="display mt-1 text-3xl font-bold tracking-tight">Talk to us</h1>
      <p className="prose-vixart mt-3" style={{ opacity: 0.7 }}>
        This goes straight to the team. It is private between you and VIXART —
        no other client can see it.
      </p>

      {messages.length === 0 ? (
        <div className="card mt-8 px-6 py-8">
          <p className="font-semibold">Nothing said yet.</p>
          <p className="hint mt-1">Write the first thing below.</p>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {messages.map((m) => (
            <li
              key={m.id}
              className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                m.mine ? 'ml-auto bg-accent/10' : 'bg-surface border border-void/10'
              }`}
            >
              <p className="text-[12.5px] font-semibold" style={{ opacity: 0.7 }}>
                {m.mine ? 'You' : m.author_name}
              </p>
              {m.withdrawn_at ? (
                <p className="mt-0.5 italic" style={{ opacity: 0.55 }}>
                  This message was withdrawn.
                </p>
              ) : (
                <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>
              )}
              <p className="hint mt-1 text-[11.5px]">{when(m.created_at)}</p>
            </li>
          ))}
        </ul>
      )}

      <SupportComposer />
    </>
  );
}
