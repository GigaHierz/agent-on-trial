const MENU = [
  { name: 'Flat white', price: '4.50' },
  { name: 'Butter croissant', price: '3.20' },
  { name: 'Soup of the day with bread', price: '9.80' },
];

const ADDRESS = {
  street: 'Bahnhofstrasse 1',
  postalCode: '8001',
  city: 'Zürich',
  country: 'Switzerland',
};

/**
 * The page the defendant reviews on askbots.ai. Static apart from the runId.
 * Deliberately outside the site shell: no nav, footer or speaker links, so
 * the agent reads a plain café page and nothing about the trial.
 */
export default async function PropertyPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: 'Trial Café',
    description: 'A small café used as the test property for a live agent trial.',
    address: {
      '@type': 'PostalAddress',
      streetAddress: ADDRESS.street,
      postalCode: ADDRESS.postalCode,
      addressLocality: ADDRESS.city,
      addressCountry: 'CH',
    },
    openingHours: ['Mo-Fr 07:00-18:00', 'Sa 08:00-16:00'],
    priceRange: 'USD₮ 3-10',
    identifier: safeRunId,
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12 sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <header>
        <p className="text-sm text-fg-3">run {safeRunId}</p>
        <h1 className="mt-1 text-5xl font-bold">Trial Café</h1>
        <p className="mt-3 text-xl text-fg-2">
          A small café by the station. Coffee, pastries and one warm dish a day. Card and USD₮ accepted.
        </p>
      </header>

      <section>
        <h2 className="text-2xl font-semibold">Opening hours</h2>
        <ul className="mt-2 text-lg text-fg-2">
          <li>Monday to Friday, 07:00 to 18:00</li>
          <li>Saturday, 08:00 to 16:00</li>
          <li>Sunday closed</li>
        </ul>
      </section>

      <section>
        <h2 className="text-2xl font-semibold">Menu</h2>
        <table className="mt-2 w-full text-lg">
          <tbody>
            {MENU.map((item) => (
              <tr key={item.name} className="border-b border-line">
                <td className="py-2">{item.name}</td>
                <td className="py-2 text-right">{item.price} USD₮</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-2xl font-semibold">Address</h2>
        <address className="mt-2 text-lg not-italic text-fg-2">
          Trial Café
          <br />
          {ADDRESS.street}
          <br />
          {ADDRESS.postalCode} {ADDRESS.city}
          <br />
          {ADDRESS.country}
        </address>
      </section>
    </main>
  );
}
