import { readFileSync, existsSync } from "node:fs";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 1 — restore the work architecture: Assurance is an independent
 * workspace again, Deal Desk carries only its own four workflows, and every
 * legacy link keeps landing on the right record.
 *
 * These tests pin the routing contract itself (which page renders which
 * component, which id resolves where) and the navigation contract (one shared
 * nav definition, five primary destinations, Network secondary).
 */

const { redirectMock, notFoundMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(),
  notFoundMock: vi.fn(),
}));

// Mirror Next's own behaviour: redirect()/notFound() abort rendering by
// throwing, so a page that "keeps rendering after a redirect" cannot hide.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectMock(url);
    const err = new Error(`NEXT_REDIRECT ${url}`) as Error & { digest?: string };
    err.digest = `NEXT_REDIRECT;replace;${url};`;
    throw err;
  },
  notFound: () => {
    notFoundMock();
    const err = new Error("NEXT_NOT_FOUND") as Error & { digest?: string };
    err.digest = "NEXT_NOT_FOUND";
    throw err;
  },
}));

const { getDeskInvestigationMock, getAssuranceInvestigationMock } = vi.hoisted(() => ({
  getDeskInvestigationMock: vi.fn(),
  getAssuranceInvestigationMock: vi.fn(),
}));

vi.mock("@/lib/desk/store", () => ({
  getDeskInvestigation: getDeskInvestigationMock,
}));
vi.mock("@/lib/assurance/store", () => ({
  getInvestigation: getAssuranceInvestigationMock,
}));

const { DeskWorkspaceStub, AssuranceIndexStub, AssuranceWorkspaceStub, DeskEntryStub } = vi.hoisted(() => ({
  DeskWorkspaceStub: vi.fn(() => null),
  AssuranceIndexStub: vi.fn(() => null),
  AssuranceWorkspaceStub: vi.fn(() => null),
  DeskEntryStub: vi.fn(() => null),
}));

vi.mock("@/components/desk/desk-workspace", () => ({ DeskWorkspace: DeskWorkspaceStub }));
vi.mock("@/components/assurance/assurance-index", () => ({ AssuranceIndex: AssuranceIndexStub }));
vi.mock("@/components/assurance/assurance-workspace", () => ({ AssuranceWorkspace: AssuranceWorkspaceStub }));
vi.mock("@/components/desk/desk-entry", () => ({ DeskEntry: DeskEntryStub }));

function src(path: string): string {
  return readFileSync(path, "utf8");
}

const RESOLVER_ID = "9f1c3a20-4b7e-4c1a-9f21-000000000001";

async function renderPage(mod: { default: (props: { params: Promise<{ id: string }> }) => Promise<unknown> | unknown }, id: string): Promise<unknown> {
  return await mod.default({ params: Promise.resolve({ id }) });
}

beforeEach(() => {
  redirectMock.mockClear();
  notFoundMock.mockClear();
  DeskWorkspaceStub.mockClear();
  AssuranceIndexStub.mockClear();
  AssuranceWorkspaceStub.mockClear();
  DeskEntryStub.mockClear();
  // Store mocks carry queued once-implementations across tests; a page that
  // short-circuits (a failed desk read never reaches the assurance read)
  // would otherwise leak a rejection into the next test's read.
  getDeskInvestigationMock.mockReset();
  getAssuranceInvestigationMock.mockReset();
});

describe("Assurance is an independent workspace again", () => {
  it("/assurance renders the original AssuranceIndex", async () => {
    const mod = await import("@/app/(explorer)/assurance/page");
    const element = mod.default() as { type: unknown };
    expect(element.type).toBe(AssuranceIndexStub);
    // Not a redirect page anymore.
    expect(src("src/app/(explorer)/assurance/page.tsx")).not.toContain('redirect("/desk")');
  });

  it("/assurance/:id renders the original AssuranceWorkspace with the id", async () => {
    const mod = await import("@/app/(explorer)/assurance/[id]/page");
    const element = (await renderPage(mod, RESOLVER_ID)) as { type: unknown; props: { investigationId: string } };
    expect(element.type).toBe(AssuranceWorkspaceStub);
    expect(element.props.investigationId).toBe(RESOLVER_ID);
  });
});

