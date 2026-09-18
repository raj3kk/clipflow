/**
 * v1 / v2 mode — ek login, do automation models, sab kuch separate.
 *
 * v1 = original ClipFlow (server-side automation: campaigns → clips → post → Whop)
 * v2 = PhoneAgent (user ka phone: app cookies, custom schedule, Run Now)
 *
 * Data pehle se separate tables me hai (v1: campaigns/clips/posts/...,
 * v2: devices/device_jobs/...). Ye sirf UI mode hai, localStorage me persist.
 */

export type AppMode = "v1" | "v2";

export const MODE_KEY = "clipflow-mode";
export const MODE_EVENT = "clipflow-mode-change";

export function getMode(): AppMode {
  if (typeof window === "undefined") return "v1";
  return window.localStorage.getItem(MODE_KEY) === "v2" ? "v2" : "v1";
}

export function setMode(m: AppMode) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MODE_KEY, m);
  window.dispatchEvent(new CustomEvent<AppMode>(MODE_EVENT, { detail: m }));
}
