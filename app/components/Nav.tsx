"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/clips", label: "Clips" },
  { href: "/post-submit", label: "Post & Submit" },
  { href: "/connections", label: "Connections" },
  { href: "/interventions", label: "Interventions" },
  { href: "/activity", label: "Activity" },
  { href: "/settings", label: "Settings" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            className={`rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-accent/15 text-accent font-semibold"
                : "text-slate-300 hover:bg-line hover:text-white"
            }`}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
