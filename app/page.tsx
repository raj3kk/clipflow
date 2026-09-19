import { redirect } from "next/navigation";

/**
 * V1 dashboard removed (2026-09-19): ClipFlow ab V2-only hai.
 * Home = Devices tab (phone automation).
 */
export default function Home() {
  redirect("/devices");
}
