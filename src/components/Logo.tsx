// The PulseARR logo (docs/brand.md section 3): a square tile holding one pulse line that runs flat, beats once and
// ends higher, stroke 1/12 of the tile with square ends; and the wordmark, "Pulse" in the serif and "ARR" in the
// sans, both at 500. Two color versions in the app: `reverse` (sky tile, navy line, white words) on the navy sidebar,
// `primary` (pulse-blue tile, white line, ink words) on white. Square corners, no effects.

type Tone = "reverse" | "primary";

const TILE: Record<Tone, { tile: string; line: string; words: string }> = {
  reverse: { tile: "var(--sky)", line: "var(--navy-deep)", words: "text-white" },
  primary: { tile: "var(--pulse-blue)", line: "var(--white)", words: "text-ink" },
};

/** The mark alone on its tile: 24px in the app, 16px at the smallest. */
export function LogoMark({ size = 24, tone = "reverse", label }: { size?: number; tone?: Tone; label?: string }) {
  const c = TILE[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <rect width="24" height="24" style={{ fill: c.tile }} />
      <path d="M3.5 16.5H9L11.5 6l2.2 8.2L15.5 11.5H20.5" fill="none" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" style={{ stroke: c.line }} />
    </svg>
  );
}

/** The wordmark on its own: "Pulse" serif, "ARR" sans, one baseline. */
export function Wordmark({ size = 18, tone = "reverse" }: { size?: number; tone?: Tone }) {
  return (
    <span className={`inline-flex items-baseline leading-none whitespace-nowrap ${TILE[tone].words}`} style={{ fontSize: size }}>
      <span className="font-serif font-medium">Pulse</span>
      <span className="font-sans font-medium tracking-[0.04em]">ARR</span>
    </span>
  );
}

/** The lockup: mark on the left, wordmark on the right, a gap half the mark's width. Reads as "PulseARR". */
export function Lockup({ size = 24, tone = "reverse" }: { size?: number; tone?: Tone }) {
  return (
    <span role="img" aria-label="PulseARR" className="inline-flex items-center" style={{ gap: size / 2 }}>
      <LogoMark size={size} tone={tone} />
      <span aria-hidden="true">
        <Wordmark size={Math.round(size * 0.8)} tone={tone} />
      </span>
    </span>
  );
}
