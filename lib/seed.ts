import { Campaign } from "./types";

/**
 * Fallback campaign list used when Supabase is not configured yet.
 * Mirrors the real campaigns the clipping operation runs on.
 */
export const SEED_CAMPAIGNS: Campaign[] = [
  {
    id: "perplexity-jre",
    name: "Perplexity JRE Clipping — ClipFarm",
    sponsor: "Perplexity",
    payout_per_1k_usd: 1.5,
    budget_remaining_usd: 14880,
    min_seconds: 15,
    max_seconds: 60,
    requirements:
      "15–60s. Only listed brief moments. Perplexity clearly heard AND seen. No fake screens. Caption must include #PerplexityPartner. Minimal overlays, no watermark. Likes visible. ≥0.20% engagement. ≥40% views from US/UK/CA/AU. Keep live 30 days. No boosting/bots.",
    caption_template:
      'Joe Rogan: "I just ask Perplexity" instead of sifting through Google searches 🤯 #PerplexityPartner',
    hashtags: ["#PerplexityPartner"],
    brief_url:
      "https://docs.google.com/document/d/1r3jFWtBrRbNdvp38w4qvcVK7vgu_6aK2GFQIS3pUBVk/edit?usp=sharing",
    campaign_url:
      "https://contentrewards.com/discover/00aa48e9-dc39-45f5-8c28-3d5821713826/preview",
    joined: true,
    active: true,
  },
  {
    id: "blizzard-blizzcon",
    name: "Blizzard BlizzCon 2026 Trailer Clipping",
    sponsor: "Blizzard",
    payout_per_1k_usd: 1.5,
    budget_remaining_usd: 52000,
    min_seconds: 15,
    max_seconds: 60,
    requirements:
      "Official trailer-folder footage only. Caption #BlizzardPartner + franchise hashtag. Keep live 30 days.",
    caption_template: "The Diablo V reveal is here 🔥 #BlizzardPartner #DiabloV",
    hashtags: ["#BlizzardPartner", "#DiabloV"],
    brief_url: null,
    campaign_url: null,
    joined: true,
    active: true,
  },
  {
    id: "moonpay-cli",
    name: "MoonPay CLI Clipping",
    sponsor: "MoonPay",
    payout_per_1k_usd: 1.5,
    budget_remaining_usd: null,
    min_seconds: 15,
    max_seconds: 60,
    requirements:
      "Explain what MoonPay CLI does. Tag @moonpay in caption.",
    caption_template:
      "What is MoonPay CLI? Ivan Soto-Wright explains how AI agents can transact with one line of code. @moonpay",
    hashtags: [],
    brief_url: null,
    campaign_url: null,
    joined: true,
    active: true,
  },
];

export const DAILY_TARGET = 4;
