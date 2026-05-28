"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { StatusStrip } from "./StatusStrip";

type Item = { href: string; label: string };
type Section = { heading: string; items: Item[] };

const SECTIONS: Section[] = [
  {
    heading: "Create",
    items: [
      { href: "/", label: "Image generation" },
      { href: "/batch-edit", label: "Batch image edit" },
      { href: "/video", label: "Video generation" },
    ],
  },
  {
    heading: "Translate & brand",
    items: [{ href: "/translate", label: "Translate page" }],
  },
  {
    heading: "Talking heads",
    items: [{ href: "/avatar", label: "Kling Avatar" }],
  },
  {
    heading: "Post-production",
    items: [
      { href: "/upscale", label: "Upscale (Topaz)" },
      { href: "/history", label: "History" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="bg-pf-elev border-r border-pf-border p-5 flex flex-col gap-1 sticky top-0 h-screen overflow-auto">
      <div className="px-3 pb-5 pt-1">
        <div className="font-bold tracking-tight">PixelForge</div>
        <div className="text-[11px] text-pf-muted mt-0.5">cloud AI studio</div>
      </div>

      {SECTIONS.map((sec) => (
        <div key={sec.heading} className="mb-1">
          <div className="text-[10px] uppercase tracking-[1.2px] text-pf-muted px-3 pt-3 pb-1">
            {sec.heading}
          </div>
          {sec.items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  "block px-3 py-2 rounded-lg select-none border border-transparent",
                  active
                    ? "bg-pf-soft text-pf-accent border-pf-border"
                    : "text-pf-dim hover:bg-pf-soft hover:text-pf-text",
                ].join(" ")}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}

      <StatusStrip />
    </aside>
  );
}
