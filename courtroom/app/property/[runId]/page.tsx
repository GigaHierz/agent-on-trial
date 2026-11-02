const ENDPOINTS = [
  { path: 'GET /v1/forecast?lat=&lon=', what: 'Seven-day forecast for a coordinate', price: '0.01' },
  { path: 'GET /v1/now?lat=&lon=', what: 'Current conditions for a coordinate', price: '0.005' },
  { path: 'GET /v1/alerts?lat=&lon=', what: 'Active weather warnings for a coordinate', price: '0.005' },
];

/**
 * The page the defendant reviews on askbots.ai: another agent's product, an
 * x402 weather API sold per call. Static apart from the runId.
 * Deliberately outside the site shell: no nav, footer or speaker links, so
 * the reviewer reads a plain product page and nothing about the trial.
 */
export default async function PropertyPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebAPI',
    name: 'Trial Weather',
    description: 'A weather API for AI agents. Pay per call with USD₮ over x402 on Celo. No account, no API key.',
    documentation: 'https://agent-on-trial.xyz/property/' + safeRunId,
    termsOfService: 'Pay per call. No refunds for a 2xx response.',
    provider: { '@type': 'Organization', name: 'Trial Weather' },
    offers: ENDPOINTS.map((e) => ({ '@type': 'Offer', name: e.path, price: e.price, priceCurrency: 'USDT' })),
    identifier: safeRunId,
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12 sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <header>
        <p className="text-sm text-fg-3">build {safeRunId}</p>
        <h1 className="mt-1 text-5xl font-bold">Trial Weather</h1>
        <p className="mt-3 text-xl text-fg-2">
          A weather API for AI agents. Pay per call with USD₮ over x402 on Celo. No account, no API key, no subscription.
        </p>
      </header>

      <section>
        <h2 className="text-2xl font-semibold">Endpoints and prices</h2>
        <table className="mt-2 w-full text-lg">
          <tbody>
            {ENDPOINTS.map((e) => (
              <tr key={e.path} className="border-b border-line align-top">
                <td className="py-2 pr-4">
                  <div>{e.path}</div>
                  <div className="text-sm text-fg-3">{e.what}</div>
                </td>
                <td className="py-2 text-right whitespace-nowrap">{e.price} USD₮</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-sm text-fg-3">Base URL https://api.trial-weather.example. Prices are per request, settled by the Celo x402 facilitator.</p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold">How an agent pays</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-6 text-lg text-fg-2">
          <li>Call the endpoint. The server answers 402 with the price, the token and the pay-to address.</li>
          <li>Sign a USD₮ transfer authorization for that amount and retry with it in the payment header.</li>
          <li>Get the data. The facilitator settles on Celo; the transaction hash comes back in the response.</li>
        </ol>
      </section>

      <section>
        <h2 className="text-2xl font-semibold">For agents</h2>
        <ul className="mt-2 space-y-1 text-lg text-fg-2">
          <li>Machine-readable catalog: /v1/catalog (free)</li>
          <li>Service description: /llms.txt</li>
          <li>Uptime, last 30 days: 99.7 percent</li>
          <li>Contact: ops@trial-weather.example</li>
        </ul>
      </section>
    </main>
  );
}
