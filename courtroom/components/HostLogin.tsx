import { Card } from './ui/Card';
import { Pill } from './ui/Pill';

export function HostLogin({ to, denied }: { to: string; denied?: boolean }) {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-57px)] max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <Card className="flex flex-col gap-5">
        <Pill tone="mint" className="self-start">
          Host only
        </Pill>
        <div>
          <h1 className="text-2xl font-bold">Enter the host secret</h1>
          <p className="mt-1 text-sm text-fg-2">It opens {to} on this device for a week.</p>
        </div>
        <form method="post" action="/api/host" className="flex flex-col gap-3">
          <input type="hidden" name="to" value={to} />
          <input
            type="password"
            name="key"
            autoComplete="off"
            required
            placeholder="HOST_SECRET"
            className="rounded-xl border border-line bg-white/5 px-4 py-3 text-lg focus:border-mint focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-xl bg-mint px-4 py-3 text-lg font-semibold text-ink hover:bg-mint-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
          >
            Enter
          </button>
        </form>
        {denied && <p className="text-rose-300">That key did not match.</p>}
      </Card>
    </main>
  );
}
