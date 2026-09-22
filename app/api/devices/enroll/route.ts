import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { hashApiKey } from "@/lib/device_auth";

/**
 * Phone app ka enroll: { code, device_name?, app_version? }
 * Code verify → device row banao → device_id + api_key wapas.
 * api_key RAW sirf isi response me dikhegi (dobara kabhi nahi) —
 * phone ise apne encrypted storage me rakhta hai.
 */
export async function POST(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const code = String(body.code ?? "").trim();
  if (code.length < 4) {
    return NextResponse.json({ error: "code is required." }, { status: 400 });
  }

  const codeHash = createHash("sha256").update(code).digest("hex");
  const { data: codeRow, error: codeErr } = await sb
    .from("device_enroll_codes")
    .select("id, user_id, expires_at, used_at")
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (codeErr || !codeRow) {
    return NextResponse.json(
      { error: "Invalid or expired enroll code." },
      { status: 401 }
    );
  }

  await sb
    .from("device_enroll_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("id", codeRow.id);

  const apiKey = randomBytes(32).toString("hex");
  const { data: device, error: devErr } = await sb
    .from("devices")
    .insert({
      user_id: codeRow.user_id,
      device_name: String(body.device_name ?? "Android"),
      app_version: body.app_version ? String(body.app_version) : null,
      api_key_hash: hashApiKey(apiKey),
      status: "active",
    })
    .select("id")
    .single();

  if (devErr || !device) {
    return NextResponse.json(
      { error: devErr?.message ?? "Enroll failed." },
      { status: 500 }
    );
  }

  return NextResponse.json({ device_id: device.id, api_key: apiKey });
}
