"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { dialogIn, dialogOut, fadeIn, fadeOut } from "@/lib/motion";
import { Button, inputClass } from "./ui";

// The app's own pop-up questions, in place of the browser's prompt, confirm and alert boxes.
// Call askText, askConfirm or tell from anywhere; <DialogHost /> (mounted once) shows them.

type Request =
  | { kind: "text"; title: string; initial: string; placeholder?: string; ok: string; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; body?: string; ok: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: "tell"; title: string; body?: string; resolve: () => void };

let show: ((r: Request) => void) | null = null;
const queue: Request[] = [];
const send = (r: Request) => (show ? show(r) : queue.push(r));

export const askText = (title: string, opts: { initial?: string; placeholder?: string; ok?: string } = {}) =>
  new Promise<string | null>((resolve) => send({ kind: "text", title, initial: opts.initial ?? "", placeholder: opts.placeholder, ok: opts.ok ?? "Save", resolve }));

export const askConfirm = (title: string, opts: { body?: string; ok?: string; danger?: boolean } = {}) =>
  new Promise<boolean>((resolve) => send({ kind: "confirm", title, body: opts.body, ok: opts.ok ?? "Continue", danger: opts.danger ?? false, resolve }));

export const tell = (title: string, body?: string) => new Promise<void>((resolve) => send({ kind: "tell", title, body, resolve }));

export function DialogHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [text, setText] = useState("");
  const layer = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLFormElement>(null);
  const leaving = useRef(false);
  const open = req !== null;
  // Each question grows in; the dim layer fades in only when the first one opens.
  useLayoutEffect(() => {
    if (open) void fadeIn(layer.current);
  }, [open]);
  useLayoutEffect(() => {
    if (req) void dialogIn(card.current);
  }, [req]);

  useEffect(() => {
    show = (r) => {
      setReq(r);
      if (r.kind === "text") setText(r.initial);
    };
    const waiting = queue.shift();
    if (waiting) show(waiting);
    return () => {
      show = null;
    };
  }, []);

  if (!req) return null;
  const finish = async (answer: boolean) => {
    if (leaving.current) return;
    if (req.kind === "text") req.resolve(answer && text.trim() ? text.trim() : null);
    else if (req.kind === "confirm") req.resolve(answer);
    else req.resolve();
    const next = queue.shift() ?? null;
    // The last question leaves quicker than it came; a waiting one takes its place at once.
    if (!next) {
      leaving.current = true;
      await Promise.all([dialogOut(card.current), fadeOut(layer.current)]);
      leaving.current = false;
    }
    setReq(next);
    if (next?.kind === "text") setText(next.initial);
  };

  return (
    <div
      ref={layer}
      className="fixed inset-0 z-[90] grid place-items-center bg-scrim px-4"
      onMouseDown={() => void finish(false)}
      onKeyDown={(e) => e.key === "Escape" && void finish(false)}
    >
      <form
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        className="flex w-[440px] max-w-full flex-col gap-5 rounded-md bg-panel p-6 shadow-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Enter answers from the box or the focused button; Cmd/Ctrl+Enter answers from anywhere in it.
          if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (req.kind !== "text" || text.trim()) void finish(true);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void finish(true);
        }}
      >
        <div className="flex flex-col gap-3">
          <h2 className="text-[18px] leading-6 font-semibold wrap-break-word">{req.title}</h2>
          {"body" in req && req.body ? <p className="whitespace-pre-line text-[14px] wrap-break-word text-muted">{req.body}</p> : null}
          {req.kind === "text" ? (
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={req.placeholder}
              maxLength={120}
              className={inputClass}
            />
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          {req.kind !== "tell" ? (
            <Button type="button" variant="secondary" onClick={() => void finish(false)}>
              Cancel
            </Button>
          ) : null}
          <Button
            type="submit"
            autoFocus={req.kind !== "text"}
            disabled={req.kind === "text" && !text.trim()}
            variant={req.kind === "confirm" && req.danger ? "danger" : "primary"}
          >
            {req.kind === "tell" ? "OK" : req.ok}
          </Button>
        </div>
      </form>
    </div>
  );
}
