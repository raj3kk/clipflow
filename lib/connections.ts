import type { Connection } from "./types";

/** Strip the encrypted secret; expose only has_secret. */
export function toPublic(row: Record<string, unknown>): Connection {
  return {
    id: row.id as string,
    service: row.service as Connection["service"],
    method: row.method as string,
    label: (row.label as string | null) ?? null,
    status: row.status as Connection["status"],
    last_verified: (row.last_verified as string | null) ?? null,
    has_secret: Boolean(row.secret_enc),
    meta: row.meta ?? null,
    created_at: row.created_at as string | undefined,
  };
}
