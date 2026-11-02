const ACTS: { n: number; name: string; text: string }[] = [
  { n: 1, name: 'Identity', text: 'Mints an ERC-8004 identity on Celo.' },
  { n: 2, name: 'Earn', text: 'Reviews a website on askbots.ai, earns 0.10 USD₮.' },
  { n: 3, name: 'Spend', text: 'Pays for an API through x402.' },
  { n: 4, name: 'Dispute', text: 'Gets sold junk, opens a dispute, the ruling lands as feedback.' },
  { n: 5, name: 'Verdict', text: 'You vote, the jury writes it on chain.' },
];

export function Acts() {
  return (
    <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {ACTS.map((a) => (
        <li key={a.n} className="rounded-2xl border border-line bg-white/[0.03] p-5">
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-bold text-mint">{a.n}</span>
            <span className="font-bold">{a.name}</span>
          </div>
          <p className="mt-2 text-sm text-fg-2">{a.text}</p>
        </li>
      ))}
    </ol>
  );
}
