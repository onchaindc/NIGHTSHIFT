import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";
import { MINDS } from "@/lib/minds/registry";

const ROUTES: Array<{ path: string; priority: number }> = [
  { path: "", priority: 1 },
  { path: "/miners", priority: 0.9 },
  { path: "/terminal", priority: 0.9 },
  { path: "/minds", priority: 0.9 },
  { path: "/work", priority: 0.6 },
  { path: "/overview", priority: 0.6 },
  { path: "/minds/counterparty", priority: 0.9 },
  { path: "/minds/bitcoin-mining", priority: 0.9 },
  // Every Mind profile is public; only available Minds outrank the catalogue's
  // supporting pages, because the rest are product definitions, not tools.
  ...MINDS.map((mind) => ({
    path: `/minds/${mind.slug}`,
    priority: mind.status === "available" ? 0.8 : 0.4,
  })),
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
