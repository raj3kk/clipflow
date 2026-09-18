"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AppMode, MODE_EVENT, getMode } from "./mode";

/** v1 = purana server-side ClipFlow · v2 = phone automation (sab separate) */
export const NAV_V1 = [
  { href: "/", label: "Dashboard" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/clips", label: "Clips" },
  { href: "/post-submit", label: "Post & Submit" },
  { href: "/connections", label: "Connections" },
  { href: "/interventions", label: "Interventions" },
  { href: "/activity", label: "Activity" },
  { href: "/settings", label: "Settings" },
];

export const NAV_V2 = [
  { href: "/devices", label: "Devices" },
];

/** backward-compat: purana NAV export v1 hai */
export const NAV = NAV_V1;

const ADMIN_ITEM = { href: "/admin", label: "Admin" };

export default function Nav() {
  const path = usePathname();
  const [showAdmin, setShowAdmin] = useState(false);
  const [mode, setModeState] = useState<AppMode>("v1");

  useEffect(() => {
    setModeState(getMode());
    const h = (e: Event) =>
      setModeState((e as CustomEvent<AppMode>).detail ?? getMode());
    window.addEventListener(MODE_EVENT, h);
    return () => window.removeEventListener(MODE_EVENT, h);
  }, []);

  useEffect(() => {
    fetch("/api/admin/is-owner")
      .then((r) => r.json())
      .then((j) => setShowAdmin(Boolean(j.isOwner)))
      .catch(() => {});
  }, []);

  const base = mode === "v2" ? NAV_V2 : NAV_V1;
  const items = showAdmin ? [...base, ADMIN_ITEM] : base;
  return (
    <nav className="flex flex-col gap-1">
      {items.map((n) => {
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
