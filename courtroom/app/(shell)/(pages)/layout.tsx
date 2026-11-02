import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer';

/** Document-style pages: content then the footer, scrolling as one. */
export default function PagesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">{children}</div>
      <Footer />
    </div>
  );
}
