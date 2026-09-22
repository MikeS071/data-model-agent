import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Model Foundry',
  description: 'A focused workspace for developing reviewable insurance data models.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
