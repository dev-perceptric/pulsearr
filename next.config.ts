import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Which build this is: the commit passed in by the image build, else the build time.
  // Open tabs compare it with /api/version and reload after a deploy.
  env: { NEXT_PUBLIC_BUILD: process.env.GIT_SHA?.slice(0, 12) || String(Date.now()) },
  // PostHog's events and script go through our own domain, so ad blockers don't drop them.
  skipTrailingSlashRedirect: true,
  serverExternalPackages: ["pg"],
  experimental: { agentUpgrade: "security" },
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
    ];
  },
};

export default nextConfig;
