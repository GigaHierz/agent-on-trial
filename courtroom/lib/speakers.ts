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
  { name: 'Lena Hierzi', role: 'DevRel Lead', company: 'Celo Core Co.', x: 'https://x.com/GigaHierz', handle: '@GigaHierz', photo: '/speakers/lena.jpg' },
  { name: 'Fortunato Cinquepalmi', role: 'Product Lead', company: 'Kleros', x: 'https://x.com/fortuvp', handle: '@fortuvp', photo: '/speakers/fortunato.jpg' },
  { name: 'András Arányi', role: 'CTO', company: 'Solar Punk', x: 'https://x.com/ethswarm', handle: '@ethswarm', photo: '/speakers/andras.jpg' },
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

export const EVENT = { date: '4 November', time: '4:15 PM IST', venue: 'Jasmine Stage 4, Devcon', city: 'Jio World Convention Centre, Mumbai' };
