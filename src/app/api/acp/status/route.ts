import { NextResponse } from "next/server";

import { ACP_OFFERINGS } from "@/lib/acp/offerings";
import { acpProviderStatus } from "@/lib/acp/runtime";
import { countAcpJobsByStatus } from "@/lib/acp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/acp/status — the provider connection (honest: real / mock /
 * disabled, with credential presence as booleans, never values), the
 * published offerings and the job-status counts. Public: an anonymous caller
 * sees exactly what a buyer's agent needs to discover NIGHTSHIFT.
 */
export async function GET() {
  const status = await acpProviderStatus();
  const jobCounts = await countAcpJobsByStatus();
  return NextResponse.json({ status, offerings: ACP_OFFERINGS, jobCounts });
}
