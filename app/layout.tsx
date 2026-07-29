import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const imageUrl = host ? `${protocol}://${host}/og.png` : undefined;

  return {
    title: "BAN Predictor | 第五人格ランク戦予測",
    description:
      "第五人格のランク戦BANデータから、ピックされる可能性の高いハンターを素早く予測・共有するツール。",
    openGraph: {
      title: "BAN Predictor | 第五人格ランク戦予測",
      description: "BANを選ぶ。次の一手が見える。",
      type: "website",
      images: imageUrl ? [{ url: imageUrl, width: 1200, height: 630 }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: "BAN Predictor | 第五人格ランク戦予測",
      description: "BANを選ぶ。次の一手が見える。",
      images: imageUrl ? [imageUrl] : undefined,
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
