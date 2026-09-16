import { getDashboard } from "@/lib/state";
import StatusPill from "@/lib/status-pill";

export const dynamic = "force-dynamic";

export default async function Submissions() {
  const d = await getDashboard();
  const subs = d?.submissions ?? [];
  const prot = d?.protected_urls ?? [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Submissions</h1>
      <p className="text-slate-400 text-sm mb-6">
        Whop pe submit kiye gaye clips — status Whop ke review ke hisaab se.
      </p>

      <div className="rounded-xl border border-line bg-panel overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b border-line">
              <th className="p-4 font-medium">Campaign</th>
              <th className="p-4 font-medium">Reel</th>
              <th className="p-4 font-medium">Submitted</th>
              <th className="p-4 font-medium">Views</th>
              <th className="p-4 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="p-4">{s.campaign}</td>
                <td className="p-4">
                  <a
                    href={s.instagram_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    Open
                  </a>
                </td>
                <td className="p-4 text-slate-400">{s.submitted_at}</td>
                <td className="p-4 text-slate-400">
                  {s.views == null ? "—" : s.views.toLocaleString()}
                </td>
                <td className="p-4"><StatusPill status={s.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {subs.length === 0 && (
          <p className="p-4 text-sm text-slate-500">Koi submission nahi.</p>
        )}
      </div>

      <div className="rounded-xl border border-gold/40 bg-gold/10 p-5">
        <h2 className="font-semibold mb-2 text-gold">
          Protected reels — kabhi delete mat karo
        </h2>
        <p className="text-sm text-slate-300 mb-3">
          In reels ka Whop submission hai. Delete karne se submission reject ho
          jata hai (14 Sep ko aisa ho chuka hai).
        </p>
        <ul className="text-sm space-y-1">
          {prot.map((u) => (
            <li key={u}>
              <a
                href={u}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline break-all"
              >
                {u}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
