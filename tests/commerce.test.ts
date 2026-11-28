/**
 * Agent Commerce — the four Buyer Desk capabilities and their internal rail.
 *
 * Pinned here:
 *  - the intro catalog's boundaries: four $0.01 offerings, one per section,
 *    and the published ACP listings untouched (ids, names, prices);
 *  - the marketplace board: publish → match → offer → accept → coordination
 *    workflow, with owner guards and honest offer history;
 *  - capacity listings: matrix verification flags unresolvable keys instead of
 *    dropping them, and only the provider reprices/pauses/retires;
 *  - workflows: desk steps open REAL Deal Desk files and run FREE pre-flights
 *    (runTask stubbed — no network, no spend); the completed run absorbs into
 *    the file and the desk's own free report gives the step its verdict;
 *  - reseller packages: positive margin enforced at create and update;
 *  - the internal purchase rail fulfills all four offerings without ever
 *    requesting a wallet signature, and records refused purchases as failed
 *    jobs with their reason instead of dropping them.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/engine/engine", async (importOriginal) => {
  // The real module stays (createTask, defaultDeps, EngineError are live);
  // only runTask is stubbed so a free pre-flight never probes the network.
  const actual = await importOriginal<typeof import("@/lib/engine/engine")>();
  return { ...actual, runTask: vi.fn(async () => undefined) };
});

import { ACP_OFFERINGS } from "@/lib/acp/offerings";
import { COMMERCE_OFFERINGS, INTRO_PRICE_USD_CENTS, commerceOfferingById, validateCommerceInput } from "@/lib/commerce/catalog";
import {
  acceptOffer,
  addWorkflowStep,
  closeRequirement,
  createPackage,
  createRequirement,
  createService,
  createWorkflow,
  fulfillCommercePurchase,
  offerOnRequirement,
  reviewRequirementDelivery,
  submitRequirementDelivery,
  retirePackage,
  retireService,
  runWorkflowStep,
  syncWorkflowSteps,
  updatePackage,
  updateService,
} from "@/lib/commerce/fulfill";
import {
  getDeskInvestigation,
} from "@/lib/desk/store";
import { getPackage, getRequirement, getService, getWorkflow, listCommerceJobs, listRequirements, listServices, listWorkflows } from "@/lib/commerce/store";
import { getTask, saveTask } from "@/lib/engine/store";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccccc";
const D = "0xdddddddddddddddddddddddddddddddddddddddddd";

const MARKET = COMMERCE_OFFERINGS.find((o) => o.section === "marketplace")!;

describe("the intro catalog keeps its boundaries", () => {
  it("exposes exactly four $0.01 offerings, one per section", () => {
    expect(COMMERCE_OFFERINGS).toHaveLength(4);
    const sections = COMMERCE_OFFERINGS.map((o) => o.section).sort();
    expect(sections).toEqual(["capacity", "marketplace", "reseller", "workflows"]);
    for (const o of COMMERCE_OFFERINGS) {
      expect(o.priceUsdCents).toBe(INTRO_PRICE_USD_CENTS);
      expect(o.priceUsdCents).toBe(1);
      expect(o.id.startsWith("commerce_")).toBe(true);
      expect(o.deliverable.length).toBeGreaterThan(20);
    }
    expect(commerceOfferingById("commerce_marketplace")?.section).toBe("marketplace");
    expect(commerceOfferingById("nope")).toBeUndefined();
  });

  it("never touches the published ACP listings", () => {
    expect(ACP_OFFERINGS).toHaveLength(4);
    const byPrice = Object.fromEntries(ACP_OFFERINGS.map((o) => [o.id, o.priceUsdCents]));
    // Repriced to the $0.01 intro price to match the Virtuals dashboard (2026-11).
    expect(byPrice).toEqual({
      "nightshift/counterparty-due-diligence": 1,
      "nightshift/listing-underwriter": 1,
      "nightshift/asset-intelligence": 1,
      "nightshift/trade-supplier-intelligence": 1,
    });
    for (const o of COMMERCE_OFFERINGS) {
      expect(ACP_OFFERINGS.some((a) => a.id === o.id)).toBe(false);
    }
  });

  it("validates purchase inputs like the ACP requirement validator does", () => {
    const empty = validateCommerceInput(MARKET, {});
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("title");

    const badNumber = validateCommerceInput(MARKET, { title: "x", category: "counterparty", detail: "y", budgetUsdCents: "abc" });
    expect(badNumber.ok).toBe(false);
    expect(badNumber.missing).toContain("budgetUsdCents");

    const badSelect = validateCommerceInput(MARKET, { title: "x", category: "not-a-category", detail: "y" });
    expect(badSelect.ok).toBe(false);
    expect(badSelect.missing).toContain("category");
  });
});

describe("marketplace — publish, match, offer, accept", () => {
  it("publishes a requirement and auto-matches services and the published offering", async () => {
    const service = await createService(B, {
      name: "Sanctions screening with citations",
      category: "counterparty",
      summary: "Screens the named controller against sanctions lists and returns source citations.",
      priceUsdCents: 150,
    });
    expect(service.ok).toBe(true);

    const created = await createRequirement(A, {
      title: "Screen a counterparty before first purchase order",
      category: "counterparty",
      detail: "We need sanctions screening evidence for a new supplier before the first PO.",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.reference.startsWith("NS-MP-")).toBe(true);
    expect(created.value.status).toBe("open");
    // Category fit + keyword overlap put B's listing in the matches; the
    // published counterparty offering is surfaced as a reference.
    if (service.ok) expect(created.value.matchedServiceIds).toContain(service.value.id);
    expect(created.value.matchedOfferingIds).toContain("nightshift/counterparty-due-diligence");
    expect((await listRequirements()).some((r) => r.id === created.value.id)).toBe(true);
  });

  it("keeps the board honest: no self-offers, owner-only acceptance, history preserved", async () => {
    const requirements = await listRequirements();
    const requirement = requirements.find((r) => r.ownerWallet === A)!;

    const selfOffer = await offerOnRequirement({
      requirementId: requirement.id,
      providerWallet: A,
      message: "I will do it",
      priceUsdCents: 50,
      serviceId: null,
      offeringRef: "nightshift/counterparty-due-diligence",
    });
    expect(selfOffer.ok).toBe(false);
    if (!selfOffer.ok) expect(selfOffer.error).toContain("your own requirement");

    const offer = await offerOnRequirement({
      requirementId: requirement.id,
      providerWallet: B,
      message: "Sanctions screen with citations within 24h",
      priceUsdCents: 120,
      serviceId: (await listServices()).find((s) => s.providerWallet === B)!.id,
    });
    expect(offer.ok).toBe(true);
    if (offer.ok) {
      expect(offer.value.status).toBe("matched");
      expect(offer.value.offers[0].status).toBe("pending");
    }

    const strangerAccept = await acceptOffer({ requirementId: requirement.id, offerId: requirement.offers[0]?.id ?? "x", ownerWallet: C });
    expect(strangerAccept.ok).toBe(false);
    if (!strangerAccept.ok) expect(strangerAccept.status).toBe(403);

    const accepted = await acceptOffer({ requirementId: requirement.id, offerId: offer.ok ? offer.value.offers[0].id : "", ownerWallet: A });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.requirement.status).toBe("in_progress");
      expect(accepted.value.requirement.acceptedOfferId).toBe(accepted.value.requirement.offers[0].id);
      expect(accepted.value.requirement.offers[0].status).toBe("accepted");
      expect(accepted.value.workflow).not.toBeNull();
      expect(accepted.value.workflow!.steps[0].kind).toBe("coordination");
      expect(accepted.value.workflow!.ownerWallet).toBe(A);
    }
    const lateOffer = await offerOnRequirement({ requirementId: requirement.id, providerWallet: C, message: "I can also do this", priceUsdCents: 100, offeringRef: "nightshift/counterparty-due-diligence" });
    expect(lateOffer.ok).toBe(false);
    if (!lateOffer.ok) expect(lateOffer.status).toBe(409);
    const wrongProvider = await submitRequirementDelivery({ requirementId: requirement.id, providerWallet: C, note: "Completed screening." });
    expect(wrongProvider.ok).toBe(false);
    if (!wrongProvider.ok) expect(wrongProvider.status).toBe(403);
    const submitted = await submitRequirementDelivery({
      requirementId: requirement.id,
      providerWallet: B,
      note: "Screening completed. Findings and source citations are in the report.",
      artifactUrl: "https://example.com/report/NS-MP-test",
    });
    expect(submitted.ok).toBe(true);
    if (submitted.ok) {
      expect(submitted.value.delivery?.status).toBe("submitted");
      expect(submitted.value.status).toBe("in_progress");
    }
    const strangerReview = await reviewRequirementDelivery({ requirementId: requirement.id, ownerWallet: C, decision: "accept" });
    expect(strangerReview.ok).toBe(false);
    if (!strangerReview.ok) expect(strangerReview.status).toBe(403);
    const rejected = await reviewRequirementDelivery({ requirementId: requirement.id, ownerWallet: A, decision: "reject", note: "Please include source dates." });
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value.delivery?.status).toBe("rejected");
    const resubmitted = await submitRequirementDelivery({ requirementId: requirement.id, providerWallet: B, note: "Updated report includes source dates." });
    expect(resubmitted.ok).toBe(true);
    const delivered = await reviewRequirementDelivery({ requirementId: requirement.id, ownerWallet: A, decision: "accept" });
    expect(delivered.ok).toBe(true);
    if (delivered.ok) {
      expect(delivered.value.status).toBe("delivered");
      expect(delivered.value.delivery?.status).toBe("accepted");
    }
    const linkedWorkflow = accepted.ok && accepted.value.workflow ? await getWorkflow(accepted.value.workflow.id) : null;
    expect(linkedWorkflow?.steps[0].status).toBe("done");
    const again = await acceptOffer({ requirementId: requirement.id, offerId: (await getRequirement(requirement.id))!.offers[0].id, ownerWallet: A });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("no longer accepting offer decisions");
  });

  it("closes a requirement for its owner and nobody else", async () => {
    const requirement = (await listRequirements()).find((r) => r.ownerWallet === A && r.status !== "closed")!;
    const stranger = await closeRequirement(requirement.id, B);
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.status).toBe(403);
    const closed = await closeRequirement(requirement.id, A);
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.value.status).toBe("closed");
    expect((await getRequirement(requirement.id))!.status).toBe("closed");
  });
});

describe("capacity — provider listings with matrix verification", () => {
  it("lists a service, flags unresolvable capability keys, and keeps management owner-only", async () => {
    const badCaps = await createService(A, {
      name: "Mystery service",
      category: "other",
      summary: "Claims a capability the matrix does not know.",
      priceUsdCents: 100,
      capabilities: "no-such-mind:no-such-dimension",
    });
    expect(badCaps.ok).toBe(true);
    if (!badCaps.ok) return;
    expect(badCaps.value.verified).toBe(false);
    expect(badCaps.value.notes.join(" ")).toContain("no-such-mind:no-such-dimension");

    const noPrice = await createService(A, { name: "x", category: "other", summary: "y" });
    expect(noPrice.ok).toBe(false);
    if (!noPrice.ok) expect(noPrice.error).toContain("price");

    const strangerUpdate = await updateService({ id: badCaps.value.id, providerWallet: B, availability: "busy" });
    expect(strangerUpdate.ok).toBe(false);
    if (!strangerUpdate.ok) expect(strangerUpdate.status).toBe(403);

    const ownerUpdate = await updateService({ id: badCaps.value.id, providerWallet: A, priceUsdCents: 120, availability: "busy" });
    expect(ownerUpdate.ok).toBe(true);
    if (ownerUpdate.ok) {
      expect(ownerUpdate.value.priceUsdCents).toBe(120);
      expect(ownerUpdate.value.availability).toBe("busy");
    }

    const retired = await retireService(badCaps.value.id, A);
    expect(retired.ok).toBe(true);
    if (retired.ok) {
      expect(retired.value.status).toBe("retired");
      expect(retired.value.availability).toBe("paused");
    }
    // listServices returns the full record set (retired included); the board
    // is what filters on status — so the retired service leaves the directory.
    expect((await listServices()).filter((s) => s.status === "listed").some((s) => s.id === badCaps.value.id)).toBe(false);
    expect((await getService(badCaps.value.id))?.status).toBe("retired");
  });
});

describe("workflows — desk steps ride the real engine, free pre-flights only", () => {
  it("builds a template plan with worked-example subjects and runs step one for free", async () => {
    const created = await createWorkflow({
      ownerWallet: A,
      title: "Onboard supplier ABC",
      goal: "Establish who ABC is and whether the trade documents check out.",
      template: "supplier_onboarding",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.steps).toHaveLength(2);
    expect(created.value.steps.every((s) => s.kind === "desk_investigation")).toBe(true);
    expect(created.value.steps[0].subject?.legalName).toBeTruthy();

    const run = await runWorkflowStep({ id: created.value.id, stepId: created.value.steps[0].id, ownerWallet: A });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const step = run.value.steps[0];
    expect(step.status).toBe("in_progress");
    expect(step.investigationId).toBeTruthy();
    expect(step.taskId).toBeTruthy();
    const file = await getDeskInvestigation(step.investigationId!);
    expect(file?.kind).toBe("desk");
    expect(file?.type).toBe("counterparty_due_diligence");
    expect(file?.owner).toBe(A);
    // Free pre-flight: probes only, zero spend, no approval gate.
    const task = await getTask(step.taskId!);
    expect(task?.permissions.requiresApproval).toBe(false);
    expect(task?.spend.spentUsdCents).toBe(0);

    const stranger = await runWorkflowStep({ id: created.value.id, stepId: created.value.steps[1].id, ownerWallet: B });
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.status).toBe(403);

    const again = await runWorkflowStep({ id: created.value.id, stepId: step.id, ownerWallet: A });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("already running");
  });

  it("absorbs a completed pre-flight and lets the desk's own report give the verdict", async () => {
    const wf = (await listWorkflows()).find((w) => w.title === "Onboard supplier ABC")!;
    const step = wf.steps[0];
    // The pre-flight run finished: complete the task, then sync.
    const task = await getTask(step.taskId!);
    task!.state = "completed";
    await saveTask(task!);
    const synced = await syncWorkflowSteps(wf);
    expect(synced.changed).toBe(true);
    expect(step.status).toBe("done");
    expect(step.result).toContain("Report on");
    const file = await getDeskInvestigation(step.investigationId!);
    expect(file?.report).not.toBeNull();
  });

  it("adds and runs further steps, and closes workflows for their owner", async () => {
    const wf = (await listWorkflows()).find((w) => w.title === "Onboard supplier ABC")!;
    const added = await addWorkflowStep({ id: wf.id, ownerWallet: A, label: "Verify the trade documents", deskType: "trade_supplier_intelligence" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const newStep = added.value.steps[added.value.steps.length - 1];
    expect(newStep.kind).toBe("desk_investigation");
    expect(newStep.subject?.supplierName).toBeTruthy();

    const ran = await runWorkflowStep({ id: wf.id, stepId: newStep.id, ownerWallet: A });
    expect(ran.ok).toBe(true);
    if (ran.ok) {
      const file = await getDeskInvestigation(ran.value.steps[ran.value.steps.length - 1].investigationId!);
      expect(file?.type).toBe("trade_supplier_intelligence");
    }

    const cancelled = await createWorkflow({ ownerWallet: A, title: "Throwaway plan", goal: "Cancelled immediately.", template: "asset_listing_review" });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      const { cancelWorkflow } = await import("@/lib/commerce/fulfill");
      const off = await cancelWorkflow(cancelled.value.id, A);
      expect(off.ok).toBe(true);
      const after = await runWorkflowStep({ id: cancelled.value.id, stepId: cancelled.value.steps[0].id, ownerWallet: A });
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.error).toContain("closed");
    }
  });
});

describe("reseller — packages are priced from real Capacity listings", () => {
  it("rejects invented component prices and enforces margin against live source prices", async () => {
    const first = await createService(B, { name: "Counterparty DD", category: "counterparty", summary: "Registry and sanctions review.", priceUsdCents: 200 });
    const second = await createService(C, { name: "VAT identity check", category: "trade_supplier", summary: "VAT registration verification.", priceUsdCents: 100 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const components = `capacity:${first.value.reference}\ncapacity:${second.value.reference}`;

    const forged = await createPackage({ ownerWallet: A, name: "Forged bundle", summary: "Caller-supplied prices are not accepted.", components: "Counterparty DD | 1\nVAT identity check | 1", packagePriceUsdCents: 500 });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.error).toContain("capacity:<service-reference>");

    const tooLow = await createPackage({ ownerWallet: A, name: "Supplier starter", summary: "Two verified Capacity listings.", components, packagePriceUsdCents: 250 });
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.error).toContain("standalone sum");

    const listed = await createPackage({ ownerWallet: A, name: "Supplier starter", summary: "Two verified Capacity listings.", components, packagePriceUsdCents: 400 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.marginUsdCents).toBe(100);
    expect(listed.value.components.map((c) => c.unitPriceUsdCents)).toEqual([200, 100]);
    expect(listed.value.components.every((c) => c.ref)).toBe(true);

    const blockedReprice = await updateService({ id: first.value.id, providerWallet: B, priceUsdCents: 300 });
    expect(blockedReprice.ok).toBe(false);
    if (!blockedReprice.ok) expect(blockedReprice.status).toBe(409);
    const blockedRetire = await retireService(first.value.id, B);
    expect(blockedRetire.ok).toBe(false);
    if (!blockedRetire.ok) expect(blockedRetire.status).toBe(409);

    const belowAgain = await updatePackage({ id: listed.value.id, ownerWallet: A, packagePriceUsdCents: 300 });
    expect(belowAgain.ok).toBe(false);
    const above = await updatePackage({ id: listed.value.id, ownerWallet: A, packagePriceUsdCents: 500 });
    expect(above.ok).toBe(true);
    if (above.ok) expect(above.value.marginUsdCents).toBe(200);

    const strangerRetire = await retirePackage(listed.value.id, B);
    expect(strangerRetire.ok).toBe(false);
    if (!strangerRetire.ok) expect(strangerRetire.status).toBe(403);
    expect((await getPackage(listed.value.id))!.status).toBe("listed");
    const retired = await retirePackage(listed.value.id, A);
    expect(retired.ok).toBe(true);
    const providerCanNowReprice = await updateService({ id: first.value.id, providerWallet: B, priceUsdCents: 300 });
    expect(providerCanNowReprice.ok).toBe(true);
  });
});
describe("the internal purchase rail fulfills the four offerings", () => {
  it("fulfills a marketplace purchase into a live, matched requirement — settled internally", async () => {
    const result = await fulfillCommercePurchase({
      offeringId: "commerce_marketplace",
      buyerWallet: D,
      input: {
        title: "Underwrite a token listing",
        category: "listing",
        detail: "We need listing underwriting for a new token before we list it.",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.settled).toBe(true);
    expect(result.value.rail).toBe("internal_credit");
    expect(result.value.priceUsdCents).toBe(1);
    expect(result.value.status).toBe("fulfilled");
    expect(result.value.deliverable?.artifactReference?.startsWith("NS-MP-")).toBe(true);
    expect(result.value.deliverable?.detail).toContain("live on the board");
    expect(result.value.settlementNote).toContain("No wallet signature");
  });

  it("fulfills a capacity purchase into a listed service", async () => {
    const result = await fulfillCommercePurchase({
      offeringId: "commerce_capacity",
      buyerWallet: D,
      input: { name: "Token holder analysis", category: "listing", summary: "Holder distribution with cited sources.", priceUsdCents: 180 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const service = await getService(result.value.deliverable!.artifactId!);
    expect(service?.status).toBe("listed");
    expect(service?.providerWallet).toBe(D);
  });

  it("fulfills a workflows purchase into an executable workflow with its first pre-flight already running", async () => {
    const result = await fulfillCommercePurchase({
      offeringId: "commerce_workflows",
      buyerWallet: D,
      input: { title: "Review an asset listing", goal: "Establish the asset's supply and issuer claims.", template: "asset_listing_review" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wf = await getWorkflow(result.value.deliverable!.artifactId!);
    expect(wf?.steps).toHaveLength(2);
    expect(wf?.steps[0].status).toBe("in_progress");
    const file = await getDeskInvestigation(wf!.steps[0].investigationId!);
    expect(file?.owner).toBe(D);
  });

  it("records a refused purchase as a failed job with its reason — never silently dropped", async () => {
    const componentService = await createService(A, {
      name: "Counterparty DD",
      category: "counterparty",
      summary: "Registry and sanctions review.",
      priceUsdCents: 200,
    });
    expect(componentService.ok).toBe(true);
    if (!componentService.ok) return;
    const refused = await fulfillCommercePurchase({
      offeringId: "commerce_reseller",
      buyerWallet: D,
      input: { name: "Bad bundle", summary: "Priced below its parts.", components: `capacity:${componentService.value.reference}`, packagePriceUsdCents: 150 },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("worth more than its parts");
    const failed = (await listCommerceJobs(D)).find((j) => j.status === "failed");
    expect(failed?.settlementNote).toContain("refused");

    const unknown = await fulfillCommercePurchase({ offeringId: "commerce_nope", buyerWallet: D, input: {} });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("unknown commerce offering");

    const missing = await fulfillCommercePurchase({ offeringId: "commerce_marketplace", buyerWallet: D, input: {} });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("missing or invalid input");
  });
});
