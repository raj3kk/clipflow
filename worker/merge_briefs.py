"""Briefs ko main hub campaigns me merge karo (2026-09-20).

campaigns25_briefs.json se har campaign ka full brief nikalke
main hub (user_id = nil UUID) rows me update karta hai:
- caption_template, hashtags, requirements
- notes me full brief JSON
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from planner_v2 import sb_retry, MAIN_HUB_USER_ID
from config import TransientError

BRIEFS_FILE = os.path.expanduser("~/workspace/whop-clipping/campaigns25_briefs.json")


def log(msg):
    print(f"[merge_briefs] {msg}", flush=True)


def merge_one(c, max_tries=3):
    """Ek campaign merge karo, transient errors pe retry."""
    uuid = c.get("uuid", "")
    if not uuid:
        return "skip"
    for attempt in range(max_tries):
        try:
            rows = sb_retry("GET", "/rest/v1/campaigns", query={
                "select": "id,notes",
                "user_id": f"eq.{MAIN_HUB_USER_ID}",
                "campaign_url": f"like.*{uuid}*",
                "limit": "1",
            })
            if not rows:
                log(f"NOT FOUND in hub: {c.get('name')} ({uuid[:8]})")
                return "notfound"

            row = rows[0]
            try:
                notes = json.loads(row.get("notes") or "{}")
            except Exception:
                notes = {}
            notes["full_brief"] = {
                "required_caption": c.get("required_caption"),
                "required_title": c.get("required_title"),
                "required_hashtags": c.get("required_hashtags"),
                "required_tags": c.get("required_tags"),
                "required_overlay": c.get("required_overlay"),
                "required_bio_link": c.get("required_bio_link"),
                "content_do": c.get("content_do"),
                "content_dont": c.get("content_dont"),
                "official_sources": c.get("official_sources"),
                "min_seconds": c.get("min_seconds"),
                "max_seconds": c.get("max_seconds"),
                "audience": c.get("audience"),
                "prohibited": c.get("prohibited"),
                "payout_per_1k": c.get("payout_per_1k"),
                "brief_available": c.get("brief_available"),
            }

            hashtags = c.get("required_hashtags") or []
            if isinstance(hashtags, str):
                hashtags = [hashtags] if hashtags else []

            body = {
                "caption_template": c.get("required_caption") or "",
                "hashtags": hashtags,
                "requirements": json.dumps({
                    "do": c.get("content_do"),
                    "dont": c.get("content_dont"),
                    "overlay": c.get("required_overlay"),
                    "bio_link": c.get("required_bio_link"),
                    "title": c.get("required_title"),
                    "tags": c.get("required_tags"),
                }),
                "notes": json.dumps(notes),
            }
            payout_1k = c.get("payout_per_1k") or {}
            ig_rate = payout_1k.get("instagram") if isinstance(payout_1k, dict) else None
            if ig_rate:
                body["payout_per_1k_usd"] = ig_rate
            if c.get("min_payout_usd"):
                body["min_payout_usd"] = c["min_payout_usd"]
            if c.get("max_payout_usd"):
                body["max_payout_usd"] = c["max_payout_usd"]
            if c.get("budget_remaining_usd"):
                body["budget_remaining_usd"] = c["budget_remaining_usd"]

            sb_retry("PATCH", "/rest/v1/campaigns",
                     query={"id": f"eq.{row['id']}"}, body=body)
            log(f"Updated: {c.get('name', '')[:40]}")
            return "ok"
        except TransientError as e:
            log(f"Transient ({attempt+1}/{max_tries}): {c.get('name','')[:30]} — retry")
            time.sleep(5 * (attempt + 1))
        except Exception as e:
            log(f"ERROR {c.get('name','')[:30]}: {e}")
            return "error"
    log(f"FAILED after {max_tries}: {c.get('name','')[:30]}")
    return "failed"


def main():
    with open(BRIEFS_FILE) as f:
        data = json.load(f)
    camps = data.get("campaigns", [])
    log(f"Briefs loaded: {len(camps)}")

    updated = 0
    for c in camps:
        if merge_one(c) == "ok":
            updated += 1

    log(f"Done: {updated}/{len(camps)} merged")
    return updated


if __name__ == "__main__":
    main()
