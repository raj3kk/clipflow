import { NextResponse } from "next/server";
import { getDeviceIdentity } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Phone ↔ server agent-memory sync.
 *
 * POST, device-auth (X-Device-Id / X-Device-Key).
 *
 * Body { direction: "pull", skill_keys?: string[] } →
 *   is user ki top semantic + skill_lesson memories (importance desc,
 *   limit 10, chhote payload — content truncate hota hai).
 *
 * Body { direction: "push", kind: "episodic"|"skill_lesson",
 *        key: string, content: object, importance?: number } →
 *   agent_memory me row insert (agent_id='phone'). content cap ~4KB.
 */

const PULL_LIMIT = 10;
const CONTENT_PUSH_CAP = 4096; // ~4KB
const CONTENT_PULL_CAP = 1000; // pull me har memory ka content truncate

function truncateContent(content: unknown): { content: unknown; truncated: boolean } {
  const s = JSON.stringify(content ?? null);
  if (s.length <= CONTENT_PULL_CAP) return { content: content ?? null, truncated: false };
  return { content: s.slice(0, CONTENT_PULL_CAP), truncated: true };
}

export async function POST(req: Request) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const direction = body.direction;

  /* ---------------- PULL ---------------- */
  if (direction === "pull") {
    const rawKeys = body.skill_keys;
    const skillKeys =
      Array.isArray(rawKeys)
        ? rawKeys.filter((k): k is string => typeof k === "string").slice(0, 20)
        : null;
    try {
      const { data, error } = await sb
        .from("agent_memory")
        .select("id, kind, key, content, importance, created_at")
        .eq("user_id", ident.userId)
        .in("kind", ["semantic", "skill_lesson"])
        .order("importance", { ascending: false })
        .limit(30);
      if (error) throw new Error(error.message);
      let rows = (data ?? []) as Array<{
        id: string;
        kind: string;
        key: string;
        content: unknown;
        importance: number | null;
        created_at: string;
      }>;
      // skill_keys filter: content.skill / content.skill_key pe (JS me — chhota set)
      if (skillKeys && skillKeys.length > 0) {
        const set = new Set(skillKeys);
        rows = rows.filter((r) => {
          const c =
            r.content && typeof r.content === "object"
              ? (r.content as Record<string, unknown>)
              : {};
          const s = c.skill ?? c.skill_key;
          return typeof s === "string" && set.has(s);
        });
      }
      const memories = rows.slice(0, PULL_LIMIT).map((r) => {
        const t = truncateContent(r.content);
        return {
          id: r.id,
          kind: r.kind,
          key: r.key,
          content: t.content,
          truncated: t.truncated,
          importance: r.importance ?? 0,
          created_at: r.created_at,
        };
      });
      return NextResponse.json({ ok: true, memories, lessons: memories });
    } catch (e) {
      return NextResponse.json(
        { error: String((e as Error)?.message ?? e).slice(0, 160) },
        { status: 500 }
      );
    }
  }

  /* ---------------- PUSH ---------------- */
  if (direction === "push") {
    const kind = body.kind;
    if (kind !== "episodic" && kind !== "skill_lesson") {
      return NextResponse.json(
        { error: "kind must be 'episodic' or 'skill_lesson'." },
        { status: 400 }
      );
    }
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key || key.length > 128) {
      return NextResponse.json(
        { error: "key required (max 128 chars)." },
        { status: 400 }
      );
    }
    const content = body.content;
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return NextResponse.json(
        { error: "content must be an object." },
        { status: 400 }
      );
    }
    const size = JSON.stringify(content).length;
    if (size > CONTENT_PUSH_CAP) {
      return NextResponse.json(
        { error: `content too large (${size} bytes > ${CONTENT_PUSH_CAP}).` },
        { status: 400 }
      );
    }
    let importance = 0.5;
    if (body.importance !== undefined) {
      const imp = Number(body.importance);
      if (!Number.isFinite(imp) || imp < 0 || imp > 1) {
        return NextResponse.json(
          { error: "importance must be 0..1." },
          { status: 400 }
        );
      }
      importance = imp;
    }
    try {
      const { data, error } = await sb
        .from("agent_memory")
        .insert({
          user_id: ident.userId,
          agent_id: "phone",
          kind,
          key,
          content,
          importance,
        })
        .select("id")
        .single();
      if (error || !data) {
        throw new Error(error?.message ?? "insert failed");
      }
      return NextResponse.json({ ok: true, id: (data as { id: string }).id });
    } catch (e) {
      return NextResponse.json(
        { error: String((e as Error)?.message ?? e).slice(0, 160) },
        { status: 500 }
      );
    }
  }

  return NextResponse.json(
    { error: "direction must be 'pull' or 'push'." },
    { status: 400 }
  );
}
