import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireClientSession } from '@/auth';
import { withClient } from '@/db/session';
import { findPortalSystem, listPortalSystems } from '@/lib/client-portal-queries';

export const dynamic = 'force-dynamic';

/**
 * One system, in the same four sections the website uses.
 *
 * What it fixes / what it is / what you get / who it is for — read out of
 * `growth_system`, which was imported from visionxart.com and is re-imported
 * when the site changes. The portal does not fetch the website at request
 * time: a client waiting on the marketing site is a dependency nobody chose,
 * and the site going down would empty this page.
 */
export default async function SystemPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const session = await requireClientSession();
  if (session.user.mustChangePassword) redirect('/portal/account');

  const { slug } = await params;

  const data = await withClient(session.user.id, async (tx) => {
    const system = await findPortalSystem(tx, slug);
    if (!system) return null;
    const all = await listPortalSystems(tx);
    return { system, siblings: all.filter((s) => s.family === system.family) };
  });

  if (!data) notFound();
  const { system, siblings } = data;

  return (
    <>
      <Link href="/portal/systems" className="vix-meta hover:text-white">
        ← {system.family} systems
      </Link>

      <div className="mt-10 grid items-start gap-10 lg:grid-cols-[1fr_340px]">
        <div>
          <p className="vix-meta tabular-nums">
            {String(system.position).padStart(2, '0')}
          </p>
          <h1 className="vix-h1 mt-4">{system.name}</h1>

          <p className="vix-meta mt-9">What it fixes</p>
          <p className="vix-body mt-3 max-w-[520px]">{system.what_it_fixes}</p>
        </div>

        {/* Seventeen of the twenty-five have no image on the site. They show
            none here either, rather than a stand-in that was never chosen. */}
        {system.image && (
          <div className="aspect-[4/5] w-full max-w-[340px] justify-self-end overflow-hidden bg-white/[0.04]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/systems/${system.image}`}
              alt=""
              className="h-full w-full object-cover"
            />
          </div>
        )}
      </div>

      <section className="vix-rule mt-14 border-t pt-10">
        <p className="vix-meta">What it is</p>
        <p className="vix-lead mt-4">{system.what_it_is}</p>
      </section>

      <section className="vix-rule mt-14 border-t pt-10">
        <p className="vix-meta">What you get</p>
        <ul className="mt-6 grid max-w-[900px] gap-x-12 sm:grid-cols-2">
          {system.what_you_get.map((item, i) => (
            <li key={item} className="vix-rule flex items-baseline gap-4 border-b py-4">
              <span className="vix-meta shrink-0 tabular-nums">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="text-[15px] text-white/75">{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="vix-rule mt-14 border-t pt-10">
        <p className="vix-meta">Who it is for</p>
        <p className="vix-h2 mt-4 max-w-[900px]">{system.who_it_is_for}</p>

        {/*
          The site's call to action is "Book a Consultation". Here it is the
          conversation they already have with us — a client who is signed in
          does not need to book anything to reach the team.
        */}
        <Link href="/portal/support" className="vix-btn mt-9">
          Ask us about this
        </Link>
      </section>

      {siblings.length > 1 && (
        <section className="vix-rule mt-14 border-t pt-10">
          <p className="vix-meta">Also in this family</p>
          <ul className="mt-6">
            {siblings
              .filter((s) => s.slug !== system.slug)
              .map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/portal/systems/${s.slug}`}
                    className="vix-rule flex items-baseline gap-5 border-b py-4 hover:bg-white/[0.03]"
                  >
                    <span className="vix-meta shrink-0 tabular-nums">
                      {String(s.position).padStart(2, '0')}
                    </span>
                    <span className="flex-1 text-[15px] font-semibold">{s.name}</span>
                    <span aria-hidden="true" className="vix-meta shrink-0">→</span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  );
}
