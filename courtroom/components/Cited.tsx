import Link from 'next/link';

const CITE = /(\[[ABCDV]\d+\])/g;

/** Renders [A1]-style citations as links to the exhibit page. */
export function Cited({ text, round }: { text: string; round: string }) {
  const parts = text.split(CITE);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[([ABCDV]\d+)\]$/.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        return (
          <Link
            key={i}
            href={`/exhibit/${m[1]}?round=${encodeURIComponent(round)}`}
            target="_blank"
            className="mx-0.5 rounded-md bg-mint/15 px-1.5 text-mint no-underline hover:bg-mint/25"
          >
            {m[1]}
          </Link>
        );
      })}
    </>
  );
}
