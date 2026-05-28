"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { StatusStrip } from "./StatusStrip";

type Item = { href: string; label: string; badge?: string };

const ITEMS: Item[] = [
  { href: "/",      label: "Image" },
  { href: "/video", label: "Video" },
];

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 bg-pf-elev/95 backdrop-blur-md border-b border-pf-border">
      <div className="flex items-center gap-6 px-5 h-14">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-md bg-pf-accent flex items-center justify-center text-pf-accent-fg font-bold text-sm">
            P
          </div>
          <span className="font-bold tracking-tight text-pf-text">PixelForge</span>
        </Link>

        <nav className="flex items-center gap-1 overflow-x-auto flex-1">
          {ITEMS.map((it) => {
            const active = pathname === it.href;
            return (
              <Link
                key={it.href}
                href={it.href}
                className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
                  active
                    ? "text-pf-accent"
                    : "text-pf-dim hover:text-pf-text"
                }`}
              >
                {it.label}
                {it.badge && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-pf-accent text-pf-accent-fg font-bold">
                    {it.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="shrink-0">
          <StatusStrip variant="horizontal" />
        </div>
      </div>
    </header>
  );
}
