/**
 * Frontend view-model for posts. The backend's GET /api/posts returns each
 * post with embedded `campaigns(name)` and `submissions([...])` joins.
 * A post row is created at *schedule* time: instagram_url is "" until the
 * worker actually posts, and posted_at holds the scheduled time until then.
 */

export interface PostSubmission {
  id: string;
  whop_status: string;
  submitted_at: string | null;
  views: number | null;
  earnings_usd: number | null;
  keep_live_until: string | null;
}

export interface PostRow {
  id: string;
  clip_id: string | null;
  campaign_id: string | null;
  campaign_name?: string | null;
  campaigns?: { name: string } | null;
  instagram_url: string | null;
  platform: string | null;
  posted_at: string | null;
  verify_status: string | null;
  verify_detail: { frames?: string[]; detail?: string } | null;
  submissions?: PostSubmission[] | null;
}

/** True when the post is scheduled but the worker hasn't posted it yet. */
export function isScheduled(p: PostRow): boolean {
  return !p.instagram_url;
}

export function postCampaignName(p: PostRow): string {
  return p.campaign_name ?? p.campaigns?.name ?? "—";
}

/** First (latest) linked Whop submission, if any. */
export function postSubmission(p: PostRow): PostSubmission | null {
  const s = p.submissions;
  return s && s.length > 0 ? s[0] : null;
}
