"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AppMode, MODE_EVENT, getMode } from "./mode";
import {
  IconActivity,
  IconBell,
  IconCampaign,
  IconClips,
  IconConnections,
  IconDashboard,
  IconPhone,
  IconPost,
  IconSettings,
  IconShield,
  IconUser,
} from "./icons";
import type { JSX } from "react";

export interface TabItem {
  href: string;
  label: string;
  icon: (p: { className?: string }) => JSX.Element;
}

/** v1 = server-side ClipFlow · v2 = phone automation (sab separate) */
export const NAV_V1: TabItem[] = [
  { href: "/", label: "Dashboard", icon: IconDashboard },
  { href: "/campaigns", label: "Campaigns", icon: IconCampaign },
  { href: "/clips", label: "Clips", icon: IconClips },
  { href: "/post-submit", label: "Post & Submit", icon: IconPost },
  { href: "/connections", label: "Connections", icon: IconConnections },
  { href: "/interventions", label: "Interventions", icon: IconBell },
  { href: "/activity", label: "Activity", icon: IconActivity },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

export const NAV_V2: TabItem[] = [
  { href: "/devices", label: "Devices", icon: IconPhone },
  { href: "/devices/live", label: "Live", icon: IconActivity },
];

/** backward-compat: purana NAV export v1 hai */
export const NAV = NAV_V1;

export const PROFILE_ITEM: TabItem = {
  href: "/profile",
  label: "Profile",
  icon: IconUser,
};

const ADMIN_ITEM: TabItem = { href: "/admin", label: "Admin", icon: IconShield };

export function isActiveTab(href: string, path: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

function TabLink({ item, active }: { item: TabItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link href={item.href} className={`tab-item ${active ? "active" : ""}`}>
      <Icon />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/** Desktop sidebar nav — saare tabs + profile + admin */
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
  // sabse lamba match jeetta hai — /devices/live pe sirf Live highlight ho
  const allItems = [...base, PROFILE_ITEM, ...(showAdmin ? [ADMIN_ITEM] : [])];
  const activeHref = allItems.reduce<string | null>(
    (best, n) =>
      isActiveTab(n.href, path) && (best === null || n.href.length > best.length)
        ? n.href
        : best,
    null
  );
  return (
    <nav className="flex flex-col gap-1">
      {base.map((n) => (
        <TabLink key={n.href} item={n} active={n.href === activeHref} />
      ))}
      <div className="glow-line my-2" />
      <TabLink
        item={PROFILE_ITEM}
        active={PROFILE_ITEM.href === activeHref}
      />
      {showAdmin && (
        <TabLink item={ADMIN_ITEM} active={ADMIN_ITEM.href === activeHref} />
      )}
    </nav>
  );
}

/** Mobile "More" sheet ke liye poori tab list */
export function useAllTabs() {
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
  const tabs = [...base, PROFILE_ITEM];
  if (showAdmin) tabs.push(ADMIN_ITEM);
  return { tabs, mode };
}
