'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Plays its diagram once, beat by beat, when it scrolls into view: on stage the
 * presenter's scroll is the cue. The beats themselves are CSS (globals.css,
 * [data-beat]), so they run off the main thread.
 */
export function Reveal({ children, label, boxed = true }: { children: ReactNode; label: string; boxed?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setInView(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      // Its top well inside the screen, however tall it is (the steps list is taller than a phone).
      { threshold: 0, rootMargin: '0px 0px -20% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} role={boxed ? 'img' : undefined} aria-label={boxed ? label : undefined} data-reveal={inView ? 'in' : 'wait'} className={boxed ? 'diagram' : undefined}>
      {children}
    </div>
  );
}
