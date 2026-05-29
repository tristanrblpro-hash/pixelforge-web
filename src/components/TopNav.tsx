"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { HoverMegaMenu, ImageMegaMenu, VideoMegaMenu } from "./NavMegaMenu";

type Item = { href: string; label: string; menu?: "image" | "video" };

const ITEMS: Item[] = [
  { href: "/briefs",       label: "Briefs" },
  { href: "/",             label: "Image",        menu: "image" },
  { href: "/video",        label: "Video",        menu: "video" },
  { href: "/prompts",      label: "Prompts" },
  { href: "/copies",       label: "Ad Copies" },
  { href: "/voiceover",    label: "Voiceover" },
  { href: "/transcribe",   label: "Transcribe" },
  { href: "/cut-silence",  label: "Cut Silence" },
];

function NavLink({ item, active }: { item: Item; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
        active ? "text-pf-accent" : "text-pf-dim hover:text-pf-text"
      }`}
    >
      {item.label}
    </Link>
  );
}

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 bg-pf-elev/95 backdrop-blur-md border-b border-pf-border">
      <div className="flex items-center gap-6 px-5 h-14">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-md bg-pf-accent flex items-center justify-center text-pf-accent-fg font-bold text-sm">
            P
          </div>
          <span className="font-bold tracking-tight text-pf-text">PixelForge</span>
        </Link>

        {/* Nav with hover mega menus */}
        <nav className="flex items-center gap-1 flex-1">
          {ITEMS.map((it) => {
            const active = pathname === it.href || (it.href === "/" && pathname === "/");
            const link = <NavLink item={it} active={active} />;
            if (it.menu === "image") {
              return (
                <HoverMegaMenu key={it.href} trigger={link} menu={<ImageMegaMenu />} />
              );
            }
            if (it.menu === "video") {
              return (
                <HoverMegaMenu key={it.href} trigger={link} menu={<VideoMegaMenu />} />
              );
            }
            return <NavLink key={it.href} item={it} active={active} />;
          })}
        </nav>

        {/* Right side: minimalist search hint + avatar */}
        <div className="hidden md:flex items-center gap-3 shrink-0">
          <button
            type="button"
            className="flex items-center gap-2 bg-pf-soft border border-pf-border text-pf-dim hover:text-pf-text rounded-full pl-3 pr-2 py-1.5 text-xs"
            aria-label="Search (coming soon)"
          >
            <Search size={13} />
            <span>Search</span>
            <span className="ml-2 px-1.5 py-0.5 rounded bg-pf-bg border border-pf-border text-[10px] font-mono">
              ⌘K
            </span>
          </button>

          <div
            className="w-8 h-8 rounded-full bg-gradient-to-br from-pf-accent to-emerald-500 flex items-center justify-center text-pf-accent-fg font-bold text-sm shrink-0"
            title="You"
          >
            T
          </div>
        </div>
      </div>
    </header>
  );
}
