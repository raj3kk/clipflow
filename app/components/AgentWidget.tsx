"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* Browser Speech API types (webkit fallback) */
declare global {
  interface Window {
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
  }
}

interface AgentLink {
  label: string;
  href: string;
}
interface GuideState {
  topic: string;
  step: number;
}
interface Msg {
  role: "user" | "bot";
  text: string;
  link?: AgentLink | null;
  showRunNow?: boolean;
  suggestions?: string[];
}
interface DeviceLite {
  id: string;
  device_name: string;
  status: string;
}

/* ---------- inline icons (stroke style, codebase convention) ---------- */
const I = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    className={className ?? "h-5 w-5 shrink-0"}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);
const IconChat = (p: { className?: string }) => (
  <I {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />
    <circle cx="9" cy="12" r="0.6" fill="currentColor" />
    <circle cx="13" cy="12" r="0.6" fill="currentColor" />
    <circle cx="17" cy="12" r="0.6" fill="currentColor" />
  </I>
);
const IconX = (p: { className?: string }) => (
  <I {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </I>
);
const IconMic = (p: { className?: string }) => (
  <I {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </I>
);
const IconSpeaker = (p: { className?: string }) => (
  <I {...p}>
    <path d="M4 10v4h4l5 4V6l-5 4H4z" />
    <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
  </I>
);
const IconSpeakerOff = (p: { className?: string }) => (
  <I {...p}>
    <path d="M4 10v4h4l5 4V6l-5 4H4z" />
    <path d="M16 9l6 6M22 9l-6 6" />
  </I>
);
const IconSend = (p: { className?: string }) => (
  <I {...p}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
  </I>
);
const IconBolt = (p: { className?: string }) => (
  <I {...p}>
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
  </I>
);

/* ---------- chhota markdown renderer: **bold** + line break ---------- */
function renderRich(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

function stripForSpeech(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/🟢|🟡|🔴/g, "")
    .replace(/\n+/g, ". ")
    .slice(0, 600);
}

const GREETING: Msg = {
  role: "bot",
  text: "Namaste! Main **ClipFlow Agent** hoon.\n\nMujhse pucho — enroll, schedule, coins, ya **\"abhi kya chal raha hai?\"** Mic dabake bol bhi sakte ho.",
  suggestions: [
    "Abhi kya chal raha hai?",
    "Device enroll kaise karu?",
    "Coins kaise milte hain?",
    "Mujhe schedule lagana hai",
  ],
};

export default function AgentWidget() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [speakOn, setSpeakOn] = useState(false);
  const [guide, setGuide] = useState<GuideState | null>(null);
  const [devices, setDevices] = useState<DeviceLite[] | null>(null);
  const [confirmRun, setConfirmRun] = useState<DeviceLite | null>(null);
  const [pickDevice, setPickDevice] = useState(false);
  const [running, setRunning] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<any>(null);
  const guideRef = useRef<GuideState | null>(null);
  guideRef.current = guide;

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, open, loading]);

  useEffect(() => {
    return () => {
      try {
        recRef.current?.stop();
        window.speechSynthesis?.cancel();
      } catch {}
    };
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!speakOn) return;
      try {
        const synth = window.speechSynthesis;
        if (!synth) return;
        synth.cancel();
        const u = new SpeechSynthesisUtterance(stripForSpeech(text));
        u.lang = "hi-IN";
        u.rate = 1;
        synth.speak(u);
      } catch {}
    },
    [speakOn]
  );

  const pushBot = useCallback(
    (m: Msg) => {
      setMsgs((p) => [...p, m]);
      speak(m.text);
    },
    [speak]
  );

  const send = useCallback(
    async (raw: string, guideOverride?: GuideState | null) => {
      const text = raw.trim();
      if (!text || loading) return;
      setMsgs((p) => [...p, { role: "user", text }]);
      setInput("");
      setLoading(true);
      try {
        const r = await fetch("/api/agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            guide: guideOverride !== undefined ? guideOverride : guideRef.current,
          }),
        });
        const d = await r.json();
        if (!r.ok) {
          if (r.status === 401) {
            pushBot({
              role: "bot",
              text: "Pehle **login** karo — main sirf logged-in user ke apne account ka haal bata sakta hoon.",
              link: { label: "Login karo", href: "/login" },
            });
            return;
          }
          throw new Error(d.error ?? r.status);
        }
        setGuide(d.guide ?? null);
        pushBot({
          role: "bot",
          text: d.reply ?? "Kuch gadbad ho gayi.",
          link: d.link ?? null,
          showRunNow: d.showRunNow ?? false,
          suggestions: d.suggestions ?? [],
        });
      } catch (e) {
        pushBot({
          role: "bot",
          text: `Arre, jawab nahi aa paya (${e instanceof Error ? e.message : "error"}). Dobara try karo.`,
        });
      } finally {
        setLoading(false);
      }
    },
    [loading, pushBot]
  );

  /* ---------- voice input: Web Speech API (₹0, browser me hi) ---------- */
  const toggleMic = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      pushBot({
        role: "bot",
        text: "Is browser me voice input supported nahi hai. **Chrome** (Android/desktop) me kholo — wahan chalega.",
      });
      return;
    }
    if (listening) {
      try {
        recRef.current?.stop();
      } catch {}
      return;
    }
    try {
      const rec = new SR();
      rec.lang = "hi-IN";
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let finalText = "";
      rec.onresult = (e: any) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += t;
          else interim += t;
        }
        setInput((finalText + interim).trim());
      };
      rec.onend = () => {
        setListening(false);
        const t = finalText.trim();
        if (t) send(t);
      };
      rec.onerror = () => setListening(false);
      recRef.current = rec;
      rec.start();
      setListening(true);
    } catch {
      pushBot({ role: "bot", text: "Mic start nahi ho paya. Browser ko mic permission do." });
    }
  }, [listening, pushBot, send]);

  /* ---------- Run Now: sirf confirm ke baad existing API call ---------- */
  const loadDevices = useCallback(async (): Promise<DeviceLite[]> => {
    if (devices) return devices;
    const r = await fetch("/api/devices");
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? r.status);
    const list: DeviceLite[] = (d.devices ?? []).filter(
      (x: any) => !x.deleted_at && x.status !== "deleted"
    );
    setDevices(list);
    return list;
  }, [devices]);

  const onRunNowClick = useCallback(async () => {
    try {
      const list = await loadDevices();
      if (list.length === 0) {
        pushBot({
          role: "bot",
          text: "Abhi **koi device enroll nahi** hai — pehle device jodo, phir Run Now chalega.",
          link: { label: "Devices page kholo", href: "/devices" },
          suggestions: ["Device enroll kaise karu?"],
        });
        return;
      }
      if (list.length === 1) setConfirmRun(list[0]);
      else setPickDevice(true);
    } catch (e) {
      pushBot({
        role: "bot",
        text: `Device list nahi aa payi (${e instanceof Error ? e.message : "error"}).`,
      });
    }
  }, [loadDevices, pushBot]);

  const confirmRunNow = useCallback(async () => {
    if (!confirmRun || running) return;
    setRunning(true);
    try {
      const r = await fetch(`/api/devices/${confirmRun.id}/run-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "automation" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? d.detail ?? r.status);
      const via = d.via === "fcm" ? "phone ko push bhej diya — turant chalega" : "job queue ho gaya — phone agle check pe uthayega";
      pushBot({
        role: "bot",
        text: `**Run Now shuru!** ${confirmRun.device_name} pe ${via}.\n\nLive progress **Devices → Live** tab pe dekho.`,
        link: { label: "Live status dekho", href: "/devices/live" },
      });
    } catch (e) {
      pushBot({
        role: "bot",
        text: `Run Now nahi ho paya: ${e instanceof Error ? e.message : "error"}\n\nAksar wajah: clip package set nahi hai ya device paused hai. Devices page pe check karo.`,
        link: { label: "Devices page kholo", href: "/devices" },
      });
    } finally {
      setRunning(false);
      setConfirmRun(null);
    }
  }, [confirmRun, running, pushBot]);

  return (
    <>
      {/* floating button — har page, bottom-right */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="ClipFlow Agent se baat karo"
          title="ClipFlow Agent"
          className="fixed bottom-24 right-4 z-[60] grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-emerald-500 via-emerald-600 to-emerald-700 text-white shadow-lg shadow-emerald-900/30 ring-2 ring-amber-400/70 transition-transform hover:scale-105 active:scale-95 md:bottom-8 md:right-8"
        >
          <IconChat className="h-7 w-7" />
          <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full bg-amber-400 ring-2 ring-white" />
        </button>
      )}

      {open && (
        <div
          className="fixed z-[70] flex flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl animate-fade-up
            inset-0 md:inset-auto md:bottom-24 md:right-6 md:h-[600px] md:w-[390px] md:rounded-3xl"
          role="dialog"
          aria-label="ClipFlow Agent chat"
        >
          {/* header — emerald/gold */}
          <div className="flex items-center gap-3 bg-gradient-to-r from-emerald-700 via-emerald-600 to-emerald-700 px-4 py-3 text-white">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-white/15 ring-1 ring-amber-300/60">
              <IconChat className="h-5 w-5 text-amber-300" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold leading-tight">ClipFlow Agent</div>
              <div className="text-[11px] text-emerald-100">sawal pucho, ya bolke baat karo</div>
            </div>
            <button
              onClick={() => {
                setSpeakOn((v) => {
                  if (v) window.speechSynthesis?.cancel();
                  return !v;
                });
              }}
              title={speakOn ? "Jawab sunana band karo" : "Jawab sunao"}
              aria-label="Voice output toggle"
              className={`grid h-9 w-9 place-items-center rounded-full transition ${
                speakOn ? "bg-amber-400 text-emerald-900" : "bg-white/15 text-white hover:bg-white/25"
              }`}
            >
              {speakOn ? <IconSpeaker className="h-5 w-5" /> : <IconSpeakerOff className="h-5 w-5" />}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                try {
                  recRef.current?.stop();
                  window.speechSynthesis?.cancel();
                } catch {}
              }}
              aria-label="Chat band karo"
              className="grid h-9 w-9 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
            >
              <IconX className="h-5 w-5" />
            </button>
          </div>

          {/* messages */}
          <div ref={bodyRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-4 py-4">
            {msgs.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "rounded-br-md bg-emerald-600 text-white"
                      : "rounded-bl-md border border-slate-200 bg-white text-slate-800 shadow-sm"
                  }`}
                >
                  {renderRich(m.text)}
                  {m.link && (
                    <a
                      href={m.link.href}
                      className={`mt-2 inline-block rounded-lg px-3 py-1.5 text-xs font-bold ${
                        m.role === "user"
                          ? "bg-white/20 text-white underline"
                          : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
                      }`}
                    >
                      {m.link.label} →
                    </a>
                  )}
                  {m.showRunNow && m.role === "bot" && (
                    <button
                      onClick={onRunNowClick}
                      className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-3 py-2 text-sm font-bold text-white shadow hover:from-amber-600 hover:to-amber-700"
                    >
                      <IconBolt className="h-4 w-4" /> Abhi Run Karo
                    </button>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-sm">
                  <span className="animate-pulse">soch raha hoon…</span>
                </div>
              </div>
            )}
            {/* suggestion chips */}
            {!loading && msgs.length > 0 && (msgs[msgs.length - 1].suggestions?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {msgs[msgs.length - 1].suggestions!.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => send(s)}
                    className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* guide mode banner */}
          {guide && (
            <div className="flex items-center justify-between gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
              <span className="font-semibold">Guide mode: step {guide.step + 1} chal raha hai</span>
              <button
                onClick={() => send("guide band karo", guide)}
                className="rounded-full bg-amber-100 px-2.5 py-1 font-bold hover:bg-amber-200"
              >
                Band karo
              </button>
            </div>
          )}

          {/* quick Run Now */}
          <div className="border-t border-slate-200 bg-white px-4 pt-2.5">
            <button
              onClick={onRunNowClick}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 px-3 py-2.5 text-sm font-bold text-white shadow hover:from-emerald-700 hover:to-emerald-800"
            >
              <IconBolt className="h-4 w-4 text-amber-300" /> Abhi Run Karo
            </button>
          </div>

          {/* input row */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 bg-white px-3 pb-3 pt-2"
            style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          >
            <button
              type="button"
              onClick={toggleMic}
              aria-label={listening ? "Sunna band karo" : "Bolke likho"}
              title={listening ? "Sun raha hoon… dabao band karne ke liye" : "Mic dabao, bolo"}
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition ${
                listening
                  ? "animate-pulse bg-red-500 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-emerald-100 hover:text-emerald-700"
              }`}
            >
              <IconMic className="h-5 w-5" />
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={listening ? "Sun raha hoon…" : "Likho ya mic dabake bolo…"}
              className="min-w-0 flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-900 outline-none focus:border-emerald-400 focus:bg-white"
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              aria-label="Bhejo"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-600 text-white transition hover:bg-emerald-700 disabled:opacity-40"
            >
              <IconSend className="h-5 w-5" />
            </button>
          </form>
        </div>
      )}

      {/* device picker (ek se zyada device) */}
      {pickDevice && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-slate-900/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl animate-fade-up">
            <h3 className="text-base font-bold text-slate-900">Kaunse device pe chalau?</h3>
            <div className="mt-3 space-y-2">
              {(devices ?? []).map((d) => (
                <button
                  key={d.id}
                  onClick={() => {
                    setPickDevice(false);
                    setConfirmRun(d);
                  }}
                  className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-left text-sm font-medium text-slate-800 hover:border-emerald-300 hover:bg-emerald-50"
                >
                  {d.device_name}
                </button>
              ))}
            </div>
            <button
              onClick={() => setPickDevice(false)}
              className="mt-4 w-full rounded-xl bg-slate-100 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-200"
            >
              Radd karo
            </button>
          </div>
        </div>
      )}

      {/* Run Now confirm dialog — bina confirm ke API call NAHI */}
      {confirmRun && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-slate-900/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl animate-fade-up">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-amber-100 text-amber-700">
                <IconBolt className="h-5 w-5" />
              </span>
              <h3 className="text-base font-bold text-slate-900">Pakka chalau?</h3>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              Run Now se <strong className="text-slate-900">{confirmRun.device_name}</strong> pe
              automatic clipping run shuru hoga — campaign → clip → Instagram post → Whop submit.
              <br />
              <br />
              Pakka?
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setConfirmRun(null)}
                disabled={running}
                className="flex-1 rounded-xl bg-slate-100 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
              >
                Radd karo
              </button>
              <button
                onClick={confirmRunNow}
                disabled={running}
                className="flex-1 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 py-2.5 text-sm font-bold text-white hover:from-emerald-700 hover:to-emerald-800 disabled:opacity-50"
              >
                {running ? "Chal raha hai…" : "Haan, chalao"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
