"use client";

import { useCallback, useEffect, useState } from "react";

export function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(url, { cache: "no-store" });
      const d = (await r.json()) as T & { error?: string };
      if (!r.ok) {
        setError(d.error ?? `Request failed (${r.status})`);
        setData(null);
      } else {
        setData(d);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}
