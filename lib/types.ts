export type ClipStatus =
  | "queued"
  | "rendering"
  | "preview"
  | "approved"
  | "scheduled"
  | "posting"
  | "posted"
  | "submitted"
  | "failed";

export type ConnectionService = "instagram" | "whop" | "gmail" | "content_rewards";

export type ConnectionStatus =
  | "needs_setup"
  | "saved_unverified"
  | "verified"
  | "broken";

export type InterventionStatus = "pending" | "resolved" | "consumed" | "expired";

export interface Campaign {
  id: string;
  name: string;
  sponsor: string;
  payout_per_1k_usd: number;
  budget_remaining_usd: number | null;
  min_payout_usd: number | null;
  max_payout_usd: number | null;
  join_status: string;
  scout_score: number | null;
  notes: string | null;
  min_seconds: number;
  max_seconds: number;
  requirements: string;
  caption_template: string;
  hashtags: string[];
  brief_url: string | null;
  campaign_url: string | null;
  joined: boolean;
  active: boolean;
  created_at?: string;
}

/** Payload for POST /api/campaigns (id, name, sponsor required). */
export interface CampaignInput {
  id: string;
  name: string;
  sponsor: string;
  payout_per_1k_usd?: number;
  budget_remaining_usd?: number | null;
  min_payout_usd?: number | null;
  max_payout_usd?: number | null;
  min_seconds?: number;
  max_seconds?: number;
  requirements?: string;
  caption_template?: string;
  hashtags?: string[];
  brief_url?: string | null;
  campaign_url?: string | null;
  joined?: boolean;
  join_status?: string;
  active?: boolean;
  scout_score?: number | null;
  notes?: string | null;
}

export interface Clip {
  id: string;
  campaign_id: string;
  campaign_name?: string;
  source_url: string;
  start_sec: number;
  end_sec: number;
  hook_text: string | null;
  caption: string | null;
  status: ClipStatus;
  video_url: string | null;
  preview_urls: string[] | null;
  instagram_url: string | null;
  posted_at: string | null;
  error: string | null;
  qa_result: unknown;
  scheduled_for: string | null;
  brief_check: unknown;
  verification: unknown;
  created_at?: string;
}

export interface PostSubmission {
  id: string;
  whop_status: string | null;
  submitted_at: string | null;
  keep_live_until: string | null;
}

export interface Post {
  id: string;
  clip_id: string | null;
  campaign_id: string | null;
  campaign_name?: string;
  instagram_url: string;
  platform: string;
  /** Planned post time. Set when a clip is scheduled; null for manual posts. */
  scheduled_for: string | null;
  /** Actual post time. Null until the post really goes live. */
  posted_at: string | null;
  verify_status: string;
  verify_detail: { frames?: string[]; detail?: string } | null;
  /** First linked Whop submission, if any. */
  submission?: PostSubmission | null;
  created_at?: string;
}

export interface Submission {
  id: string;
  clip_id: string;
  campaign_name?: string;
  instagram_url: string;
  whop_status: string;
  submitted_at: string | null;
  views: number | null;
  earnings_usd: number | null;
  keep_live_until: string | null;
  post_id: string | null;
}

export interface Connection {
  id: string;
  service: ConnectionService;
  method: string;
  label: string | null;
  status: ConnectionStatus;
  last_verified: string | null;
  /** true when a secret is stored; the raw secret is never exposed via API */
  has_secret: boolean;
  meta: unknown;
  created_at?: string;
}

export interface Intervention {
  id: string;
  kind: string;
  clip_id: string | null;
  question: string;
  detail: unknown;
  status: InterventionStatus;
  email_sent_at: string | null;
  resolved_at: string | null;
  resolved_via: string | null;
  created_at?: string;
  // value_enc and any decrypted value are NEVER included in API responses
}

export interface ActivityEntry {
  id: number;
  ts: string;
  actor: string | null;
  event: string;
  detail: unknown;
}

export interface Settings {
  id: number;
  daily_target: number;
  spacing_hours: number;
  notify_email: string | null;
  pause_on_block: boolean;
  platforms: Record<string, boolean>;
  updated_at?: string;
}

export interface DayStats {
  date: string;
  target: number;
  submitted: number;
  posted: number;
  in_pipeline: number;
  est_earnings_usd: number;
  per_campaign: {
    id: string;
    name: string;
    budget_remaining_usd: number | null;
    payout_per_1k_usd: number;
  }[];
}

/** Aliases used by the frontend pages. */
export type DashboardStats = DayStats;
export type SubmissionRow = Submission;
export type AppSettings = Settings;
