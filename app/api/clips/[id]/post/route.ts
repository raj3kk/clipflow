import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Attempt to post an approved clip to Instagram.
 *
 * Posting runs through the automation agent (Meta OAuth app authorization
 * for @viralshortz_45 is currently stuck at the Accounts Center step, and the
 * server browser cannot decode H.264). Until those unblock, this endpoint
 * reports the real status instead of pretending to post.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const { data: clip, error: fetchError } = await sb
    .from("clips")
    .select("*")
    .eq("id", params.id)
    .single();
  if (fetchError || !clip) {
    return NextResponse.json({ error: "Clip not found." }, { status: 404 });
  }
  if (clip.status !== "approved") {
    return NextResponse.json(
      { error: `Clip must be approved before posting (current: ${clip.status}).` },
      { status: 400 }
    );
  }

  const igConnected = process.env.INSTAGRAM_CONNECTED === "true";

  if (!igConnected) {
    await sb
      .from("clips")
      .update({
        status: "approved",
        error:
          "Instagram posting blocked: Meta app authorization for @viralshortz_45 is stuck at the Accounts Center step. Complete the connect flow, then set INSTAGRAM_CONNECTED=true.",
      })
      .eq("id", params.id);
    return NextResponse.json(
      {
        ok: false,
        blocked: true,
        reason:
          "Instagram is not connected. Finish the Meta authorization for @viralshortz_45 (the Accounts Center 'already added' screen), then flip INSTAGRAM_CONNECTED=true on the server.",
      },
      { status: 200 }
    );
  }

  // When INSTAGRAM_CONNECTED=true, the automation agent picks the clip up
  // from the 'approved' queue and posts it via the connected integration.
  await sb.from("clips").update({ status: "posting", error: null }).eq("id", params.id);
  return NextResponse.json({
    ok: true,
    message: "Clip queued for Instagram posting by the automation agent.",
  });
}
