"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Nav, {
  NAV_V1,
  NAV_V2,
  PROFILE_ITEM,
  isActiveTab,
  useAllTabs,
} from "./Nav";
import ModeToggle from "./ModeToggle";
import { IconMore, IconSparkles, IconUser, IconX, IconLogout } from "./icons";
import { AppMode, MODE_EVENT, getMode } from "./mode";
import { getBrowserSupabase } from "@/lib/supabase-browser";

/* ---------- animated magic background ---------- */
function Aurora() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
      <div className="absolute -top-32 -left-24 h-[34rem] w-[34rem] rounded-full bg-magic/25 blur-[110px] animate-drift1" />
      <div className="absolute top-1/3 -right-32 h-[30rem] w-[30rem] rounded-full bg-spell/20 blur-[110px] animate-drift2" />
      <div className="absolute -bottom-40 left-1/3 h-[32rem] w-[32rem] rounded-full bg-mana/15 blur-[120px] animate-drift3" />
      {/* twinkling stars */}
      {[
        "left-[12%] top-[18%]",
        "left-[78%] top-[12%]",
        "left-[55%] top-[70%]",
        "left-[28%] top-[85%]",
        "left-[88%] top-[55%]",
        "left-[42%] top-[32%]",
      ].map((pos, i) => (
        <span
          key={i}
          className={`absolute ${pos} h-1 w-1 rounded-full bg-white animate-twinkle`}
          style={{ animationDelay: `${i * 0.7}s` }}
        />
      ))}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(5,3,16,0.75)_100%)]" />
    </div>
  );
}

/* ---------- logo ---------- */
function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link href="/" className="group flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-magic via-spell to-mana text-white shadow-magic transition-transform duration-300 group-hover:rotate-12 group-hover:scale-110">
        <IconSparkles className="h-5 w-5" />
      </span>
      {!compact && (
        <span className="leading-tight">
          <span className="font-display text-lg font-bold magic-text">ClipFlow</span>
          <span className="block text-[10px] tracking-widest text-slate-500 uppercase">
            magic autopilot
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
      className={`grid h-10 w-10 place-items-center rounded-full font-display text-sm font-bold text-white transition-transform hover:scale-105 active:scale-95 ${
        active ? "shadow-magic" : ""
      }`}
      style={{
        background: "linear-gradient(135deg,#7c3aed,#c026d3 55%,#0891b2)",
        boxShadow: active
          ? "0 0 20px -2px rgba(217,70,239,0.9)"
          : "0 0 12px -4px rgba(139,92,246,0.7)",
      }}
    >
      {email ? initial : <IconUser className="h-5 w-5" />}
    </Link>
  );
}

/* ---------- mobile bottom nav ---------- */
function MobileTabs() {
  const path = usePathname();
  const router = useRouter();
  const [mode, setModeState] = useState<AppMode>("v1");
  const { tabs } = useAllTabs();
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    setModeState(getMode());
    const h = (e: Event) =>
      setModeState((e as CustomEvent<AppMode>).detail ?? getMode());
    window.addEventListener(MODE_EVENT, h);
    return () => window.removeEventListener(MODE_EVENT, h);
  }, []);

  const base = mode === "v2" ? NAV_V2 : NAV_V1;
  const primary = base.slice(0, 4);
  const overflow = tabs.filter((t) => !primary.some((p) => p.href === t.href));

  useEffect(() => {
    setSheetOpen(false);
  }, [path]);

  return (
    <>
      <nav
        className="fixed bottom-0 inset-x-0 z-40 md:hidden border-t border-white/10 bg-abyss/85 backdrop-blur-xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-stretch justify-around px-2 pt-1.5 pb-1">
          {primary.map((t) => {
            const Icon = t.icon;
            const active = isActiveTab(t.href, path);
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
            className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-up"
            onClick={() => setSheetOpen(false)}
          />
          <div className="absolute bottom-0 inset-x-0 rounded-t-3xl border-t border-white/10 bg-abyss/95 backdrop-blur-xl p-5 animate-fade-up"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1.25rem)" }}
          >
            <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-white/20" />
            <div className="mb-3 flex items-center justify-between">
              <span className="font-display text-sm font-semibold magic-text">All sections</span>
              <button
                onClick={() => setSheetOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-full bg-white/5 text-slate-300"
                aria-label="Close"
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {overflow.map((t) => {
                const Icon = t.icon;
                const active = isActiveTab(t.href, path);
                return (
                  <Link
                    key={t.href}
                    href={t.href}
                    className={`flex items-center gap-3 rounded-xl border p-3 text-sm transition-all ${
                      active
                        ? "border-magic/60 bg-magic/15 text-white shadow-magic-sm"
                        : "border-white/10 bg-white/[0.04] text-slate-300"
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
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-white/10 bg-abyss/60 p-5 backdrop-blur-xl md:flex">
      <Logo />
      <ModeToggle />
      <Nav />
      <div className="mt-auto grid gap-3 border-t border-white/10 pt-4">
        <Link href={PROFILE_ITEM.href} className="tab-item">
          <span
            className="grid h-8 w-8 place-items-center rounded-full font-display text-xs font-bold text-white"
            style={{ background: "linear-gradient(135deg,#7c3aed,#c026d3 55%,#0891b2)" }}
          >
            {email ? initial : <IconUser className="h-4 w-4" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold text-slate-200">
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
  const bare = path === "/login" || path === "/signup";
  if (bare) {
    return (
      <>
        <Aurora />
        <main className="min-h-screen p-4 sm:p-8">
          <PageTransition>{children}</PageTransition>
        </main>
      </>
    );
  }
  return (
    <>
      <Aurora />
      {/* mobile header */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-white/10 bg-abyss/80 px-4 py-3 backdrop-blur-xl md:hidden">
        <Logo />
        <div className="flex items-center gap-3">
          <ModeToggle compact />
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
    </>
  );
}
