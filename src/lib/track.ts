// Product events (PostHog). Off until NEXT_PUBLIC_POSTHOG_KEY is set. PostHog loads in the background
// (instrumentation-client.ts), so an event waits a few seconds for it and is dropped if it never comes.
// Never send what people wrote or their numbers: only step names, counts and choices.

export async function track(event: string, props: Record<string, string | number | boolean | null> = {}) {
  if (typeof window === "undefined" || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  try {
    const { default: ph } = await import("posthog-js");
    for (let i = 0; i < 20 && !ph.__loaded; i++) await new Promise((r) => setTimeout(r, 250));
    if (ph.__loaded) ph.capture(event, props);
  } catch {}
}
