"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  IconActivity,
  IconCampaign,
  IconConnections,
  IconPhone,
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

/** V1 removed (2026-09-19): single V2-only nav — phone automation + shared tabs. */
export const NAV: TabItem[] = [
  { href: "/devices", label: "Devices", icon: IconPhone },
  { href: "/devices/live", label: "Live", icon: IconActivity },
  { href: "/campaigns", label: "Campaigns", icon: IconCampaign },
  { href: "/connections", label: "Connections", icon: IconConnections },
  { href: "/activity", label: "Activity", icon: IconActivity },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

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

  useEffect(() => {
    fetch("/api/admin/is-owner")
      .then((r) => r.json())
      .then((j) => setShowAdmin(Boolean(j.isOwner)))
      .catch(() => {});
  }, []);

  // sabse lamba match jeetta hai — /devices/live pe sirf Live highlight ho
  const allItems = [...NAV, PROFILE_ITEM, ...(showAdmin ? [ADMIN_ITEM] : [])];
  const activeHref = allItems.reduce<string | null>(
    (best, n) =>
      isActiveTab(n.href, path) && (best === null || n.href.length > best.length)
        ? n.href
        : best,
    null
  );
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((n) => (
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
  useEffect(() => {
    fetch("/api/admin/is-owner")
      .then((r) => r.json())
      .then((j) => setShowAdmin(Boolean(j.isOwner)))
      .catch(() => {});
  }, []);
  const tabs = [...NAV, PROFILE_ITEM];
  if (showAdmin) tabs.push(ADMIN_ITEM);
  return { tabs };
}
