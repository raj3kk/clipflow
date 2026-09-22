import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";
import { requireWorkerAuth } from "@/lib/worker_auth";

export async function GET(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ activity: [], configured: false });
  }
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;
  const { searchParams } = new URL(req.url);
  const limit = Math.min(
    Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1),
    500
  );
  const { data, error } = await sb
    .from("activity_log")
    .select("id, ts, actor, event, detail")
    .eq("user_id", userId)
    .order("ts", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ activity: data, configured: true });
}

export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;
  const _wu = new URL(req.url).searchParams.get("user_id");
  if (!_wu) {
    return NextResponse.json(
      { error: "user_id query param is required for worker calls." },
      { status: 400 }
    );
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const body = await req.json();
  const { actor, event, detail } = body;
  if (!event) {
    return NextResponse.json({ error: "event is required." }, { status: 400 });
  }
  const { data, error } = await sb
    .from("activity_log")
    .insert({ actor: actor ?? null, event, detail: detail ?? null, user_id: _wu })
    .select("id, ts, actor, event, detail")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entry: data }, { status: 201 });
}
