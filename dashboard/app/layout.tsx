import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Carrier Desk',
  description: 'Inbound carrier calls handled by the AI agent: outcomes, rates and what needs a rep.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
