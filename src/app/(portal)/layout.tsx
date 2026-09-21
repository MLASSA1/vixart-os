import type { ReactNode } from 'react';

/**
 * The portal's own shell.
 *
 * Nothing is shared with the internal application's layout: no sidebar, no
 * navigation into the business, no counts. What a client sees is written here
 * from scratch, so a link added to the staff shell can never appear on a
 * client's screen by inheritance.
 */
export default function PortalRootLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
