import Link from 'next/link';
import { celoscanTx } from '@trial/shared';
import { RedisNotice } from '@/components/RedisNotice';
import { VerifyButton } from '@/components/VerifyButton';
import { gatewayUrl } from '@/lib/env';
import { DEFAULT_ROUND, RoundId } from '@/lib/keys';
import { exhibitHref } from '@/lib/links';
import { getRedis } from '@/lib/redis';
import { currentRound, getEvidence } from '@/lib/store';

export const dynamic = 'force-dynamic';

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
      <main className="mx-auto max-w-2xl px-6 py-12">
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
      <main className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="text-3xl font-bold">Exhibit {id}</h1>
        <p className="mt-4 text-neutral-400">Not in the evidence for round {round}.</p>
      </main>
    );
  }

  const link = exhibitHref(exhibit, gateway);
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12">
      <header>
        <p className="font-mono text-neutral-400">
          round {round} · {exhibit.act} · {exhibit.kind}
          {exhibit.fixture ? ' · recorded' : ''}
        </p>
        <h1 className="mt-1 text-4xl font-bold">
          <span className="mr-3 font-mono text-neutral-400">{exhibit.id}</span>
          {exhibit.title}
        </h1>
      </header>

      <ul className="flex flex-wrap gap-4 text-lg">
        {exhibit.txHash && (
          <li>
            <a className="text-sky-300 underline" href={celoscanTx(exhibit.txHash)} target="_blank" rel="noreferrer">
              Transaction on Celoscan
            </a>
          </li>
        )}
        {link && !exhibit.txHash && (
          <li>
            <a className="text-sky-300 underline" href={link.href} target="_blank" rel="noreferrer">
              Open stored file
            </a>
          </li>
        )}
        {exhibit.url && exhibit.url !== link?.href && (
          <li>
            <a className="text-sky-300 underline" href={exhibit.url} target="_blank" rel="noreferrer">
              Service link
            </a>
          </li>
        )}
        <li>
          <Link className="text-neutral-400 underline" href={`/projector?r=${encodeURIComponent(round)}`}>
            Back to the board
          </Link>
        </li>
      </ul>

      <VerifyButton id={exhibit.id} round={round} />

      <pre className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-all">
        {JSON.stringify(exhibit, null, 2)}
      </pre>
    </main>
  );
}
