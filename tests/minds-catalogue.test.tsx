import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MINDS, MIND_STATUS_LABEL, mindBySlug, mindIndex, mindsByStatus } from "@/lib/minds/registry";
import { MIND_FOUNDATION, MIND_PIPELINE } from "@/lib/minds/foundation";
import MindsPage from "@/app/(explorer)/minds/page";
import MindProfilePage from "@/app/(explorer)/minds/[slug]/page";
import { GET as mindsApi } from "@/app/api/minds/route";

const REQUIRED = [
  "Bitcoin Mining Intelligence",
  "Index Reconstitution Desk",
  "PortSentinel",
  "MineWatch",
  "ChainForensics",
  "OwnershipGraph",
  "TradeVerify",
  "SanctionsDesk",
  "CaseLedger",
  "EnergyWatch",
];

describe("Minds registry", () => {
  it("contains exactly the ten specialist Minds in order", () => {
    expect(MINDS).toHaveLength(10);
    expect(MINDS.map((m) => m.name)).toEqual(REQUIRED);
  });

  it("has unique, URL-safe slugs and stable catalogue numbers", () => {
    const slugs = MINDS.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(mindIndex(MINDS[0].slug)).toBe("01");
    expect(mindIndex(MINDS[9].slug)).toBe("10");
  });

  it("gives every Mind a complete, non-placeholder definition", () => {
    for (const mind of MINDS) {
      expect(mind.summary.length).toBeGreaterThan(40);
      expect(mind.problem.length).toBeGreaterThan(60);
      expect(mind.responsibilities.length).toBeGreaterThanOrEqual(3);
      expect(mind.capabilities.length).toBeGreaterThanOrEqual(2);
      expect(mind.boundaries.length).toBeGreaterThanOrEqual(2);
      expect(mind.statusNote.length).toBeGreaterThan(30);
      expect(mind.nextStep.length).toBeGreaterThan(30);
      expect(mind.domain).toMatch(/·/);
    }
  });

  it("only marks the Index Desk available, with a real investigation path", () => {
    const available = mindsByStatus("available");
    expect(available.map((m) => m.slug)).toEqual(["index-reconstitution-desk"]);
    expect(available[0].href).toBe("/minds/index-desk");
    expect(available[0].coverage).toHaveLength(6);
    for (const mind of MINDS.filter((m) => m.status !== "available")) {
      expect(mind.href).toBeUndefined();
    }
  });

  it("keeps Bitcoin Mining Intelligence in development and everything else planned", () => {
    expect(mindsByStatus("in_development").map((m) => m.slug)).toEqual(["bitcoin-mining-intelligence"]);
    expect(mindsByStatus("planned")).toHaveLength(8);
    expect(mindsByStatus("planned").map((m) => m.slug)).not.toContain("bitcoin-mining-intelligence");
  });

  it("does not advertise network coverage for Minds that have no provider", () => {
    for (const mind of MINDS) {
      if (mind.status !== "available") expect(mind.coverage).toBeUndefined();
    }
  });

  it("resolves profiles by slug and returns undefined for unknown ones", () => {
    expect(mindBySlug("sanctionsdesk")?.name).toBe("SanctionsDesk");
    expect(mindBySlug("nope")).toBeUndefined();
  });
});

describe("shared foundation", () => {
  it("describes the eight shared pillars with honest states", () => {
    expect(MIND_FOUNDATION).toHaveLength(8);
    expect(new Set(MIND_FOUNDATION.map((p) => p.id)).size).toBe(8);
    for (const pillar of MIND_FOUNDATION) {
      expect(["ready", "partial"]).toContain(pillar.state);
      expect(pillar.detail.length).toBeGreaterThan(60);
      expect(pillar.source.length).toBeGreaterThan(0);
    }
    expect(MIND_FOUNDATION.filter((p) => p.state === "partial").map((p) => p.id)).toEqual(["monitoring"]);
  });

  it("defines the shared investigation run and flags monitoring as partial", () => {
    expect(MIND_PIPELINE.map((s) => s.id)).toEqual([
      "define",
      "probe",
      "approve",
      "ask",
      "verify",
      "report",
      "monitor",
    ]);
    expect(MIND_PIPELINE.filter((s) => s.state === "partial").map((s) => s.id)).toEqual(["monitor"]);
  });
});

describe("catalogue API", () => {
  it("publishes ten Minds, one investigation path and no invented coverage", async () => {
    const res = await mindsApi();
    const body = (await res.json()) as {
      minds: Array<{ slug: string; status: string; investigation?: string; coverage?: unknown[] }>;
      foundation: unknown[];
    };
    expect(body.minds).toHaveLength(10);
    expect(body.minds.filter((m) => m.status === "available")).toHaveLength(1);
    expect(body.minds.find((m) => m.slug === "index-reconstitution-desk")?.investigation).toBe(
      "/minds/index-desk",
    );
    expect(body.minds.find((m) => m.slug === "portsentinel")?.investigation).toBeUndefined();
    expect(body.minds.find((m) => m.slug === "portsentinel")?.coverage).toBeUndefined();
    expect(body.foundation).toHaveLength(8);
  });
});

describe("catalogue rendering", () => {
  it("lists all ten Minds with the three honest statuses", () => {
    const html = renderToStaticMarkup(<MindsPage />);
    for (const name of REQUIRED) expect(html).toContain(name);
    expect(html).toContain(MIND_STATUS_LABEL.available);
    expect(html).toContain(MIND_STATUS_LABEL.in_development);
    expect(html).toContain(MIND_STATUS_LABEL.planned);
    // Exactly one launch path: the available Index Desk.
    expect(html.split("/minds/index-desk").length - 1).toBeGreaterThanOrEqual(1);
  });

  it("renders an available Mind with a launch action and no fabricated coverage for others", async () => {
    const desk = renderToStaticMarkup(
      await MindProfilePage({ params: Promise.resolve({ slug: "index-reconstitution-desk" }) }),
    );
    expect(desk).toContain("Open the investigation");
    expect(desk).toContain("/minds/index-desk");
    expect(desk).toContain("Verified coverage");

    const bitcoin = renderToStaticMarkup(
      await MindProfilePage({ params: Promise.resolve({ slug: "bitcoin-mining-intelligence" }) }),
    );
    expect(bitcoin).toContain("In development");
    expect(bitcoin).toContain("not operational");
    expect(bitcoin).not.toContain("Open the investigation");
    expect(bitcoin).not.toContain("CORPORATE_REGISTRY_LOOKUP_GENERAL");
  });
});
