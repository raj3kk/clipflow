/**
 * ClipFlow Ops Agent — rule-based (₹0, koi LLM call nahi) intent router + tools.
 *
 * Sirf /api/admin/ops-agent/chat se call hota hai, jo khud double-gated hai
 * (owner email + cf_admin cookie via requireAdmin). Ye lib me koi auth nahi
 * karta — caller ensure karta hai.
 *
 * Supported commands (Hinglish):
 *   jobs / stuck            → stuck jobs ki list
 *   requeue <job-id-prefix> → stuck job ko wapas queue me (pehle "pakka?" confirm)
 *   pause <device>          → device pause (pehle "pakka?" confirm)
 *   unpause <device>        → device wapas active
 *   cap                     → rolling 24h cap status, per user
 *   checklist / status      → latest automation ka step summary
 *   devices                 → device list + last_seen + app_version
 *
 * Cap constants lib/device_jobs.ts se reuse hote hain — duplicate logic nahi.
 */

import { CAP_COUNT, CAP_WINDOW_HOURS, CAP_JOB_STATUSES } from "./device_jobs";

export interface OpsReply {
  reply: string;
  actions_taken: string[];
}

const STUCK_STATUSES = ["dispatched", "running"];
const HEARTBEAT_STUCK_MIN = 10;
const LEGACY_STUCK_MIN = 45;

interface StuckJob {
  id: string;
  type: string;
  status: string;
  current_step: string | null;
  attempts: number;
  max_attempts: number;
  heartbeat_count: number;
  last_heartbeat: string | null;
  created_at: string;
  user_id: string;
  device_id: string;
}

function isStuck(j: StuckJob): boolean {
  const now = Date.now();
  if ((j.heartbeat_count ?? 0) > 0) {
    const hb = j.last_heartbeat ? Date.parse(j.last_heartbeat) : 0;
    return now - hb > HEARTBEAT_STUCK_MIN * 60 * 1000;
  }
  return now - Date.parse(j.created_at) > LEGACY_STUCK_MIN * 60 * 1000;
}

function shortId(id: string): string {
  return (id || "").slice(0, 8);
}