describe("Deal Desk carries only its own four workflows", () => {
  it("/desk renders DeskEntry and no longer embeds the AssuranceIndex", async () => {
    const mod = await import("@/app/(explorer)/desk/page");
    const element = mod.default() as { type: unknown; props: { workflows: unknown[] } };
    expect(element.type).toBe(DeskEntryStub);
    expect(element.props.workflows.length).toBeGreaterThan(0);
    const source = src("src/app/(explorer)/desk/page.tsx");
    expect(source).not.toContain("AssuranceIndex");
    expect(source).toContain("DeskEntry");
    // All four workflows stay listed on the page.
    expect(source).toContain("DESK_TYPE_ORDER");
  });
});

describe("/desk/:id resolves by the stored record type, not the id prefix", () => {
  it("opens a Deal Desk investigation in the DeskWorkspace", async () => {
    getDeskInvestigationMock.mockResolvedValueOnce({ id: RESOLVER_ID, kind: "desk" });
    const mod = await import("@/app/(explorer)/desk/[id]/page");
    const element = (await renderPage(mod, RESOLVER_ID)) as { type: unknown; props: { investigationId: string } };
    expect(element.type).toBe(DeskWorkspaceStub);
    expect(element.props.investigationId).toBe(RESOLVER_ID);
    expect(redirectMock).not.toHaveBeenCalled();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("redirects an Assurance settlement file to /assurance/:id", async () => {
    getDeskInvestigationMock.mockResolvedValueOnce(null);
    getAssuranceInvestigationMock.mockResolvedValueOnce({ id: RESOLVER_ID });
    const mod = await import("@/app/(explorer)/desk/[id]/page");
    await expect(renderPage(mod, RESOLVER_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectMock).toHaveBeenCalledWith(`/assurance/${RESOLVER_ID}`);
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("returns 404 only when the id exists in neither store", async () => {
    getDeskInvestigationMock.mockResolvedValueOnce(null);
    getAssuranceInvestigationMock.mockResolvedValueOnce(null);
    const mod = await import("@/app/(explorer)/desk/[id]/page");
    await expect(renderPage(mod, RESOLVER_ID)).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(notFoundMock).toHaveBeenCalledOnce();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("verifies the actual stored record kind (a store failure is not a redirect)", async () => {
    // A desk-store outage must never reinterpret an unknown id as Assurance.
    // It must also never 404: a record that EXISTS must not be reported as
    // missing because the store was slow — the page renders an honest retry
    // state instead (the production desk page hung 30s+ on the cold-start
    // database path and then died; the bounded read now answers with a
    // failure state, and only a VERIFIED null is a 404).
    getDeskInvestigationMock.mockRejectedValueOnce(new Error("storage unavailable"));
    getAssuranceInvestigationMock.mockRejectedValueOnce(new Error("storage unavailable"));
    const mod = await import("@/app/(explorer)/desk/[id]/page");
    await expect(renderPage(mod, RESOLVER_ID)).resolves.not.toThrow();
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("a verified-null in both stores is still a 404", async () => {
    getDeskInvestigationMock.mockResolvedValueOnce(null);
    getAssuranceInvestigationMock.mockResolvedValueOnce(null);
    const mod = await import("@/app/(explorer)/desk/[id]/page");
    await expect(renderPage(mod, RESOLVER_ID)).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});

describe("legacy link compatibility", () => {
  it("/desk/i/:id redirects to the canonical /desk/:id, preserving the id", () => {
    const config = src("next.config.ts");
    const compat = config.match(/\{[^{}]*source: "\/desk\/i\/:id"[^{}]*\}/)?.[0] ?? "";
    expect(compat).toContain('destination: "/desk/:id"');
    // The page is retired behind the redirect; nothing shadows it.
    expect(existsSync("src/app/(explorer)/desk/i")).toBe(false);
  });

  it("/tasks/:id keeps the id: next.config redirects to /activity/:id", () => {
    const config = src("next.config.ts");
    const taskRedirect = config.match(/\{[^{}]*source: "\/tasks\/:id"[^{}]*\}/)?.[0] ?? "";
    expect(taskRedirect).toContain('destination: "/activity/:id"');
    // The redirect must never drop the id again.
    expect(taskRedirect).not.toContain('destination: "/activity"');
    // The pre-pivot page is retired behind the redirect; nothing shadows it.
    expect(existsSync("src/app/(console)/tasks")).toBe(false);
  });

  it("the activity detail page no longer links back through /tasks/", () => {
    expect(src("src/app/(explorer)/activity/[id]/page.tsx")).not.toContain("/tasks/");
  });
});

describe("navigation: five primary destinations, Network secondary, one shared contract", () => {
  it("the shared nav contract lists exactly the five primary destinations", async () => {
    const { PRIMARY_NAV, SECONDARY_NAV } = await import("@/lib/explorer/nav");
    expect(PRIMARY_NAV.map((i: { label: string }) => i.label)).toEqual([
      "Overview",
      "Minds",
      "Investigations",
      "Buyer Desk",
      "Wallet",
    ]);
    expect(PRIMARY_NAV.map((i: { href: string }) => i.href)).toEqual([
      "/overview",
      "/minds",
      "/investigations",
      "/buyer",
      "/funds",
    ]);
    // Overview is its own destination, not the landing page.
    expect(PRIMARY_NAV[0].href).not.toBe("/");
    // Investigations exposes both clearly distinct workspaces.
    const investigations = PRIMARY_NAV.find((i: { label: string }) => i.label === "Investigations");
    expect(investigations?.activeFor).toEqual(expect.arrayContaining(["/investigations", "/desk", "/assurance"]));
    // Network is a secondary destination, not a primary tab, and it lands in
    // the Minds section that holds the family.
    expect(PRIMARY_NAV.some((i: { label: string }) => i.label === "Network")).toBe(false);
    expect(SECONDARY_NAV.map((i: { label: string }) => i.label)).toEqual(["Network"]);
    expect(SECONDARY_NAV[0].href).toBe("/minds#network");
    expect(SECONDARY_NAV[0].activeFor).toEqual(
      expect.arrayContaining(["/miners", "/intents", "/validators", "/evaluators", "/signals", "/developers"]),
    );
    // Activity is the user's own record history (it belongs to the Wallet's
    // transactions surface), not a network directory.
    expect(SECONDARY_NAV[0].activeFor).not.toContain("/activity");
  });

  it("the Network family section under Minds carries all six directories", async () => {
    const { NETWORK_DIRECTORIES } = await import("@/lib/explorer/nav");
    expect(NETWORK_DIRECTORIES.map((d: { href: string }) => d.href)).toEqual([
      "/miners",
      "/intents",
      "/validators",
      "/evaluators",
      "/signals",
      "/developers",
    ]);
    expect(NETWORK_DIRECTORIES.map((d: { label: string }) => d.label)).toEqual([
      "Miners",
      "Intents",
      "Validators",
      "Evaluators",
      "Signals",
      "Developers",
    ]);
    const minds = src("src/app/(explorer)/minds/page.tsx");
    expect(minds).toContain('id="network"');
    expect(minds).toContain("NETWORK_DIRECTORIES");
    // The directories are one clearly marked section, not scattered cards.
    expect(minds).toContain('aria-label="The Telegraph network"');
  });

  it("the desktop header and the mobile tab bar consume the shared contract, not their own lists", () => {
    const header = src("src/components/explorer/explorer-header.tsx");
    const bar = src("src/components/explorer/mobile-tab-bar.tsx");
    expect(header).toContain("from \"@/lib/explorer/nav\"");
    expect(header).toContain("PRIMARY_NAV");
    expect(header).toContain("SECONDARY_NAV");
    expect(header).not.toMatch(/const AREAS/);
    expect(bar).toContain("from \"@/lib/explorer/nav\"");
    expect(bar).toContain("PRIMARY_NAV");
    expect(bar).not.toMatch(/const ITEMS: Item\[\]/);
    // The secondary link renders in the header's right cluster, outside the primary row.
    expect(header).toMatch(/aria-label="Secondary"|SECONDARY_NAV\.map/);
  });

  it("the Investigations hub exposes Deal Desk and Assurance as distinct workspaces", () => {
    const hub = src("src/app/(explorer)/investigations/page.tsx");
    expect(hub).toContain('href="/desk"');
    expect(hub).toContain('href="/assurance"');
    expect(hub).toContain("Deal Desk");
    expect(hub).toContain("Assurance");
    // Navigation architecture only — no workspace is reimplemented here, and
    // the two complete product interfaces are not stacked on the hub.
    expect(hub).not.toContain("AssuranceIndex");
    expect(hub).not.toContain("DeskEntry");
    // The old /work page is retired; the route survives as a redirect.
    expect(existsSync("src/app/(explorer)/work")).toBe(false);
    const config = src("next.config.ts");
    const workRedirect = config.match(/\{[^{}]*source: "\/work"[^{}]*\}/)?.[0] ?? "";
    expect(workRedirect).toContain('destination: "/investigations"');
  });

  it("Overview is its own page showing records, not navigation", () => {
    const overview = src("src/app/(explorer)/overview/page.tsx");
    // No navbar destination re-listed as shortcut cards, no wallet card, no
    // Minds or Network directory — the primary tabs appear exactly once.
    for (const href of ["/minds", "/buyer", "/funds", "/miners", "/signals", "/developers"]) {
      expect(overview).not.toContain(`href: "${href}"`);
    }
    expect(overview).not.toContain("WalletCard");
    expect(overview).not.toContain("PayerCard");
    expect(overview).not.toContain("mindsByStatus");
    // It reads the real stores through the SAME caller projections the APIs
    // use — never more than this caller may see, never fabricated rows.
    expect(overview).toContain("listTasks");
    expect(overview).toContain("listDeskInvestigations");
    expect(overview).toContain("listInvestigations");
    expect(overview).toContain("tasksForCaller");
    expect(overview).toContain("investigationsForCaller");
    // Every store read runs under a deadline: a stalled read degrades the page
    // to an honest partial view — it can never hang the RSC stream again.
    expect(overview).toContain("readBounded");
    expect(overview).toContain('dynamic = "force-dynamic"');
    // The stale pre-pivot redirect no longer shadows the page.
    const config = src("next.config.ts");
    expect(config).not.toContain('source: "/overview"');
    expect(src("src/app/sitemap.ts")).toContain('path: "/overview"');
    expect(src("src/app/sitemap.ts")).toContain('path: "/investigations"');
  });
});

describe("assurance error handling and case navigation moved to /assurance", () => {
  it("the Assurance workspace never surfaces a raw err.message and links back to /assurance", () => {
    const workspace = src("src/components/assurance/assurance-workspace.tsx");
    expect(workspace).not.toMatch(/err instanceof Error \? err\.message/);
    expect(workspace).toContain("friendlyNetworkError(err)");
    expect(workspace).toContain('href="/assurance"');
    expect(workspace).not.toContain('href="/desk"');
  });

  it("Assurance case navigation (create + list rows) goes to /assurance/:id", () => {
    const index = src("src/components/assurance/assurance-index.tsx");
    expect(index).toContain("router.push(`/assurance/${body.investigation.id}`)");
    expect(index).toContain("href={`/assurance/${row.id}`}");
    expect(index).not.toContain("`/desk/");
  });

  it("Deal Desk creation and investigation rows use the canonical /desk/:id", () => {
    expect(src("src/components/desk/desk-form.tsx")).toContain("router.push(`/desk/${body.investigation.id}`)");
    expect(src("src/components/desk/desk-entry.tsx")).toContain("href={`/desk/${row.id}`}");
    expect(src("src/components/acp.tsx")).toContain("href={`/desk/${j.investigationId}`}");
  });

  it("the Investigations hub is discoverable: the sitemap lists it, /work is gone", () => {
    expect(src("src/app/sitemap.ts")).toContain('path: "/investigations"');
    expect(src("src/app/sitemap.ts")).not.toContain('path: "/work"');
  });
});
