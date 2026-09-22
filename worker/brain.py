#!/usr/bin/env python3
"""
ClipFlow autopilot brain — clip ideation from a source video/audio URL.

pick_moment(source_url, min_dur, max_dur, keywords) -> dict | None

  Downloads audio (YouTube via yt-dlp, or direct .mp4/.mov/.webm via curl),
  transcribes with faster_whisper (word timestamps), then slides scoring
  windows across the transcript and returns the best moment:

    {"start_sec": int, "end_sec": int, "hook_text": str, "text": str,
     "score": float}

On ANY failure it returns None (never raises). Temp files are always
cleaned up. No secrets are involved here; nothing sensitive is logged.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402

VENV_PY = os.path.expanduser("~/workspace/whop-edit-env/bin/python")

DOWNLOAD_TIMEOUT = 600     # seconds
TRANSCRIBE_TIMEOUT = 1500  # seconds
MAX_DIRECT_BYTES = 400 * 1024 * 1024  # ~400MB cap for direct media

_YT_PATTERNS = ("youtube.com/watch", "youtu.be/",
                "youtube.com/shorts/", "youtube.com/live/")
_MEDIA_EXTS = (".mp4", ".mov", ".webm")
_QUESTION_WORDS = ("what", "why", "how", "when", "where",
                   "who", "which", "can", "did", "is", "are")


def _classify(url: str) -> str | None:
    """Return 'youtube' | 'direct' | None."""
    u = (url or "").strip().lower()
    if any(p in u for p in _YT_PATTERNS):
        return "youtube"
    path = u.split("?", 1)[0].split("#", 1)[0]
    if u.startswith(("http://", "https://")) and \
            any(path.endswith(ext) for ext in _MEDIA_EXTS):
        return "direct"
    return None


def _download_youtube_audio(url: str, tmp: str) -> str | None:
    """Download audio-only (first 40 min) as wav. Returns wav path or None."""
    out_tmpl = os.path.join(tmp, "src.%(ext)s")
    cmd = [config.YTDLP, "--no-check-certificate",
           "--extractor-args", "youtube:player_client=android",
           "--download-sections", "*0-2400",
           "-x", "--audio-format", "wav", "--audio-quality", "0",
           "-o", out_tmpl, url]
    subprocess.run(cmd, capture_output=True, timeout=DOWNLOAD_TIMEOUT,
                   check=True)
    for fn in os.listdir(tmp):
        if fn.startswith("src.") and fn.lower().endswith(".wav"):
            return os.path.join(tmp, fn)
    return None


def _download_direct_media(url: str, tmp: str) -> str | None:
    """Download a direct media URL (capped), extract mono wav. None on fail."""
    media_path = os.path.join(tmp, "src_media")
    wav_path = os.path.join(tmp, "src.wav")
    subprocess.run(["curl", "-L", "--fail", "--max-time", "570",
                    "--max-filesize", str(MAX_DIRECT_BYTES),
                    "-o", media_path, url],
                   capture_output=True, timeout=DOWNLOAD_TIMEOUT, check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", media_path,
                    "-vn", "-ac", "1", "-ar", "16000", wav_path],
                   capture_output=True, timeout=DOWNLOAD_TIMEOUT, check=True)
    return wav_path if os.path.exists(wav_path) else None


_TRANSCRIBE_SCRIPT = r"""
import json, sys
from faster_whisper import WhisperModel
model = WhisperModel("small", device="cpu", compute_type="int8")
segments, _info = model.transcribe(sys.argv[1], word_timestamps=True)
out = []
for seg in segments:
    for w in (seg.words or []):
        txt = (w.word or "").strip()
        if txt:
            out.append({"w": txt, "s": round(float(w.start), 2),
                        "e": round(float(w.end), 2)})
