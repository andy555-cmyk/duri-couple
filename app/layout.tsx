import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '둘의 말 — 한일 커플을 위한 대화',
  description: '말하고, 배우고, 함께 기억하는 한일 커플 전용 대화 앱',
  metadataBase: new URL('https://duri-couple.andyleee.chatgpt.site'),
  openGraph: {
    title: '둘의 말',
    description: '말하고, 배우고, 함께 기억하는 한일 커플 앱',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: '둘의 말',
    description: '말하고, 배우고, 함께 기억하는 한일 커플 앱',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
