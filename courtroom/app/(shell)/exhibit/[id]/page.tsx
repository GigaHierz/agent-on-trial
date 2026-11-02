import Link from 'next/link';
import { celoscanTx } from '@trial/shared';
import { RedisNotice } from '@/components/RedisNotice';
import { VerifyButton } from '@/components/VerifyButton';
import { Card } from '@/components/ui/Card';
import { LetterBadge } from '@/components/ui/LetterBadge';
import { Pill } from '@/components/ui/Pill';
import { gatewayUrl } from '@/lib/env';
import { DEFAULT_ROUND, RoundId } from '@/lib/keys';
import { COLUMN_TITLES, exhibitHref } from '@/lib/links';
import { getRedis } from '@/lib/redis';
import { currentRound, getEvidence } from '@/lib/store';

export const dynamic = 'force-dynamic';

const PILL = 'no-underline hover:bg-white/10';

export default async function ExhibitPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ round?: string }>;
}) {
  const [{ id }, { round: roundParam }] = await Promise.all([params, searchParams]);
  if (!getRedis()) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        <RedisNotice />
      </main>
    );
  }
  const round =
    roundParam && RoundId.safeParse(roundParam).success ? roundParam : await currentRound().catch(() => DEFAULT_ROUND);
  const evidence = await getEvidence(round);
  const exhibit = evidence?.exhibits.find((e) => e.id === id);
  const gateway = gatewayUrl();

  if (!exhibit) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-bold">Exhibit {id}</h1>
        <p className="mt-4 text-fg-2">Not in the evidence for round {round}.</p>
      </main>
    );
  }

  const link = exhibitHref(exhibit, gateway);
  const letter = exhibit.id[0] as keyof typeof COLUMN_TITLES;
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Pill tone="mint">
            {letter} · {COLUMN_TITLES[letter] ?? 'Exhibit'}
          </Pill>
          <Pill>round {round}</Pill>
          <Pill>{exhibit.act}</Pill>
          <Pill>{exhibit.kind}</Pill>
          {exhibit.fixture && <Pill tone="amber">recorded</Pill>}
        </div>
        <h1 className="flex items-start gap-3 text-3xl font-bold leading-tight sm:text-4xl">
          <LetterBadge id={exhibit.id} className="mt-1 w-auto text-2xl sm:text-3xl" />
          <span className="min-w-0 break-words">{exhibit.title}</span>
        </h1>
      </header>

      <ul className="flex flex-wrap gap-2">
        {exhibit.txHash && (
          <li>
            <a className={PILL} href={celoscanTx(exhibit.txHash)} target="_blank" rel="noreferrer">
              <Pill tone="mint">Transaction on Celoscan ↗</Pill>
            </a>
          </li>
        )}
        {link && !exhibit.txHash && (
          <li>
            <a className={PILL} href={link.href} target="_blank" rel="noreferrer">
              <Pill tone="mint">Open stored file ↗</Pill>
            </a>
          </li>
        )}
        {exhibit.url && exhibit.url !== link?.href && (
          <li>
            <a className={PILL} href={exhibit.url} target="_blank" rel="noreferrer">
              <Pill>Service link ↗</Pill>
            </a>
          </li>
        )}
        <li className="hidden md:block">
          <Link className={PILL} href={`/projector?r=${encodeURIComponent(round)}`}>
            <Pill>← Back to the board</Pill>
          </Link>
        </li>
      </ul>

      <VerifyButton id={exhibit.id} round={round} />

      <Card className="p-0">
        <div className="eyebrow border-b border-line px-5 py-3 text-fg-3">Exhibit record</div>
        <pre className="overflow-x-auto p-5 text-xs leading-relaxed whitespace-pre-wrap break-all text-fg-2 sm:text-sm">
          {JSON.stringify(exhibit, null, 2)}
        </pre>
      </Card>
    </main>
  );
}
