// Saving on its own: a change saves a moment after typing stops, or at once on flush (blur, switching, closing, the
// page hiding). One save runs at a time and the newest text wins; an answer for older text is never handed back, so
// it can't overwrite what's being typed. Text that fails its check isn't saved and shows the check's error. A failed
// save is tried again on the next change or flush. Pure apart from the timer, which tests pass in.

export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";
export type AutosaveState = { status: AutosaveStatus; error: string };

export type Autosaver<T> = {
  /** The newest value; saves after the pause unless it fails its check. */
  change: (value: T) => void;
  /** Saves now if anything is unsaved; resolves once every save asked for so far has finished. */
  flush: () => Promise<void>;
  /** Stops the timer. */
  dispose: () => void;
  state: () => AutosaveState;
};

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export function autosave<T, R = unknown>(o: {
  save: (value: T) => Promise<R>;
  check?: (value: T) => string | null;
  /** The server's answer, only when no newer change came in while it was saving. */
  onSaved?: (answer: R, value: T) => void;
  onState?: (s: AutosaveState) => void;
  delay?: number;
  timers?: Timers;
}): Autosaver<T> {
  const timers = o.timers ?? realTimers;
  const delay = o.delay ?? 800;
  let latest: T | undefined;
  let seq = 0;
  let savedSeq = 0;
  let timer: unknown = null;
  let chain: Promise<void> = Promise.resolve();
  let st: AutosaveState = { status: "idle", error: "" };
  const set = (s: AutosaveState) => {
    st = s;
    o.onState?.(s);
  };
  const stop = () => {
    if (timer != null) timers.clear(timer);
    timer = null;
  };
  const bad = (v: T) => o.check?.(v) ?? null;

  function flush(): Promise<void> {
    stop();
    chain = chain.then(async () => {
      if (seq === savedSeq || latest === undefined) return;
      const problem = bad(latest);
      if (problem) return set({ status: "error", error: problem });
      const at = seq;
      const value = latest;
      set({ status: "saving", error: "" });
      try {
        const answer = await o.save(value);
        savedSeq = Math.max(savedSeq, at);
        if (at === seq) {
          o.onSaved?.(answer, value);
          set({ status: "saved", error: "" });
        } else if (st.status === "saving") set({ status: "pending", error: "" });
      } catch (e) {
        set(at === seq ? { status: "error", error: e instanceof Error ? e.message : String(e) } : { status: "pending", error: "" });
      }
    });
    return chain;
  }

  return {
    change(value) {
      latest = value;
      seq++;
      stop();
      const problem = bad(value);
      if (problem) return set({ status: "error", error: problem });
      if (st.status !== "saving") set({ status: "pending", error: "" });
      timer = timers.set(() => {
        timer = null;
        void flush();
      }, delay);
    },
    flush,
    dispose: stop,
    state: () => st,
  };
}
