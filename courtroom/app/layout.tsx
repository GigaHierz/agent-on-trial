import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: 'An Agent on Trial',
  description:
    'Can We Trust the Machines? A Live Trial. A real agent earns, pays, gets disputed and is judged on Celo. The evidence is on chain. You decide.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0f0d',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <body className="grid-bg min-h-screen bg-ink font-mono text-fg antialiased">{children}</body>
    </html>
  );
}
