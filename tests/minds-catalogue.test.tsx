import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MINDS, MIND_STATUS_LABEL, mindBySlug, mindIndex, mindsByStatus } from "@/lib/minds/registry";
import { MIND_FOUNDATION, MIND_PIPELINE } from "@/lib/minds/foundation";
import { CAPABILITIES, readinessFor } from "@/lib/minds/capabilities";
import MindsPage from "@/app/(explorer)/minds/page";
import MindProfilePage from "@/app/(explorer)/minds/[slug]/page";
import { GET as mindsApi } from "@/app/api/minds/route";

const REQUIRED = [
  "Bitcoin Mining Intelligence",
  "Index Reconstitution Desk",
  "Counterparty Intelligence",
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
  it("contains all eleven specialists in catalogue order", () => {
    expect(MINDS).toHaveLength(11);
    expect(MINDS.map((m) => m.name)).toEqual(REQUIRED);
  });

  it("has unique, URL-safe slugs and stable catalogue numbers", () => {
    const slugs = MINDS.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(mindIndex(MINDS[0].slug)).toBe("01");
    expect(mindIndex(MINDS[10].slug)).toBe("11");
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

  it("marks every Mind with a working run path available; the trio keeps bespoke routes", () => {
    const available = mindsByStatus("available");
    expect(available.map((m) => m.slug)).toEqual([
      "bitcoin-mining-intelligence",
      "index-reconstitution-desk",
      "counterparty-intelligence",
      "portsentinel",
      "minewatch",
      "chainforensics",
      "ownershipgraph",
      "tradeverify",
      "sanctionsdesk",
      "caseledger",
      "energywatch",
    ]);
    // Bespoke investigation routes.
    expect(available.find((m) => m.slug === "bitcoin-mining-intelligence")?.href).toBe("/minds/bitcoin-mining");
    expect(available.find((m) => m.slug === "index-reconstitution-desk")?.href).toBe("/minds/index-desk");
    expect(available.find((m) => m.slug === "counterparty-intelligence")?.href).toBe("/minds/counterparty");
    // The rest run on their own profile page: no bespoke href, but at least one
    // routable dimension for the shared capability console to execute.
    for (const mind of available.filter((m) => !m.href)) {
      const dims = CAPABILITIES[mind.slug]?.dimensions ?? [];
      expect(dims.some((d) => d.status !== "gap")).toBe(true);
    }
    for (const mind of MINDS) {
      expect(readinessFor(mind.slug, mind.status)).toBe("operational");
    }
  });

  it("leaves nothing in development or planned; every Mind keeps named boundaries", () => {
    expect(mindsByStatus("planned")).toHaveLength(0);
    expect(mindsByStatus("in_development")).toHaveLength(0);
    for (const mind of MINDS) {
      expect(mind.boundaries.length).toBeGreaterThanOrEqual(2);
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
  it("publishes every Mind, its real investigation path and no invented coverage", async () => {
    const res = await mindsApi();
    const body = (await res.json()) as {
      minds: Array<{
        slug: string;
        status: string;
        readiness: string;
        investigation?: string;
        dimensions: Array<{ status: string; missingReason?: string }>;
        counts: { verified: number; partial: number; gaps: number };
      }>;
      foundation: unknown[];
    };
    expect(body.minds).toHaveLength(11);
    expect(body.minds.filter((m) => m.status === "available")).toHaveLength(11);
    expect(body.minds.find((m) => m.slug === "index-reconstitution-desk")?.investigation).toBe(
      "/minds/index-desk",
    );
    expect(body.minds.find((m) => m.slug === "counterparty-intelligence")?.investigation).toBe(
      "/minds/counterparty",
    );
    const ports = body.minds.find((m) => m.slug === "portsentinel");
    expect(ports?.investigation).toBeUndefined();
    expect(ports?.readiness).toBe("operational");
    expect(ports?.counts.verified).toBeGreaterThan(0);
    expect(ports?.counts.gaps).toBeGreaterThan(0);
    expect(body.minds.find((m) => m.slug === "bitcoin-mining-intelligence")?.investigation).toBe(
      "/minds/bitcoin-mining",
    );
    for (const m of body.minds) {
      expect(m.dimensions.length).toBeGreaterThan(0);
      for (const d of m.dimensions) {
        if (d.status === "gap") expect(d.missingReason).toBeTruthy();
      }
    }
    expect(body.foundation).toHaveLength(8);
  });
});

describe("catalogue rendering", () => {
  it("lists all eleven Minds as available without promoting coverage to a launch path", () => {
    const html = renderToStaticMarkup(<MindsPage />);
    for (const name of REQUIRED) expect(html).toContain(name);
    expect(html).toContain(MIND_STATUS_LABEL.available);
    expect(html).toContain("11 available");
    expect(html).not.toContain(MIND_STATUS_LABEL.in_development);
    expect(html.split("/minds/index-desk").length - 1).toBeGreaterThanOrEqual(1);
    // Counterparty is a catalogue card, not a footnote.
    expect(html).toContain("Counterparty Intelligence");
    expect(html).not.toContain("Also live");
  });

  it("renders a console Mind with the run surface and collapsed coverage", async () => {
    const port = renderToStaticMarkup(await MindProfilePage({ params: Promise.resolve({ slug: "portsentinel" }) }));
    expect(port).toContain("Available");
    expect(port).toContain("Run an investigation");
    // The sample fill is the little inline wand at the bottom of the inputs,
    // not a filled button (the old "Fill with sample values" button is gone).
    expect(port).toContain("Fill sample values");
    expect(port).not.toContain("Fill with sample values");
    expect(port).toContain("Coverage detail");
    expect(port).toContain("LIVE_PORT_CONGESTION_GENERAL"); // intent codes live in the collapsed detail
    expect(port).not.toContain("in development");
  });

  it("renders an available Mind with a launch action and no fabricated coverage for others", async () => {
    const desk = renderToStaticMarkup(
      await MindProfilePage({ params: Promise.resolve({ slug: "index-reconstitution-desk" }) }),
    );
    expect(desk).toContain("Open the investigation");
    expect(desk).toContain("/minds/index-desk");

    const bitcoin = renderToStaticMarkup(
      await MindProfilePage({ params: Promise.resolve({ slug: "bitcoin-mining-intelligence" }) }),
    );
    expect(bitcoin).toContain("Available");
    expect(bitcoin).toContain("Open the investigation");
    expect(bitcoin).toContain("/minds/bitcoin-mining");
    expect(bitcoin).toContain("Hashprice and network hashrate");
    expect(bitcoin).toContain("Pool concentration");
    expect(bitcoin).not.toContain("CORPORATE_REGISTRY_LOOKUP_GENERAL");

    const counterparty = renderToStaticMarkup(
      await MindProfilePage({ params: Promise.resolve({ slug: "counterparty-intelligence" }) }),
    );
    expect(counterparty).toContain("Open the investigation");
    expect(counterparty).toContain("/minds/counterparty");
  });
});
