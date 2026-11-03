import { Suspense } from 'react';
import { VoteClient } from '@/components/VoteClient';

export const dynamic = 'force-dynamic';

export default function VotePage() {
  // useSearchParams needs a Suspense boundary.
  return (
    <Suspense fallback={<main className="px-6 py-10 text-neutral-500">Loading.</main>}>
      <VoteClient />
    </Suspense>
  );
}
