import { Suspense, useId } from "react";
import { isLucide, LucideIcon } from "./AppIcon";

// The drawing on an empty screen: a square tile seen from above at an angle, sitting on a square plate, with the
// tool's sign drawn on its top. Navy edges, a white top, ice and gray sides with a fine blue dot, and the sign in pulse
// blue: two colors plus the background (docs/brand.md section 9). Each sign is drawn flat on a 24-unit square with
// square caps and laid onto the tile with one isometric transform, so every drawing shares the same angle and line
// weight. A stored Lucide icon name can stand in for the sign. Some drawings add a small second tile beside the first
// (`MINI`), sharing the same plate. "pulse" is the brand's pulse line, the default.

export type DrawingKind =
  | "pulse"
  | "revenue"
  | "team"
  | "connect"
  | "records"
  | "people"
  | "files"
  | "emails"
  | "timeline"
  | "dashboards"
  | "activity"
  | "workflow"
  | "settings"
  | "search"
  | "nomatch";

const SIGNS: Record<DrawingKind, React.ReactNode> = {
  pulse: <path d="M2.5 16.5H9L11.5 6l2.2 8.2 1.8-2.7h6" />,
  revenue: <path d="M3 20.5h18M5.5 20.5v-5M10 20.5v-8M14.5 20.5v-6M19 20.5V5" />,
  team: (
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20.5c.8-3.6 3.4-5.8 6.5-5.8s5.7 2.2 6.5 5.8" />
      <circle cx="17" cy="6.5" r="2.8" />
      <path d="M17.5 12.3c2.3.4 3.7 2.2 4.2 4.7" />
    </>
  ),
  connect: <path d="M9 2.5v5M15 2.5v5M5.5 7.5h13v3.5a6.5 6.5 0 0 1-13 0zM12 17.5v4" />,
  records: <path d="M3 4h18v16H3zM3 9h18M3 14h18M9 4v16" />,
  people: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1-4 4.2-6.5 8-6.5s7 2.5 8 6.5" />
    </>
  ),
  files: <path d="M14 3H5v18h14V8zM14 3v5h5M12 17v-6M9.5 13.5 12 11l2.5 2.5" />,
  emails: <path d="M3 5h18v14H3zM3.5 6.5l8.5 6.5 8.5-6.5" />,
  timeline: <path d="M4 4h4v4H4zM4 16h4v4H4zM6 8v8M11 6h10M11 18h10M11 12h6" />,
  dashboards: <path d="M3 3v18h18M7 16v-4M11.5 16V8M16 16v-6M20.5 16V5" />,
  activity: <path d="M2 12.5h4.5l2.5-6 4 12 3-8.5 1.8 2.5H22" />,
  workflow: <path d="M8 2.5h8V8H8zM2.5 16h8v5.5h-8zM13.5 16h8v5.5h-8zM12 8v4M6.5 16v-4h11v4" />,
  settings: (
    <>
      <path d="M20 7h-9M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </>
  ),
  nomatch: <path d="M3 5h18l-7 8.5V20l-4-2v-4.5z" />,
};

// The small tile's sign, for the drawings that have one.
const MINI: Partial<Record<DrawingKind, React.ReactNode>> = {
  revenue: SIGNS.pulse,
  connect: <path d="M5 5h14v14H5zM9 12l2 2 4-4.5" />,
  activity: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.8 2.8L16.5 9.5" />
    </>
  ),
  workflow: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  nomatch: SIGNS.search,
};

// Flat (x, y) on the tile to the screen: 30° isometric.
const C = 0.866;
const iso = (x: number, y: number, z = 0): [number, number] => [(x - y) * C, (x + y) * 0.5 - z];
const pts = (list: [number, number][]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/** One tile at (ox, oy) on the ground: its two dotted sides, its white top and its sign. */
function Tile({ ox, oy, h, t, k, dots, children }: { ox: number; oy: number; h: number; t: number; k: number; dots: string; children: React.ReactNode }) {
  const P = (x: number, y: number, z = 0) => iso(ox + x, oy + y, z);
  const top = [P(-h, -h, t), P(h, -h, t), P(h, h, t), P(-h, h, t)];
  const left = [P(-h, h, t), P(h, h, t), P(h, h), P(-h, h)];
  const right = [P(h, -h, t), P(h, h, t), P(h, h), P(h, -h)];
  const sign = `matrix(${C * k} ${0.5 * k} ${-C * k} ${0.5 * k} ${P(-12 * k, -12 * k, t).join(" ")})`;
  return (
    <>
      <g stroke="var(--navy-deep)" strokeWidth="1.5" strokeLinejoin="miter">
        <polygon points={pts(left)} fill="var(--ice)" />
        <polygon points={pts(left)} fill={`url(#${dots})`} />
        <polygon points={pts(right)} fill="var(--hover-gray)" />
        <polygon points={pts(right)} fill={`url(#${dots})`} />
        <polygon points={pts(top)} fill="var(--white)" />
      </g>
      <g transform={sign} stroke="var(--pulse-blue)" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter" fill="none" className="[&_*]:[vector-effect:non-scaling-stroke]">
        {children}
      </g>
    </>
  );
}

export function Drawing({ kind = "pulse", icon, size = 220 }: { kind?: DrawingKind; icon?: string | null; size?: number }) {
  const dots = useId().replace(/:/g, "");
  const h = 40; // half the tile's side
  const t = 12; // the tile's thickness
  const mini = isLucide(icon) ? undefined : MINI[kind];
  // The plate under the tiles: a square flat on the ground, longer when a small tile sits beside the first.
  const plate = `matrix(${C} 0.5 ${-C} 0.5 0 0)`;
  const [x0, y0, x1, y1] = mini ? [-62, -62, 99, 57] : [-h - 22, -h - 22, h + 22, h + 22];
  const [vx, vy, vw, vh] = mini ? [-108, -66, 252, 148] : [-110, -62, 220, 150];
  const main = isLucide(icon) ? (
    <Suspense fallback={null}>
      <LucideIcon name={icon} width={24} height={24} strokeWidth={1.6} strokeLinecap="square" style={{ color: "var(--pulse-blue)" }} fallback={() => null} />
    </Suspense>
  ) : (
    SIGNS[kind]
  );
  return (
    <svg width={size} height={(size * vh) / vw} viewBox={`${vx} ${vy} ${vw} ${vh}`} fill="none" aria-hidden="true" className="shrink-0">
      <defs>
        <pattern id={dots} width="3" height="3" patternUnits="userSpaceOnUse">
          <rect x="1" y="1" width="1" height="1" fill="var(--pulse-blue)" opacity="0.35" />
        </pattern>
      </defs>
      <g transform={plate}>
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="var(--paper)" stroke="var(--line-strong)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </g>
      <Tile ox={0} oy={0} h={h} t={t} k={2.7} dots={dots}>
        {main}
      </Tile>
      {mini ? (
        <Tile ox={60} oy={18} h={17} t={7} k={1.1} dots={dots}>
          {mini}
        </Tile>
      ) : null}
    </svg>
  );
}
