// Which build is live, so open tabs know to reload after a deploy.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ build: process.env.NEXT_PUBLIC_BUILD ?? null }, { headers: { "Cache-Control": "no-store" } });
}
