/**
 * SSE live stream for one task: the console's near-instant update channel.
 *
 * The 3-second poll stays as the fallback; this stream pushes the same
 * { task, redacted } payload the poll returns the moment anything changes
 * (state transition or new event), so a run's timeline fills in live instead
 * of in 3s steps. Frames only carry data when something changed; heartbeats
 * keep intermediaries from buffering. The stream ends after ~50s and the
 * client's EventSource reconnects automatically — serverless-friendly.
 *
 * Identity/projection: identical to GET /api/tasks/:id (owner sees own full
 * record; everyone else the public projection via taskForCaller).
 */
import { NextRequest } from "next/server";
import { getTask } from "@/lib/engine/store";
import { reapIfStalled } from "@/lib/engine/engine";
import { taskForCaller } from "@/lib/api/public";
import type { TaskState } from "@/lib/engine/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TERMINAL: ReadonlySet<TaskState> = new Set(["completed", "failed", "rejected", "blocked"]);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const deadline = Date.now() + 50_000;
      let lastKey = "";
      const send = (payload: string) => {
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // client went away — the loop's next await will surface it
        }
      };
      send(": stream open\n\n");
      while (Date.now() < deadline) {
        try {
          const stored = await getTask(id);
          if (!stored) {
            send(`event: gone\ndata: {"error":"task ${id} not found"}\n\n`);
            break;
          }
          const task = await reapIfStalled(stored, Date.now());
          const view = taskForCaller(req, task);
          const lastEventId = view.task.events.length ? view.task.events[view.task.events.length - 1].id : "";
          const key = `${view.task.state}:${view.task.updatedAt}:${lastEventId}`;
          if (key !== lastKey) {
            lastKey = key;
            send(`data: ${JSON.stringify({ task: view.task, redacted: view.redacted })}\n\n`);
          } else {
            send(": ping\n\n");
          }
          if (TERMINAL.has(view.task.state)) break;
        } catch {
          send(": storage unavailable, retrying\n\n");
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      try {
        controller.close();
      } catch {
        // already closed by the client disconnecting
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
