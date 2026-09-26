import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { injectPendingStep, takePendingStep } from "@/lib/live_step";

/**
 * ONE-TIME e2e test endpoint — pairing issuance-path + live-step queue.
 *
 * Token-protected: har request me ?token=<random phrase> chahiye.
 * Ye file TEST KE BAAD DELETE hogi (koi permanent surface nahi).
 *
 * GET  ?token=..&action=schema        → device_jobs/activity_log/devices
 *                                        columns (read-only, OpenAPI se)
 * POST ?token=..&action=issue        → {code, user_id, run} → activity_log me
 *                                        pairing_code_issued insert
 * POST ?token=..&action=check-device → {device_id} → {user_id}
 * POST ?token=..&action=make-job     → {device_id, user_id} → test device_job
 * POST ?token=..&action=inject-step  → {job_id, device_id, user_id, step?|stop}
 *                                        → REAL injectPendingStep (lib) call
 * POST ?token=..&action=cleanup      → {run, codes[]} → VIRTUAL-TEST-*
 *                                        devices + test log rows delete
 */
export const dynamic = "force-dynamic";

const EXPECTED_TOKEN = "falcon-tara-sitar-mango-safar-tango-quill";

function authed(req: Request): boolean {
  const t = new URL(req.url).searchParams.get("token") ?? "";
  const a = Buffer.from(t, "utf8");
  const b = Buffer.from(EXPECTED_TOKEN, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny() {
  return NextResponse.json({ error: "Forbidden." }, { status: 403 });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const j = await req.json();
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Read-only schema: PostgREST OpenAPI se table columns nikalo. */
async function schemaAction() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Accept: "application/openapi+json" },
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `OpenAPI fetch failed: ${res.status}` },
      { status: 502 }
    );
  }
  const spec = (await res.json()) as {
    definitions?: Record<string, { properties?: Record<string, { type?: string; format?: string; description?: string }> }>;
  };
  const tables: Record<string, unknown> = {};
  for (const name of ["device_jobs", "activity_log", "devices"]) {
    const def = spec.definitions?.[name]?.properties;
    if (!def) {
      tables[name] = null;
      continue;
    }
    const cols: Record<string, string> = {};
    for (const [col, meta] of Object.entries(def)) {
      cols[col] = meta.format ? `${meta.type}(${meta.format})` : (meta.type ?? "?");
    }
    tables[name] = cols;
  }
  return NextResponse.json({ ok: true, tables });
}

export async function GET(req: Request) {
  if (!authed(req)) return deny();
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const action = new URL(req.url).searchParams.get("action") ?? "";
  if (action === "schema") return schemaAction();
  return NextResponse.json({
    ok: true,
    actions: ["schema", "issue", "check-device", "make-job", "inject-step", "cleanup"],
  });
}

