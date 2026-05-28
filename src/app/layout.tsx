import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PixelForge — AI Studio",
  description: "Local-first AI image & video studio orchestrating KIE.ai models.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="bg-pf-bg text-pf-text">
        <div className="grid grid-cols-[240px_1fr] min-h-screen">
          <Sidebar />
          <main className="px-10 py-7 pb-16 max-w-[1400px]">{children}</main>
        </div>
      </body>
    </html>
  );
}
