import { NextResponse } from "next/server";
import { getDeviceIdentity } from "@/lib/device_auth";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Agent issues — brain/worker/phone ke liye shared issue tracker.
 *
 * POST: device-auth YA worker-auth (koi ek chalega) →
 *   agent_issue file karta hai { agent_id, severity, title, context,
 *   root_cause_hypothesis }.
 *   Worker calls me body me user_id required hai; device calls me device
 *   ke user_id se aata hai.
 *
 * GET: signed-in session user YA worker-auth (?user_id=) →
 *   us user ke issues (open pehle, limit 50).
 */

const SEVERITIES = new Set(["low", "medium", "high"]);

export async function POST(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  // identity (device ya worker) — worker path me body dobara parse hogi
  const ident = await getDeviceIdentity(req);
  let userId: string;
  let agentId: string;
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!("error" in ident)) {
    userId = ident.userId;
    agentId = `phone:${ident.deviceId.slice(0, 8)}`;
  } else {
    const denied = requireWorkerAuth(req);
    if (denied) return denied;
    const uid = typeof body.user_id === "string" ? body.user_id.trim() : "";
    if (!uid) {
      return NextResponse.json(
        { error: "user_id required in body for worker calls." },
        { status: 400 }
      );
    }
    userId = uid;
    agentId =
      typeof body.agent_id === "string" && body.agent_id.trim()
        ? body.agent_id.trim().slice(0, 64)
        : "worker";
  }

  const severity =
    typeof body.severity === "string" ? body.severity.trim() : "";
  if (!SEVERITIES.has(severity)) {
    return NextResponse.json(
      { error: "severity must be 'low', 'medium' or 'high'." },
      { status: 400 }
    );
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > 200) {
    return NextResponse.json(
      { error: "title required (max 200 chars)." },
      { status: 400 }
    );
  }
  const context = body.context;
  if (context !== undefined && (typeof context !== "object" || context === null)) {
    return NextResponse.json({ error: "context must be an object." }, { status: 400 });
  }
  const rootCause =
    typeof body.root_cause_hypothesis === "string"
      ? body.root_cause_hypothesis.slice(0, 2000)
      : null;

  try {
    const { data, error } = await sb
      .from("agent_issues")
      .insert({
        user_id: userId,
        agent_id: agentId,
        severity,
        title,
        context: context ?? {},
        root_cause_hypothesis: rootCause,
        status: "open",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "insert failed");
    return NextResponse.json({ ok: true, id: (data as { id: string }).id });
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error)?.message ?? e).slice(0, 160) },
      { status: 500 }
    );
  }
}

const STATUS_ORDER: Record<string, number> = {
  open: 0,
  investigating: 1,
  resolved: 2,
};

export async function GET(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  // session user YA worker-auth
  let userId: string;
  const denied = requireWorkerAuth(req);
  if (!denied) {
    const uid = new URL(req.url).searchParams.get("user_id")?.trim() ?? "";
    if (!uid) {
      return NextResponse.json(
        { error: "user_id query param required for worker calls." },
        { status: 400 }
      );
    }
    userId = uid;
  } else {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    userId = user.id;
  }

  try {
    const { data, error } = await sb
      .from("agent_issues")
      .select("id, agent_id, severity, title, context, root_cause_hypothesis, status, created_at, resolved_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const issues = ((data ?? []) as Array<Record<string, unknown>>).sort(
      (a, b) =>
        (STATUS_ORDER[String(a.status)] ?? 9) -
          (STATUS_ORDER[String(b.status)] ?? 9)
    );
    return NextResponse.json({ ok: true, issues });
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error)?.message ?? e).slice(0, 160) },
      { status: 500 }
    );
  }
}
