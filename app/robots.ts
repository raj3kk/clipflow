import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/guide", "/terms", "/privacy"],
        disallow: ["/api/", "/admin/", "/devices", "/campaigns", "/connections", "/activity", "/settings", "/profile", "/live", "/login", "/signup"],
      },
    ],
    sitemap: "https://clipflow-webbuilder1.vercel.app/sitemap.xml",
  };
}
