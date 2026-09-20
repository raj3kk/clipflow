"""
Main Hub — Daily Campaign Pool (2026-09-20)

Ek shared campaign pool jo sab users ke automation ko feed karta hai.
- Daily 25 campaigns server-side discovery (contentrewards.com, no signin)
- 24h baad purane campaigns auto-delete, naye 25 aate hain
- Campaigns user_id=NULL ke saath shared pool me hain (kisi user ke nahi)
- Automation har run pe 25 me se RANDOM ek campaign select karta hai
- Full brief (caption, title, hashtag, tags, requirements) har campaign me
"""
import json
import os
import random
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from planner_v2 import sb_retry
from discover_scraper import fetch, parse_cards, DISCOVER_URL

POOL_SIZE = 25
POOL_TTL_HOURS = 24
# Main hub ka fixed UUID — shared pool ka marker
# (DB me user_id NOT NULL hai, isliye nil UUID use karte hain)
MAIN_HUB_USER_ID = "00000000-0000-0000-0000-000000000000"


def log(msg: str):
    print(f"[mainhub] {msg}", flush=True)


def get_pool():
    """Shared pool ke active campaigns (user_id IS NULL)."""
    return sb_retry("GET", "/rest/v1/campaigns", query={
        "select": "id,name,sponsor,payout_per_1k_usd,budget_remaining_usd,"
                  "min_payout_usd,max_payout_usd,requirements,caption_template,"
                  "hashtags,brief_url,campaign_url,created_at,notes",
        "user_id": "eq.00000000-0000-0000-0000-000000000000",
        "active": "eq.true",
        "order": "created_at.desc",
        "limit": str(POOL_SIZE * 2),
    })


def pool_age_hours():
    """Sabse purane pool campaign ki age."""
    rows = get_pool()
    if not rows:
        return 999
    oldest = min(r["created_at"] for r in rows)
    dt = datetime.fromisoformat(oldest.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - dt).total_seconds() / 3600


def cleanup_old():
    """24h se purane shared campaigns delete karo."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=POOL_TTL_HOURS)).isoformat()
    rows = sb_retry("GET", "/rest/v1/campaigns", query={
        "select": "id",
        "user_id": "eq.00000000-0000-0000-0000-000000000000",
        "created_at": f"lt.{cutoff}",
        "limit": "100",
    })
    for r in rows:
        sb_retry("DELETE", "/rest/v1/campaigns", query={"id": f"eq.{r['id']}"})
    if rows:
        log(f"Cleaned {len(rows)} old campaigns")
    return len(rows)


def discover_25():
    """Server-side discovery: 25 campaigns nikalo."""
    html = fetch(DISCOVER_URL)
    cards = parse_cards(html)
    # Top 25 by payout (IG eligible pehle)
    def score(c):
        ig = 1 if "Instagram" in c.get("platforms", []) else 0
        return (ig, c.get("cpm_usd_per_1k") or 0)
    cards = sorted(cards, key=score, reverse=True)[:POOL_SIZE]
    log(f"Discovered {len(cards)} campaigns")
    return cards


def upsert_pool(cards):
    """Cards ko shared pool me dalo (user_id=NULL)."""
    count = 0
    for c in cards:
        uuid = c.get("uuid", "")
        # budget_remaining = budget - spent (approx)
        budget_rem = None
        try:
            if c.get("budget") and c.get("spent"):
                b = float(str(c["budget"]).replace(",", ""))
                s = float(str(c["spent"]).replace(",", ""))
                budget_rem = max(0, b - s)
        except: pass
        body = {
            "id": f"hub-{uuid[:8]}",
            "name": c.get("name", "") or "Untitled",
            "sponsor": c.get("brand", "") or c.get("name", "")[:50] or "Unknown",
            "payout_per_1k_usd": c.get("cpm_usd_per_1k", 0) or 0,
            "budget_remaining_usd": budget_rem,
            "min_payout_usd": 0,
            "max_payout_usd": 0,
            "campaign_url": c.get("detail_url", ""),
            "user_id": MAIN_HUB_USER_ID,  # SHARED POOL
            "active": True,
            "joined": False,
            "join_status": "not_joined",
            "notes": json.dumps({
                "source": "mainhub_daily",
                "discovered_at": datetime.now(timezone.utc).isoformat(),
                "thumbnail": c.get("thumbnail", ""),
                "platforms": c.get("platforms", []),
                "verified": c.get("verified", False),
            }),
        }
        try:
            sb_retry("POST", "/rest/v1/campaigns", query={"on_conflict": "id"},
                     body=body)
            count += 1
        except Exception as e:
            log(f"Upsert failed {c.get('name')}: {e}")
    log(f"Upserted {count}/{len(cards)} to pool")
    return count


def check_manual_request():
    """Admin panel se manual refresh request hai? (activity_log me event)"""
    try:
        rows = sb_retry("GET", "/rest/v1/activity_log", query={
            "select": "id,ts",
            "event": "eq.hub_refresh_requested",
            "order": "ts.desc",
            "limit": "1",
        })
        if not rows:
            return False
        # 1h ke andar ki request ho to manual refresh
        from datetime import datetime
        ts = datetime.fromisoformat(rows[0]["ts"].replace("Z", "+00:00"))
        age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
        return age_h < 1
    except Exception:
        return False


def refresh_pool(force=False):
    """Main entry: agar pool khali ya 24h purana to refresh karo."""
    # Admin manual request check
    if not force and check_manual_request():
        log("Admin manual refresh request — force refresh")
        force = True
    age = pool_age_hours()
    pool = get_pool()
    log(f"Pool: {len(pool)} campaigns, age {age:.1f}h")

    if not force and pool and age < POOL_TTL_HOURS:
        log("Pool fresh hai, kuch nahi karna")
        return {"refreshed": False, "count": len(pool), "age_hours": age}

    # Purane delete karo
    cleanup_old()
    # Naye 25 nikalo
    cards = discover_25()
    count = upsert_pool(cards)
    return {"refreshed": True, "count": count, "age_hours": 0}


def pick_random(exclude_ids=None):
    """25 me se RANDOM ek campaign select karo."""
    pool = get_pool()
    if exclude_ids:
        pool = [c for c in pool if c["id"] not in exclude_ids]
    if not pool:
        return None
    return random.choice(pool)


if __name__ == "__main__":
    force = "--force" in sys.argv
    result = refresh_pool(force=force)
    print(json.dumps(result, indent=2))
# Main Hub deploy trigger
