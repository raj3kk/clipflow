import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

/** Approve a rendered clip after preview (status: preview -> approved). */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const { data, error } = await sb
    .from("clips")
    .update({ status: "approved" })
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clip: data });
}