print(json.dumps(out))
"""


def _transcribe(wav_path: str) -> list[dict] | None:
    """Word-level transcript via the edit venv. None on any failure."""
    proc = subprocess.run(
        [VENV_PY, "-c", _TRANSCRIBE_SCRIPT, wav_path],
        capture_output=True, text=True, timeout=TRANSCRIBE_TIMEOUT)
    if proc.returncode != 0:
        return None
    try:
        words = json.loads(proc.stdout)
    except Exception:
        return None
    if not isinstance(words, list) or not words:
        return None
    return words


def _score_windows(words: list[dict], min_dur: float, max_dur: float,
                   keywords: list[str]) -> list[dict]:
    """Slide windows; return [{'start': a, 'end': b, 'score': s, 'text': t}]."""
    dur = max(float(w["e"]) for w in words)
    if dur < min_dur:
        return []
    kw = [k.lower() for k in (keywords or []) if k]
    results: list[dict] = []
    length = min_dur
    while length <= max_dur + 1e-6:
        start = 0.0
        while start + length <= dur + 1e-6:
            end = start + length
            win_words = [w for w in words
                         if float(w["e"]) > start and float(w["s"]) < end]
            if win_words:
                covered = sum(
                    min(float(w["e"]), end) - max(float(w["s"]), start)
                    for w in win_words)
                density = covered / length
                text = " ".join(w["w"] for w in win_words)
                low = text.lower()
                punct = sum(1 for c in text if c in "!?")
                hits = sum(1 for k in kw if k in low)
                silence = 0.0
                for prev, nxt in zip(win_words, win_words[1:]):
                    gap = float(nxt["s"]) - float(prev["e"])
                    if gap > 2.5:
                        silence += gap
                silence_frac = silence / length
                first = (win_words[0]["w"] or "").lower().strip("“\"'(")
                starts_q = 1.0 if first in _QUESTION_WORDS else 0.0
                score = (0.45 * density
                         + 0.25 * min(punct, 3) / 3
                         + 0.2 * min(hits, 5) / 5
                         + 0.1 * starts_q
                         - 0.4 * silence_frac)
                results.append({"start": start, "end": end,
                                "score": score, "text": text})
            start += 10.0
        length += 5.0
    return results


def _hook_text(text: str) -> str:
    """First sentence of the window text, max 90 chars cut at last space."""
    first = re.split(r"[.!?]+", text, maxsplit=1)[0].strip()
    if len(first) <= 90:
        return first
    cut = first[:90].rsplit(" ", 1)[0]
    return cut if cut else first[:90]


def pick_moment(source_url: str, min_dur: float, max_dur: float,
                keywords: list[str]) -> dict | None:
    """
    Pick the best clip moment from source_url. Returns
    {"start_sec", "end_sec", "hook_text", "text", "score"} or None.
    Never raises.
    """
    try:
        kind = _classify(source_url)
        if kind is None:
            return None
        tmp = tempfile.mkdtemp(prefix="clipflow_brain_")
        try:
            if kind == "youtube":
                wav = _download_youtube_audio(source_url, tmp)
            else:
                wav = _download_direct_media(source_url, tmp)
            if not wav:
                return None
            words = _transcribe(wav)
            if not words:
                return None
            scored = _score_windows(words, float(min_dur), float(max_dur),
                                    keywords or [])
            if not scored:
                return None
            best = max(scored, key=lambda r: r["score"])
            return {
                "start_sec": int(round(best["start"])),
                "end_sec": int(round(best["end"])),
                "hook_text": _hook_text(best["text"]),
                "text": best["text"],
                "score": round(float(best["score"]), 4),
            }
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    except Exception as e:  # noqa: BLE001
        print(f"[brain] pick_moment failed: {e}", flush=True)
        return None


if __name__ == "__main__":
    # manual probe: python3 brain.py <url> [min_dur] [max_dur] [kw1,kw2...]
    url = sys.argv[1] if len(sys.argv) > 1 else ""
    lo = float(sys.argv[2]) if len(sys.argv) > 2 else 15
    hi = float(sys.argv[3]) if len(sys.argv) > 3 else 50
    kws = sys.argv[4].split(",") if len(sys.argv) > 4 else []
    print(json.dumps(pick_moment(url, lo, hi, kws), indent=2))
