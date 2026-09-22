import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Queued automation cancel karo.
 *
 * DELETE /api/devices/:id/jobs/:jobId
 *   → { ok, job_id, status: "cancelled" }
 *
 * Sirf `queued` job cancel hoti hai (atomic: claim ho chuki to 409).
 * Succeeded/failed/blocked jobs HISTORY hain — wo delete nahi hote.
 * Soft-cancel hai (status='cancelled'): schedule ki idempotency key row
 * pe bani rehti hai, isliye cancel ki hui slot dobara create nahi hoti.
 * Lists (jobs, Live) cancelled ko nahi dikhati — har jagah se "deleted".
 */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string; jobId: string } }
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const { data: device } = await sb
    .from("devices")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  // Atomic: sirf queued → cancelled
  const { data: updated } = await sb
    .from("device_jobs")
    .update({ status: "cancelled" })
    .eq("id", params.jobId)
    .eq("device_id", params.id)
    .eq("user_id", user.id)
    .eq("status", "queued")
    .select("id");

  if (updated && updated.length > 0) {
    return NextResponse.json({
      ok: true,
      job_id: params.jobId,
      status: "cancelled",
    });
  }

  // Kyun nahi hua? — job hai ya status kuch aur hai?
  const { data: job } = await sb
    .from("device_jobs")
    .select("id, status")
    .eq("id", params.jobId)
    .eq("device_id", params.id)
    .eq("user_id", user.id)
    .single();
  if (!job) {
    return NextResponse.json({ error: "Job nahi mili." }, { status: 404 });
  }
  return NextResponse.json(
    {
      error:
        job.status === "succeeded"
          ? "Successful automation history me rehti hai — delete nahi hoti."
          : `Sirf queued automation cancel ho sakti hai (yeh job ab '${job.status}' hai).`,
      status: job.status,
    },
    { status: 409 }
  );
}
