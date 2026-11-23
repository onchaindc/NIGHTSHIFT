import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

const ROUTES: Array<{ path: string; priority: number }> = [
  { path: "", priority: 1 },
  { path: "/miners", priority: 0.9 },
  { path: "/terminal", priority: 0.9 },
  { path: "/counterparty", priority: 0.9 },
  { path: "/intents", priority: 0.8 },
  { path: "/evaluators", priority: 0.8 },
  { path: "/validators", priority: 0.7 },
  { path: "/signals", priority: 0.7 },
  { path: "/activity", priority: 0.6 },
  { path: "/developers", priority: 0.6 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map(({ path, priority }) => ({
    url: `${SITE_URL}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" ? "daily" : "hourly",
    priority,
  }));
}
