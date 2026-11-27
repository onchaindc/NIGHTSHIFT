/**
 * Agent Commerce persistence — the four Buyer Desk sections (Marketplace,
 * Capacity, Workflows, Reseller) and the internal purchase rail, through the
 * same swappable named-document store as ACP jobs and desk files:
 *
 *   commerce-marketplace-index / commerce-req-<id>    — buyer requirements
 *   commerce-capacity-index   / commerce-cap-<id>     — provider service listings
 *   commerce-workflows-index  / commerce-wf-<id>      — multi-agent workflows
 *   commerce-reseller-index   / commerce-pkg-<id>     — reseller packages
 *   commerce-jobs-<wallet>    / commerce-job-<id>     — intro purchases (internal rail)
 *
 * Same pool discipline as the desk: every list read is ONE bulk readManyNamed
 * over the index — a per-id fan-out through the shared two-connection pool is
 * a documented production hang class. Document names are load-bearing: they
 * are the address space of existing records, so they must never be renamed.
 */

import { randomUUID } from "node:crypto";

import { persistence } from "@/lib/storage";
import type {
  CapacityService,
  CommerceJob,
  CommerceWorkflow,
  MarketplaceRequirement,
  ResellerPackage,
} from "./types";

const MARKETPLACE_INDEX = "commerce-marketplace-index";
const CAPACITY_INDEX = "commerce-capacity-index";
const WORKFLOWS_INDEX = "commerce-workflows-index";
const RESELLER_INDEX = "commerce-reseller-index";

function jobsIndexName(wallet: string): string {
  return `commerce-jobs-${wallet.toLowerCase()}`;
}

/* ---------------- generic index helpers ---------------- */

async function readIndex(name: string): Promise<string[]> {
  const stored = await persistence().readNamed<string[]>(name);
  return Array.isArray(stored) ? stored.filter((v) => typeof v === "string") : [];
}

async function appendIndex(name: string, id: string): Promise<void> {
  const ids = await readIndex(name);
  if (!ids.includes(id)) {
    ids.push(id);
    await persistence().writeNamed(name, ids);
  }
}

/** One bulk read over the index, then a type guard — never a per-id fan-out. */
async function listByIndex<T>(
  index: string,
  prefix: string,
  guard: (r: T | null) => r is T,
): Promise<T[]> {
  const ids = await readIndex(index);
  if (ids.length === 0) return [];
  const records = await persistence().readManyNamed<T>(ids.map((id) => `${prefix}${id}`));
  return records.filter(guard);
}

function byId<T extends { id: string }>(prefix: string) {
  return async (id: string): Promise<T | null> => {
    const record = await persistence().readNamed<T>(`${prefix}${id}`);
    return record && record.id === id ? record : null;
  };
}

/* ---------------- marketplace requirements ---------------- */

function reqDoc(id: string): string {
  return `commerce-req-${id}`;
}

function isRequirement(r: MarketplaceRequirement | null): r is MarketplaceRequirement {
  return Boolean(r && r.id && typeof r.reference === "string");
}

export const getRequirement = byId<MarketplaceRequirement>(reqDoc("")) as (id: string) => Promise<MarketplaceRequirement | null>;

export async function saveRequirement(req: MarketplaceRequirement): Promise<void> {
  req.updatedAt = new Date().toISOString();
  await persistence().writeNamed(reqDoc(req.id), req);
  await appendIndex(MARKETPLACE_INDEX, req.id);
}

export async function listRequirements(): Promise<MarketplaceRequirement[]> {
  const all = await listByIndex<MarketplaceRequirement>(MARKETPLACE_INDEX, "commerce-req-", isRequirement);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------------- capacity services ---------------- */

function capDoc(id: string): string {
  return `commerce-cap-${id}`;
}

function isService(r: CapacityService | null): r is CapacityService {
  return Boolean(r && r.id && typeof r.reference === "string");
}

export const getService = byId<CapacityService>(capDoc("")) as (id: string) => Promise<CapacityService | null>;

export async function saveService(service: CapacityService): Promise<void> {
  service.updatedAt = new Date().toISOString();
  await persistence().writeNamed(capDoc(service.id), service);
  await appendIndex(CAPACITY_INDEX, service.id);
}

export async function listServices(): Promise<CapacityService[]> {
  const all = await listByIndex<CapacityService>(CAPACITY_INDEX, "commerce-cap-", isService);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------------- workflows ---------------- */

function wfDoc(id: string): string {
  return `commerce-wf-${id}`;
}

function isWorkflow(r: CommerceWorkflow | null): r is CommerceWorkflow {
  return Boolean(r && r.id && typeof r.reference === "string" && Array.isArray(r.steps));
}

export const getWorkflow = byId<CommerceWorkflow>(wfDoc("")) as (id: string) => Promise<CommerceWorkflow | null>;

export async function saveWorkflow(wf: CommerceWorkflow): Promise<void> {
  wf.updatedAt = new Date().toISOString();
  await persistence().writeNamed(wfDoc(wf.id), wf);
  await appendIndex(WORKFLOWS_INDEX, wf.id);
}

export async function listWorkflows(): Promise<CommerceWorkflow[]> {
  const all = await listByIndex<CommerceWorkflow>(WORKFLOWS_INDEX, "commerce-wf-", isWorkflow);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------------- reseller packages ---------------- */

function pkgDoc(id: string): string {
  return `commerce-pkg-${id}`;
}

function isPackage(r: ResellerPackage | null): r is ResellerPackage {
  return Boolean(r && r.id && typeof r.reference === "string" && Array.isArray(r.components));
}

export const getPackage = byId<ResellerPackage>(pkgDoc("")) as (id: string) => Promise<ResellerPackage | null>;

export async function savePackage(pkg: ResellerPackage): Promise<void> {
  pkg.updatedAt = new Date().toISOString();
  await persistence().writeNamed(pkgDoc(pkg.id), pkg);
  await appendIndex(RESELLER_INDEX, pkg.id);
}

export async function listPackages(): Promise<ResellerPackage[]> {
  const all = await listByIndex<ResellerPackage>(RESELLER_INDEX, "commerce-pkg-", isPackage);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------------- intro purchases (internal rail) ---------------- */

function jobDoc(id: string): string {
  return `commerce-job-${id}`;
}

function isJob(r: CommerceJob | null): r is CommerceJob {
  return Boolean(r && r.id && r.offeringId && r.rail === "internal_credit");
}

export async function getCommerceJob(id: string): Promise<CommerceJob | null> {
  const job = await persistence().readNamed<CommerceJob>(jobDoc(id));
  return isJob(job) ? job : null;
}

export async function saveCommerceJob(job: CommerceJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await persistence().writeNamed(jobDoc(job.id), job);
  await appendIndex(jobsIndexName(job.buyerWallet), job.id);
}

export async function listCommerceJobs(wallet: string): Promise<CommerceJob[]> {
  const index = await readIndex(jobsIndexName(wallet));
  if (index.length === 0) return [];
  const records = await persistence().readManyNamed<CommerceJob>(index.map((id) => jobDoc(id)));
  return records.filter(isJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------------- ids and references ---------------- */

export function newCommerceId(): string {
  return randomUUID();
}

const REFERENCE_PREFIX: Record<string, string> = {
  requirement: "NS-MP",
  service: "NS-CAP",
  workflow: "NS-WF",
  package: "NS-RS",
};

export function newCommerceReference(kind: keyof typeof REFERENCE_PREFIX): string {
  return `${REFERENCE_PREFIX[kind]}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** A wallet for display: truncated, never assumed to belong to any caller. */
export function shortWallet(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
