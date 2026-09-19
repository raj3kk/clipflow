import Link from "next/link";

/* ---------- public top nav ---------- */
export function PublicHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <img
            src="/brand-cf.webp"
            alt="ClipFlow logo"
            className="h-10 w-10 rounded-xl bg-white object-contain"
          />
          <span className="leading-tight">
            <span className="font-display text-lg font-bold tracking-tight text-slate-900">
              ClipFlow
            </span>
            <span className="block text-[10px] uppercase tracking-widest text-slate-500">
              phone automation
            </span>
          </span>
        </Link>
        <nav className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/guide"
            className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            Guide
          </Link>
          <Link
            href="/login"
            className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            Login
          </Link>
          <Link
            href="/signup"
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition-all hover:bg-emerald-700 active:scale-95"
          >
            Free me shuru karo
          </Link>
        </nav>
      </div>
    </header>
  );
}

/* ---------- public footer ---------- */
export function PublicFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2.5">
            <img
              src="/brand-cf.webp"
              alt="ClipFlow logo"
              className="h-9 w-9 rounded-xl bg-white object-contain"
            />
            <div className="leading-tight">
              <p className="font-display text-base font-bold text-slate-900">ClipFlow</p>
              <p className="text-xs text-slate-500">AutoClip app · phone se clipping automate karo</p>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium text-slate-600">
            <Link href="/guide" className="hover:text-emerald-700">Guide</Link>
            <Link href="/terms" className="hover:text-emerald-700">Terms</Link>
            <Link href="/privacy" className="hover:text-emerald-700">Privacy</Link>
            <Link href="/login" className="hover:text-emerald-700">Login</Link>
            <Link href="/signup" className="hover:text-emerald-700">Signup</Link>
          </nav>
        </div>
        <p className="mt-8 text-xs text-slate-400">
          © 2026 ClipFlow. Coins sirf reward points hain — unki koi cash value nahi.
        </p>
      </div>
    </footer>
  );
}

/* ---------- gold accent pill ---------- */
export function GoldPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-bold uppercase tracking-wider text-amber-700">
      {children}
    </span>
  );
}
