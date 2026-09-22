"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Nav, { NAV, PROFILE_ITEM, isActiveTab, useAllTabs } from "./Nav";
import { IconMore, IconUser, IconX, IconLogout } from "./icons";
import AgentWidget from "./AgentWidget";
import { getBrowserSupabase } from "@/lib/supabase-browser";

/* ---------- logo ---------- */
function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link href="/devices" className="group flex items-center gap-2.5">
      <img
        src="/brand-cf.webp"
        alt="ClipFlow"
        className="h-9 w-9 rounded-xl bg-white object-contain shadow-sm transition-transform duration-300 group-hover:scale-105"
      />
      {!compact && (
        <span className="leading-tight">
          <span className="text-lg font-bold tracking-tight text-slate-900">ClipFlow</span>
          <span className="block text-[10px] uppercase tracking-widest text-slate-500">
            phone automation
          </span>
        </span>
      )}
    </Link>
  );
}

/* ---------- profile icon (header) ---------- */
function ProfileIcon() {
  const path = usePathname();
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let s: ReturnType<typeof getBrowserSupabase> | null = null;
    try {
      s = getBrowserSupabase();
    } catch {
      return;
    }
    s.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);
  const initial = (email?.[0] ?? "?").toUpperCase();
  const active = isActiveTab(PROFILE_ITEM.href, path);
  return (
    <Link
      href={PROFILE_ITEM.href}
      title={email ?? "Profile"}
      className={`grid h-10 w-10 place-items-center rounded-full bg-emerald-600 text-sm font-bold text-white transition-transform hover:scale-105 active:scale-95 ${
        active ? "ring-2 ring-emerald-300 ring-offset-2" : ""
      }`}
    >
      {email ? initial : <IconUser className="h-5 w-5" />}
    </Link>
  );
}

/* ---------- mobile bottom nav ---------- */
function MobileTabs() {
  const path = usePathname();
  const router = useRouter();
  const { tabs } = useAllTabs();
  const [sheetOpen, setSheetOpen] = useState(false);

  const primary = NAV.slice(0, 4);
  const overflow = tabs.filter((t) => !primary.some((p) => p.href === t.href));
  // sabse lamba match jeetta hai — /devices/live pe sirf Live highlight ho
  const activeHref = [...primary, ...overflow].reduce<string | null>(
    (best, t) =>
      isActiveTab(t.href, path) && (best === null || t.href.length > best.length)
        ? t.href
        : best,
    null
  );

  useEffect(() => {
    setSheetOpen(false);
  }, [path]);

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-stretch justify-around px-2 pb-1 pt-1.5">
          {primary.map((t) => {
            const Icon = t.icon;
            const active = t.href === activeHref;
            return (
              <Link key={t.href} href={t.href} className={`mtab ${active ? "active" : ""}`}>
                <span className="mdot" />
                <Icon className="h-6 w-6" />
                <span className="max-w-[64px] truncate">{t.label}</span>
              </Link>
            );
          })}
          <button
            className={`mtab ${sheetOpen ? "active" : ""}`}
            onClick={() => setSheetOpen(true)}
            aria-label="More tabs"
          >
            <span className="mdot" />
            <IconMore className="h-6 w-6" />
            <span>More</span>
          </button>
        </div>
      </nav>

      {/* More sheet */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-up"
            onClick={() => setSheetOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-slate-200 bg-white p-5 animate-fade-up"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1.25rem)" }}
          >
            <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-slate-300" />
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900">All sections</span>
              <button
                onClick={() => setSheetOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-full bg-slate-100 text-slate-600"
                aria-label="Close"
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {overflow.map((t) => {
                const Icon = t.icon;
                const active = t.href === activeHref;
                return (
                  <Link
                    key={t.href}
                    href={t.href}
                    className={`flex items-center gap-3 rounded-xl border p-3 text-sm transition-all ${
                      active
                        ? "border-emerald-300 bg-emerald-50 font-medium text-emerald-800"
                        : "border-slate-200 bg-white text-slate-600"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="truncate">{t.label}</span>
                  </Link>
                );
              })}
            </div>
            <button
              className="btn-ghost-magic mt-4 flex w-full items-center justify-center gap-2 py-2.5"
              onClick={async () => {
                try {
                  await getBrowserSupabase().auth.signOut();
                } catch {}
                router.push("/login");
                router.refresh();
              }}
            >
              <IconLogout className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- desktop sidebar ---------- */
function Sidebar() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let s: ReturnType<typeof getBrowserSupabase> | null = null;
    try {
      s = getBrowserSupabase();
    } catch {
      return;
    }
    s.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);
  const initial = (email?.[0] ?? "?").toUpperCase();
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-slate-200 bg-white p-5 md:flex">
      <Logo />
      <Nav />
      <div className="mt-auto grid gap-3 border-t border-slate-200 pt-4">
        <Link href={PROFILE_ITEM.href} className="tab-item">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-emerald-600 text-xs font-bold text-white">
            {email ? initial : <IconUser className="h-4 w-4" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold text-slate-800">
              {email ?? "Profile"}
            </span>
            <span className="block text-[10px] text-slate-500">View profile</span>
          </span>
        </Link>
        <p className="text-[11px] text-slate-500">Target: 4/day · ≥4h spacing</p>
      </div>
    </aside>
  );
}

/* ---------- page transition ---------- */
function PageTransition({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div key={path} className="page-enter">
      {children}
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const bare =
    path === "/login" || path === "/signup" || path === "/" || path === "/guide" ||
    path === "/terms" || path === "/privacy";
  if (bare) {
    return (
      <main className="min-h-screen p-4 sm:p-8">
        <PageTransition>{children}</PageTransition>
      </main>
    );
  }
  return (
    <>
      {/* mobile header */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:hidden">
        <Logo />
        <div className="flex items-center gap-3">
          <ProfileIcon />
        </div>
      </header>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="min-w-0 flex-1 px-4 pb-28 pt-5 sm:px-6 md:px-8 md:pb-12 md:pt-8">
          <div className="mx-auto max-w-6xl">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
      </div>
      <MobileTabs />
      <AgentWidget />
    </>
  );
}
