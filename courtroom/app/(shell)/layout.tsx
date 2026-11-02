import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';

/**
 * Nav for every public and host page. The viewport is the frame: full-height
 * views (chat, live log, vote) fill the space under the nav and scroll inside;
 * document pages live in (pages) and add the footer.
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      <Nav />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
