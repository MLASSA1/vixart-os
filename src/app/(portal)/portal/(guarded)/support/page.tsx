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
      <p className="vix-meta">{session.user.companyName}</p>
      <h1 className="vix-h1 mt-4">Talk to us</h1>
      <p className="vix-lead mt-5">
        This goes straight to the team. It is private between you and VIXART —
        no other client can see it.
      </p>

      {messages.length === 0 ? (
        <div className="vix-card mt-10 px-7 py-8">
          <p className="font-semibold">Nothing said yet.</p>
          <p className="vix-body mt-2">Write the first thing below.</p>
        </div>
      ) : (
        <ul className="mt-10 space-y-3">
          {messages.map((m) => (
            <li
              key={m.id}
              className={`max-w-[85%] px-5 py-4 ${
                m.mine ? 'vix-said-them ml-auto' : 'vix-said-us'
              }`}
            >
              <p className="vix-meta">{m.mine ? 'You' : m.author_name}</p>
              {m.withdrawn_at ? (
                <p className="vix-quiet mt-2 italic">This message was withdrawn.</p>
              ) : (
                <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-wrap">
                  {m.body}
                </p>
              )}
              <p className="vix-quiet mt-2 text-[11.5px]">{when(m.created_at)}</p>
            </li>
          ))}
        </ul>
      )}

      <SupportComposer />
    </>
  );
}
