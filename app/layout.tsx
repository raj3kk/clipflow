import Link from "next/link";
import "./globals.css";

export const metadata = {
  title: "ClipFlow — Whop Clipping Automation",
  description: "Automated clipping pipeline: campaigns → clips → Instagram → Whop",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/runs", label: "Runs" },
  { href: "/submissions", label: "Submissions" },
  { href: "/connections", label: "Connections" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen flex">
          <aside className="w-56 shrink-0 border-r border-line bg-panel p-5 flex flex-col gap-2">
            <div className="mb-6">
              <div className="text-xl font-bold text-accent">ClipFlow</div>
              <div className="text-xs text-slate-400">Whop clipping autopilot</div>
            </div>
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-line hover:text-white"
              >
                {n.label}
              </Link>
            ))}
            <div className="mt-auto text-xs text-slate-500">
              IG: @viralshortz_45
              <br />
              Target: 4/day
            </div>
          </aside>
          <main className="flex-1 p-8 max-w-6xl">{children}</main>
        </div>
      </body>
    </html>
  );
}
