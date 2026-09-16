import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Light field validation for a stored connection.
 *
 * This is honest plumbing, not real verification: it only checks that the
 * required fields for the connection's method are present (service, method,
 * and a stored secret). Real verification — an actual login/session check —
 * happens worker-side on the VM.
 *
 * On pass, status is set to 'saved_unverified'. On fail, status is left
 * untouched and { ok: false, detail } is returned.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const { data, error } = await sb
    .from("connections")
    .select("id, service, method, label, status, secret_enc")
    .eq("id", params.id)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "Connection not found." }, { status: 404 });
  }

  const missing: string[] = [];
  if (!data.service) missing.push("service");
  if (!data.method) missing.push("method");
  if (!data.secret_enc) missing.push("secret (no secret stored for this method)");

  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        detail: `Field check failed — missing: ${missing.join(", ")}.`,
        status: data.status,
      },
      { status: 200 }
    );
  }

  await sb
    .from("connections")
    .update({ status: "saved_unverified" })
    .eq("id", params.id);

  return NextResponse.json({
    ok: true,
    detail:
      "Required fields present (service, method, stored secret). Real verification happens worker-side on the VM.",
    status: "saved_unverified",
  });
}
