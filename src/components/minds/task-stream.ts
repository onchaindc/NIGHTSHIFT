"use client";

/**
 * SSE subscription to one task, mirroring GET /api/tasks/:id's payload.
 *
 * EventSource auto-reconnects when the server closes the stream (the stream
 * deliberately ends after ~50s), so this is a persistent live channel with no
 * client-side reconnect logic. Where SSE is unavailable the caller keeps its
 * existing polling loop — the stream is a latency upgrade, not a dependency.
 */
export function openTaskStream(id: string, onTask: (body: unknown) => void, onError?: () => void): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    onError?.();
    return () => {};
  }
  const source = new EventSource(`/api/tasks/${encodeURIComponent(id)}/stream`);
  source.onmessage = (event) => {
    try {
      onTask(JSON.parse(event.data));
    } catch {
      /* ignore a malformed frame; the next update or poll will correct state */
    }
  };
  source.onerror = () => onError?.();
  return () => source.close();
}
