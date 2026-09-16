export type ClipStatus =
  | "queued"
  | "rendering"
  | "preview"
  | "approved"
  | "posting"
  | "posted"
  | "submitted"
  | "failed";

export interface Campaign {
  id: string;
  name: string;
  sponsor: string;
  payout_per_1k_usd: number;
  budget_remaining_usd: number | null;
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
}

export interface DayStats {
  date: string;
  target: number;
  submitted: number;
  posted: number;
  in_pipeline: number;
  est_earnings_usd: number;
}
