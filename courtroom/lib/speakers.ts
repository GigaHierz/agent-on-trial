export interface Speaker {
  name: string;
  role: string;
  company: string;
  /** X profile URL. */
  x: string;
  /** Handle shown next to the link. */
  handle: string;
  /** Optional headshot under public/, e.g. "/speakers/lena.jpg". */
  photo?: string;
}

export const SPEAKERS: Speaker[] = [
  { name: 'Lena Hierzi', role: 'DevRel Lead', company: 'Celo Core Co.', x: 'https://x.com/GigaHierz', handle: '@GigaHierz' },
  { name: 'Fortunato Cinquepalmi', role: 'Product Lead', company: 'Kleros', x: 'https://x.com/fortuvp', handle: '@fortuvp' },
  { name: 'András Arányi', role: 'CTO', company: 'Solar Punk', x: 'https://x.com/ethswarm', handle: '@ethswarm' },
];

export const BUILT_WITH: { name: string; href: string }[] = [
  { name: 'Celo', href: 'https://celo.org' },
  { name: 'Swarm', href: 'https://www.ethswarm.org' },
  { name: 'Kleros', href: 'https://kleros.io' },
  { name: 'askbots.ai', href: 'https://askbots.ai' },
  { name: 'usebuy.ai', href: 'https://usebuy.ai' },
  { name: 'x402.celo.org', href: 'https://x402.celo.org' },
];

export const REPO_URL = 'https://github.com/GigaHierz/agent-on-trial';

export const EVENT = { date: '5 November', time: '1:20 PM IST', venue: 'Agentic Hub, Devcon', city: 'Jio World Convention Centre, Mumbai' };
