import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { encryptSecret } from "@/lib/crypto";

const PUBLIC_COLS =
  "id, kind, clip_id, question, detail, status, email_sent_at, resolved_at, resolved_via, created_at";

/**
 * Owner resolves an intervention with the secret value (OTP code, approval).
 * The raw value is AES-256-GCM encrypted into value_enc and NEVER included
 * in the response or any log.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const body = await req.json();
  const { value, resolved_via } = body as { value?: unknown; resolved_via?: string };
  if (value === undefined || value === null || value === "") {
    return NextResponse.json({ error: "value is required." }, { status: 400 });
  }

  let value_enc: string;
  try {
    value_enc = encryptSecret(value);
  } catch (e) {
    return NextResponse.json(
      { error: `Cannot store value: ${(e as Error).message}` },
      { status: 500 }
    );
  }

  const { data, error } = await sb
    .from("interventions")
    .update({
      value_enc,
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_via: resolved_via ?? "ui",
    })
    .eq("id", params.id)
    .eq("status", "pending")
    .select(PUBLIC_COLS)
    .single();
  if (error) {
    return NextResponse.json(
      { error: error.message || "Intervention not found or already handled." },
      { status: 500 }
    );
  }
  return NextResponse.json({ intervention: data });
}
