import type { Metadata } from "next";
import "./globals.css";
import { NavBar } from "@/components/NavBar";
import { SiteFooter } from "@/components/SiteChrome";

export const metadata: Metadata = {
  title: "PageLock — every page accounted for",
  description: "Make multi-page agreements tamper-evident. Runs entirely in your browser.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        <NavBar />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:py-10">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
