import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ekai Memory Vault",
  description: "Memory management and knowledge graph explorer",
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <nav className="bg-white border-b border-stone-200 sticky top-0 z-30">
          <div className="max-w-7xl mx-auto px-6 h-11 flex items-center gap-6">
            <span className="text-xs font-bold text-teal-600 tracking-widest uppercase mr-2">Ekai</span>
            <Link href="/memory" className="text-sm font-medium text-stone-600 hover:text-teal-600 transition-colors">
              Memory Vault
            </Link>
            <Link href="/agents" className="text-sm font-medium text-stone-600 hover:text-teal-600 transition-colors">
              Agents
            </Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
