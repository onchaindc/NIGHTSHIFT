/**
 * ACP job persistence — same swappable backend as every other NIGHTSHIFT
 * record (Postgres in production, JSON files locally), as named documents:
 *
 *   acp-jobs-index    — the ordered key list
 *   acp-job-<key>     — one whole job record (key = "<chainId>:<jobId>")
 *
 * The key IS the idempotency boundary: a duplicate job.created, a redelivered
 * event or a retried intake all upsert onto the same record and can never
 * create a second investigation.
 */

import { persistence } from "@/lib/storage";
import type { AcpJobRecord, AcpSessionRef } from "./types";

const INDEX = "acp-jobs-index";

export function acpJobKey(ref: AcpSessionRef): string {
  return `${ref.chainId}:${ref.jobId}`;
}

function docName(key: string): string {
  return `acp-job-${key}`;
}

export async function listAcpJobs(): Promise<AcpJobRecord[]> {
  const keys = await persistence().readNamed<string[]>(INDEX);
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const records = await persistence().readManyNamed<AcpJobRecord>(keys.map((k) => docName(k)));
  return records
    .filter((r): r is AcpJobRecord => Boolean(r && r.key))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getAcpJob(key: string): Promise<AcpJobRecord | null> {
  const record = await persistence().readNamed<AcpJobRecord>(docName(key));
  return record && record.key === key ? record : null;
}

export async function saveAcpJob(job: AcpJobRecord): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await persistence().writeNamed(docName(job.key), job);
  const keys = await persistence().readNamed<string[]>(INDEX);
  const list = Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [];
  if (!list.includes(job.key)) {
    list.push(job.key);
    await persistence().writeNamed(INDEX, list);
  }
}

export async function countAcpJobsByStatus(): Promise<Record<string, number>> {
  const jobs = await listAcpJobs();
  const counts: Record<string, number> = {};
  for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
  return counts;
}