function ageMin(iso: string | null): string {
  if (!iso) return "kabhi nahi";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "abhi";
  if (m < 60) return `${m} min pehle`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ghante pehle`;
  return `${Math.round(h / 24)} din pehle`;
}

async function audit(sb: any, event: string, text: string): Promise<void> {
  try {
    await sb.from("activity_log").insert({
      user_id: null,
      actor: "ops-agent",
      event,
      detail: { text: text.slice(0, 500) },
    });
  } catch {
    /* best-effort */
  }
}

async function fetchStuckJobs(sb: any): Promise<StuckJob[]> {
  const { data, error } = await sb
    .from("device_jobs")
    .select(
      "id,type,status,current_step,attempts,max_attempts,heartbeat_count,last_heartbeat,created_at,user_id,device_id"
    )
    .in("status", STUCK_STATUSES)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return (data as StuckJob[]).filter(isStuck);
}

async function emailOf(sb: any, userId: string): Promise<string> {
  try {
    const { data } = await sb.auth.admin.getUserById(userId);
    return data?.user?.email ?? shortId(userId);
  } catch {
    return shortId(userId);
  }
}

async function cmdJobs(sb: any): Promise<OpsReply> {
  const stuck = await fetchStuckJobs(sb);
  if (stuck.length === 0) {
    return {
      reply:
        "Sab theek hai — koi stuck job nahi mila. (stuck = heartbeat 10 min se purana, ya bina heartbeat 45 min se purana, status dispatched/running me)",
      actions_taken: [],
    };
  }
  const lines = await Promise.all(
    stuck.map(async (j) => {
      const email = await emailOf(sb, j.user_id);
      const why =
        (j.heartbeat_count ?? 0) > 0
          ? `heartbeat ${ageMin(j.last_heartbeat)}`
          : `bina heartbeat, bana ${ageMin(j.created_at)}`;
      return `• ${shortId(j.id)} — ${j.type} (${j.status}, step: ${
        j.current_step ?? "—"
      }, try ${j.attempts}/${j.max_attempts}) · ${email} · ${why}`;
    })
  );
  return {
    reply: `${stuck.length} stuck job mile:\n${lines.join("\n")}\n\nRequeue karne ke liye likho: requeue <id-prefix> pakka`,
    actions_taken: [],
  };
}

async function cmdRequeue(sb: any, arg: string, confirmed: boolean): Promise<OpsReply> {
  const prefix = (arg || "").trim().split(/\s+/)[0] ?? "";
  if (!prefix || prefix.length < 3) {
    return {
      reply: "Kaunsa job? Job id ka pehla hissa likho — jaise: requeue a1b2c3d4",
      actions_taken: [],
    };
  }
  const stuck = await fetchStuckJobs(sb);
  const matches = stuck.filter((j) => j.id.toLowerCase().startsWith(prefix.toLowerCase()));
  if (matches.length === 0) {
    return {
      reply: `Stuck jobs me '${prefix}' se shuru hone wala koi job nahi mila. Pehle 'jobs' likh ke list dekho.`,
      actions_taken: [],
    };
  }
  if (matches.length > 1) {
    return {
      reply: `Ek se zyada match mile:\n${matches.map((j) => `• ${shortId(j.id)} — ${j.type}`).join("\n")}\nZara lamba prefix likho.`,
      actions_taken: [],
    };
  }
  const j = matches[0];
  if (!confirmed) {
    return {
      reply: `Job ${shortId(j.id)} (${j.type}, try ${j.attempts}/${j.max_attempts}, step: ${
        j.current_step ?? "—"
      }) ko requeue karun? Ye queued me jayega aur phone dobara uthayega. Karna ho to likho: requeue ${prefix} pakka`,
      actions_taken: [],
    };
  }
  const nextAttempts = j.attempts < j.max_attempts ? j.attempts + 1 : j.attempts;
  const { error } = await sb
    .from("device_jobs")
    .update({
      status: "queued",
      run_after: new Date().toISOString(),
      attempts: nextAttempts,
    })
    .eq("id", j.id);
  if (error) {
    return { reply: `Requeue nahi hua — DB error: ${error.message}`, actions_taken: [] };
  }
  const act = `requeue ${shortId(j.id)} (try ${j.attempts}→${nextAttempts}, step '${j.current_step ?? "—"}' preserve)`;
  await audit(sb, "ops_agent.requeue", act);
  return {
    reply: `Ho gaya — job ${shortId(j.id)} wapas queued me hai, phone jald uthayega. (step '${j.current_step ?? "—"}' preserve rakha)`,
    actions_taken: [act],
  };
}

async function findDevices(sb: any, arg: string) {
  const q = (arg || "").trim().split(/\s+/)[0] ?? "";
  const { data } = await sb
    .from("devices")
    .select("id,device_name,status,paused_until,last_seen,app_version,platform,disconnected_at")
    .is("deleted_at", null)
    .order("last_seen", { ascending: false, nullsFirst: false });
  const rows = (data ?? []) as Array<{
    id: string;
    device_name: string;
    status: string;
    paused_until: string | null;
    last_seen: string | null;
    app_version: string | null;
    platform: string | null;
    disconnected_at: string | null;
  }>;
  if (!q) return { query: q, rows, matches: rows };
  const low = q.toLowerCase();
  const matches = rows.filter(
    (d) =>
      (d.device_name || "").toLowerCase().includes(low) ||
      d.id.toLowerCase().startsWith(low)
  );
  return { query: q, rows, matches };
}

async function cmdDevices(sb: any): Promise<OpsReply> {
  const { rows } = await findDevices(sb, "");
  if (rows.length === 0) {
    return { reply: "Koi device registered nahi hai.", actions_taken: [] };
  }
  const lines = rows.map(
    (d) =>
      `• ${d.device_name || shortId(d.id)} — ${d.status}${
        d.paused_until ? ` (paused till ${ageMin(d.paused_until)})` : ""
      } · app ${d.app_version ?? "?"} · last seen ${ageMin(d.last_seen)}${
        d.disconnected_at ? " · DISCONNECTED" : ""
      }`
  );
  return { reply: `${rows.length} devices:\n${lines.join("\n")}`, actions_taken: [] };
}

async function cmdPause(sb: any, arg: string, pause: boolean, confirmed: boolean): Promise<OpsReply> {
  const { query, matches } = await findDevices(sb, arg);
  if (!query) {
    return {
      reply: pause
        ? "Kaunsa device pause karun? Device ka naam likho — jaise: pause mere-phone"
        : "Kaunsa device unpause karun? Device ka naam likho — jaise: unpause mere-phone",
      actions_taken: [],
    };
  }
  if (matches.length === 0) {
    return { reply: `'${query}' naam ka koi device nahi mila. 'devices' likh ke list dekho.`, actions_taken: [] };
  }
  if (matches.length > 1) {
    return {
      reply: `Ek se zyada device match hue:\n${matches
        .map((d) => `• ${d.device_name || shortId(d.id)} (${d.status})`)
        .join("\n")}\nPura naam likho.`,
      actions_taken: [],
    };
  }
  const d = matches[0];
  const verb = pause ? "pause" : "unpause";
  if (!confirmed) {
    return {
      reply: `Device '${d.device_name || shortId(d.id)}' (abhi ${d.status}) ko ${verb} karun? ${
        pause ? "Phone naya job nahi uthayega jab tak unpause na ho." : "Phone wapas naya job uthane lagega."
      } Pakka ho to likho: ${verb} ${query} pakka`,
      actions_taken: [],
    };
  }
  const patch = pause ? { status: "paused", paused_until: null } : { status: "active", paused_until: null };
  const { error } = await sb.from("devices").update(patch).eq("id", d.id);
  if (error) {
    return { reply: `${verb} nahi hua — DB error: ${error.message}`, actions_taken: [] };
  }
  const act = `${verb} device ${d.device_name || shortId(d.id)}`;
  await audit(sb, pause ? "ops_agent.pause" : "ops_agent.unpause", act);
  return {
    reply: pause
      ? `Ho gaya — '${d.device_name || shortId(d.id)}' pause hai. Phone ab naya job nahi uthayega.`
      : `Ho gaya — '${d.device_name || shortId(d.id)}' wapas active hai.`,
    actions_taken: [act],
  };
}

async function cmdCap(sb: any): Promise<OpsReply> {
  const since = new Date(Date.now() - CAP_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await sb
    .from("device_jobs")
    .select("user_id")
    .gte("created_at", since)
    .in("status", CAP_JOB_STATUSES);
  if (error) {
    return { reply: `Cap check nahi hua — DB error: ${error.message}`, actions_taken: [] };
  }
  const counts: Record<string, number> = {};
  for (const r of data ?? []) {
    if (r.user_id) counts[r.user_id] = (counts[r.user_id] ?? 0) + 1;
  }
  const ids = Object.keys(counts);
  if (ids.length === 0) {
    return {
      reply: `Pichle ${CAP_WINDOW_HOURS} ghante me kisi user ne koi automation nahi chalayi. Cap: ${CAP_COUNT} per user.`,
      actions_taken: [],
    };
  }
  const lines = await Promise.all(
    ids.map(async (uid) => {
      const n = counts[uid];
      const email = await emailOf(sb, uid);
      return `• ${email} — ${n}/${CAP_COUNT} ${n >= CAP_COUNT ? "⛔ CAP FULL" : "✓"}`;
    })
  );
  return {
    reply: `Rolling ${CAP_WINDOW_HOURS}h automation cap (${CAP_COUNT}/user):\n${lines.join("\n")}`,
    actions_taken: [],
  };
}

async function cmdChecklist(sb: any): Promise<OpsReply> {
  const { data, error } = await sb
    .from("device_jobs")
    .select("id,type,status,current_step,attempts,max_attempts,created_at,user_id,device_id")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) {
    return { reply: `Status check nahi hua — DB error: ${error.message}`, actions_taken: [] };
  }
  if (!data || data.length === 0) {
    return { reply: "Abhi tak koi automation job bana hi nahi hai.", actions_taken: [] };
  }
  const devIds = Array.from(new Set((data as any[]).map((j) => j.device_id).filter(Boolean)));
  let devNames: Record<string, string> = {};
  if (devIds.length > 0) {
    const { data: devs } = await sb.from("devices").select("id,device_name").in("id", devIds);
    for (const d of devs ?? []) devNames[d.id] = d.device_name;
  }
  const lines = await Promise.all(
    (data as any[]).map(async (j) => {
      const email = await emailOf(sb, j.user_id);
      return `• ${shortId(j.id)} — ${j.type} · ${j.status}${
        j.current_step ? ` (step: ${j.current_step})` : ""
      } · try ${j.attempts}/${j.max_attempts} · device ${devNames[j.device_id] ?? shortId(j.device_id ?? "")} · ${email} · ${ageMin(j.created_at)}`;
    })
  );
  return { reply: `Latest ${data.length} automation jobs:\n${lines.join("\n")}`, actions_taken: [] };
}

export function helpText(): string {
  return [
    "Ops Agent ready hai. Commands:",
    "• jobs / stuck — stuck jobs ki list",
    "• requeue <id-prefix> pakka — stuck job wapas queue me",
    "• pause <device> pakka — device pause karo",
    "• unpause <device> pakka — device wapas active karo",
    "• cap — rolling 24h automation cap (per user)",
    "• checklist / status — latest automation summary",
    "• devices — device list (last seen, app version)",
    "",
    "⚠️ pause aur requeue se pehle 'pakka' confirm mangta hun — bina pakka kuch destructive nahi hoga.",
  ].join("\n");
}

/**
 * Main entry — message padho, intent nikalo, tool chalao.
 * Confirmed destructive commands ke liye message me "pakka"/"confirm" chahiye.
 */
export async function handleOpsMessage(sb: any, rawMessage: string): Promise<OpsReply> {
  const message = (rawMessage || "").trim().slice(0, 2000);
  if (!message) return { reply: helpText(), actions_taken: [] };

  const low = message.toLowerCase();
  const confirmed = /\bpakka\b|\bconfirm\b/.test(low);
  const first = low.split(/\s+/)[0] ?? "";
  const rest = message.trim().split(/\s+/).slice(1).join(" ");

  try {
    if (first === "jobs" || first === "stuck") return await cmdJobs(sb);
    if (first === "requeue") return await cmdRequeue(sb, rest, confirmed);
    if (first === "pause") return await cmdPause(sb, rest, true, confirmed);
    if (first === "unpause" || first === "resume") return await cmdPause(sb, rest, false, confirmed);
    if (first === "cap") return await cmdCap(sb);
    if (first === "checklist" || first === "status") return await cmdChecklist(sb);
    if (first === "devices" || first === "device") return await cmdDevices(sb);
    if (first === "help" || first === "madad" || first === "hello" || first === "hi" || first === "namaste") {
      return { reply: `Namaste! 👋 ${helpText()}`, actions_taken: [] };
    }
    return {
      reply: `Samajh nahi aaya — '${message.slice(0, 60)}'. Try karo:\n${helpText()}`,
      actions_taken: [],
    };
  } catch (e: any) {
    console.error("ops_agent error:", e?.message ?? e);
    return {
      reply: "Kuch gadbad ho gayi — dobara try karo. (technical team ko activity log me error mil jayega)",
      actions_taken: [],
    };
  }
}