export async function POST(req: Request) {
  if (!authed(req)) return deny();
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const action = new URL(req.url).searchParams.get("action") ?? "";
  const body = await readBody(req);

  if (action === "issue") {
    const raw = String(body.code ?? "")
      .trim()
      .toUpperCase()
      .replace(/[-\s]/g, "")
      .replace(/I/g, "1")
      .replace(/L/g, "1")
      .replace(/O/g, "0");
    const userId = String(body.user_id ?? "");
    const run = String(body.run ?? "");
    if (!raw || !userId || !run) {
      return NextResponse.json({ error: "code, user_id, run required." }, { status: 400 });
    }
    const { error } = await sb.from("activity_log").insert({
      user_id: userId,
      actor: "pairing",
      event: "pairing_code_issued",
      detail: { code: raw, e2e_test: true, run },
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "check-device") {
    const deviceId = String(body.device_id ?? "");
    if (!deviceId) {
      return NextResponse.json({ error: "device_id required." }, { status: 400 });
    }
    const { data, error } = await sb
      .from("devices")
      .select("id, user_id, device_name")
      .eq("id", deviceId)
      .maybeSingle();
    if (error || !data) {
      return NextResponse.json({ error: "Unknown device." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, user_id: data.user_id, device_name: data.device_name });
  }

  if (action === "make-job") {
    const deviceId = String(body.device_id ?? "");
    const userId = String(body.user_id ?? "");
    if (!deviceId || !userId) {
      return NextResponse.json({ error: "device_id, user_id required." }, { status: 400 });
    }
    const { data, error } = await sb
      .from("device_jobs")
      .insert({
        user_id: userId,
        device_id: deviceId,
        type: "e2e-live-step",
        payload: { e2e_test: true },
        idempotency_key: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        run_after: new Date().toISOString(),
        status: "running",
      })
      .select("id")
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: `make-job failed: ${error?.message ?? "unknown"}` },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, job_id: data.id });
  }

  if (action === "debug-take") {
    // REAL lib takePendingStep ko temp endpoint se call karo
    const jobId = String(body.job_id ?? "");
    const deviceId = String(body.device_id ?? "");
    const got = await takePendingStep(sb, { jobId, deviceId });
    const { data: after } = await sb
      .from("device_jobs")
      .select("payload")
      .eq("id", jobId)
      .maybeSingle();
    const ap = (after?.payload ?? {}) as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      took: got,
      pending_after: "pending_step" in ap,
    });
  }

  if (action === "debug-clear") {
    // takePendingStep ke EXACT update ko isolate karke test karo
    const jobId = String(body.job_id ?? "");
    const { data: job } = await sb
      .from("device_jobs")
      .select("payload")
      .eq("id", jobId)
      .maybeSingle();
    const p = (job?.payload ?? {}) as Record<string, unknown>;
    const pend = (p["pending_step"] ?? {}) as Record<string, unknown>;
    const pid = String(pend["id"] ?? "");
    const base: Record<string, unknown> = { ...p };
    delete base["pending_step"];
    const upd = await sb
      .from("device_jobs")
      .update({ payload: base })
      .eq("id", jobId)
      .filter("payload->pending_step->>id", "eq", pid)
      .select("id");
    const { data: after } = await sb
      .from("device_jobs")
      .select("payload")
      .eq("id", jobId)
      .maybeSingle();
    const ap = (after?.payload ?? {}) as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      pending_id: pid || null,
      update_error: upd.error?.message ?? null,
      cleared_rows: upd.data?.length ?? null,
      pending_after: "pending_step" in ap,
    });
  }

  if (action === "debug-job") {
    const jobId = String(body.job_id ?? "");
    const { data: job, error: jobErr } = await sb
      .from("device_jobs")
      .select("id, status, payload")
      .eq("id", jobId)
      .maybeSingle();
    // Chained JSON filter probe (read-only): kya PostgREST
    // `payload->pending_step->>id` parse karta hai?
    const probe = await sb
      .from("device_jobs")
      .select("id")
      .eq("id", jobId)
      .filter("payload->pending_step->>id", "neq", "00000000-0000-0000-0000-000000000000");
    return NextResponse.json({
      ok: true,
      job_error: jobErr?.message ?? null,
      payload: job?.payload ?? null,
      status: job?.status ?? null,
      probe_error: probe.error?.message ?? null,
      probe_rows: probe.data?.length ?? null,
    });
  }

  if (action === "inject-step") {    const jobId = String(body.job_id ?? "");
    const deviceId = String(body.device_id ?? "");
    const userId = String(body.user_id ?? "");
    if (!jobId || !deviceId || !userId) {
      return NextResponse.json(
        { error: "job_id, device_id, user_id required." },
        { status: 400 }
      );
    }
    const res = await injectPendingStep(sb, {
      jobId,
      deviceId,
      userId,
      step: body.step,
      stop: body.stop === true,
      injectedBy: "e2e-test",
    });
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: res.code });
    }
    return NextResponse.json({ ok: true, step_id: res.step_id });
  }

  if (action === "cleanup") {
    const run = String(body.run ?? "");
    const codes = Array.isArray(body.codes) ? body.codes.map(String) : [];
    if (!run) {
      return NextResponse.json({ error: "run required." }, { status: 400 });
    }
    // 1. Test devices dhoondo
    const { data: devs } = await sb
      .from("devices")
      .select("id")
      .like("device_name", "VIRTUAL-TEST-%");
    const devIds = (devs ?? []).map((d) => d.id as string);

    // 2. Unke test jobs hatao (FK safe order)
    let jobsDeleted = 0;
    if (devIds.length > 0) {
      const { data: jd } = await sb
        .from("device_jobs")
        .delete()
        .in("device_id", devIds)
        .select("id");
      jobsDeleted = jd?.length ?? 0;
    }

    // 3. Devices hatao
    let devicesDeleted = 0;
    if (devIds.length > 0) {
      const { data: dd } = await sb
        .from("devices")
        .delete()
        .in("id", devIds)
        .select("id");
      devicesDeleted = dd?.length ?? 0;
    }

    // 4. Test issuance records hatao
    const { data: issued } = await sb
      .from("activity_log")
      .delete()
      .eq("event", "pairing_code_issued")
      .filter("detail->>run", "eq", run)
      .select("id");

    // 5. Test used/attempt records (codes se match)
    let usedDeleted = 0;
    let attemptsDeleted = 0;
    if (codes.length > 0) {
      const { data: ud } = await sb
        .from("activity_log")
        .delete()
        .eq("event", "pairing_code_used")
        .in("detail->>code", codes)
        .select("id");
      usedDeleted = ud?.length ?? 0;
      const { data: ad } = await sb
        .from("activity_log")
        .delete()
        .eq("event", "pairing_attempt")
        .in("detail->>code", codes)
        .select("id");
      attemptsDeleted = ad?.length ?? 0;
    }

    // 6. Bachi hui VIRTUAL-TEST devices gino (proof)
    const { data: remaining } = await sb
      .from("devices")
      .select("id")
      .like("device_name", "VIRTUAL-TEST-%");

    return NextResponse.json({
      ok: true,
      jobs_deleted: jobsDeleted,
      devices_deleted: devicesDeleted,
      issued_deleted: issued?.length ?? 0,
      used_deleted: usedDeleted,
      attempts_deleted: attemptsDeleted,
      remaining_virtual_devices: remaining?.length ?? 0,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
