import Nav from "./components/Nav";
import UserBadge from "./components/UserBadge";
import "./globals.css";

export const metadata = {
  title: "ClipFlow — Whop Clipping Automation",
  description: "Automated clipping pipeline: campaigns → clips → Instagram → Whop",
};

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
            <Nav />
            <UserBadge />
            <div className="text-xs text-slate-500">
              Target: 4/day · ≥4h spacing
            </div>
          </aside>
          <main className="flex-1 p-8 max-w-6xl">{children}</main>
        </div>
      </body>
    </html>
  );
}
