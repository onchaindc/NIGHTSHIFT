import { NextResponse } from "next/server";
import { deleteWatch, getWatch } from "@/lib/watch/store";
import { requestAuthorized } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/watches/:id - one watch config, 404 when absent. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const watch = await getWatch(id);
  if (!watch) return NextResponse.json({ error: "watch not found" }, { status: 404 });
  return NextResponse.json({ watch });
}

/** DELETE /api/watches/:id - removes the config. Recorded check runs (tasks) stay in history. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!requestAuthorized(req)) {
    return NextResponse.json({ error: "authorization required: this deployment gates watch deletion behind a bearer token (NIGHTSHIFT_API_TOKEN)" }, { status: 401 });
  }
  const { id } = await params;
  const removed = await deleteWatch(id);
  if (!removed) return NextResponse.json({ error: "watch not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
