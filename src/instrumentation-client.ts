// Product analytics and session replay (PostHog). Events go through /ingest on our own domain (next.config.ts), so
// ad blockers don't drop them. Every word on screen and every input is masked in recordings, since it's customers'
// revenue data. Off until NEXT_PUBLIC_POSTHOG_KEY is set. The library downloads after the page's own code, so it
// never holds up the first screen.

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = window.location.hostname;
const ours = host === "localhost" || host === "pulsearr.com" || host.endsWith(".pulsearr.com");

if (key && ours) {
  void import("posthog-js").then(({ default: posthog }) =>
    posthog.init(key, {
      api_host: "/ingest",
      ui_host: "https://us.posthog.com",
      defaults: "2025-05-24",
      person_profiles: "identified_only",
      capture_exceptions: true,
      session_recording: { maskAllInputs: true, maskTextSelector: "*" },
    }),
  );
}
