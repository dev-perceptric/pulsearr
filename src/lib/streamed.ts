// A long piece of work answered as a stream (081). Cloudflare, in front of the app, ends any request that sends
// nothing for 100 seconds; a long sync or an AI answer can take longer. The response starts at once and sends a
// heartbeat every 10 seconds, progress as it goes, then one "done" or "error" event. The work goes on even if the
// browser leaves, so whatever it saves along the way is there when the person comes back.

export type StreamEvent = { type: "ping" } | ({ type: "progress" } & Record<string, unknown>) | { type: "done"; data: unknown } | { type: "error"; error: string; status: number };

export function streamed(work: (send: (e: Record<string, unknown>) => void) => Promise<unknown>): Response {
  const enc = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const write = (e: StreamEvent) => {
        if (!open) return;
        try {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };
      write({ type: "ping" });
      const beat = setInterval(() => write({ type: "ping" }), 10_000);
      work((e) => write({ ...e, type: "progress" }))
        .then((data) => write({ type: "done", data }))
        .catch((err: unknown) => {
          console.error("Streamed work failed:", err instanceof Error ? err.message : err);
          write({ type: "error", error: err instanceof Error ? err.message : String(err), status: (err as { status?: number }).status ?? 500 });
        })
        .finally(() => {
          clearInterval(beat);
          if (!open) return;
          open = false;
          try {
            ctrl.close();
          } catch {}
        });
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}

/** Reads a streamed answer: calls `onProgress` for each step and returns the "done" data, or throws its error. */
export async function readStream<T>(res: Response, onProgress?: (e: Record<string, unknown>) => void): Promise<T> {
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error ?? "Something went wrong."), { status: res.status });
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith("data: ")) continue;
      const e = JSON.parse(chunk.slice(6)) as StreamEvent;
      if (e.type === "done") return e.data as T;
      if (e.type === "error") throw Object.assign(new Error(e.error), { status: e.status });
      if (e.type === "progress") onProgress?.(e);
    }
  }
  throw new Error("The connection dropped. The work goes on: open it again in a moment.");
}
