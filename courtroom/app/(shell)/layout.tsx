import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';

/**
 * The viewport is the frame: nav on top, footer at the bottom, both always
 * visible. The middle takes the remaining height. Short pages (vote) sit
 * inside it without any scrolling; long pages (home) scroll inside the
 * middle; the chat and the live log keep their own scrolling transcript box.
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      <Nav />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      <Footer />
    </div>
  );
}
