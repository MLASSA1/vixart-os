import type { ReactNode } from 'react';

/**
 * The top of every portal page: whose space this is, where they are, and one
 * sentence on what the page is for. The same three lines everywhere, so a
 * client never has to work out which page they have landed on.
 */
export function PortalTitle({
  eyebrow,
  title,
  lead,
  back,
}: {
  eyebrow: string;
  title: string;
  lead?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header>
      {back ? (
        <a href={back.href} className="vix-meta hover:text-white">← {back.label}</a>
      ) : (
        <p className="vix-meta">{eyebrow}</p>
      )}
      <h1 className="vix-h1 mt-4">{title}</h1>
      {lead && <p className="vix-lead mt-4">{lead}</p>}
    </header>
  );
}
