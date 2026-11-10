# PulseARR brand

The look is taken from Mosaic's site (mosaic.pe, pulled November 10, 2026): deep navy and white sections, one strong blue, a serif display face over a clean grotesk, big quiet layouts and small square details. We use the system with our own names and assets. Never use Mosaic's logo, images, videos, icons or copy.

Tokens live in `docs/brand-tokens.css`. Use the tokens, never a hex in a screen.

---

## Colors

| Token | Hex | Mosaic name | Use |
|---|---|---|---|
| `--navy-deep` | `#000522` | dark-blue | Hero and page backgrounds on dark sections, top banner |
| `--navy` | `#131824` | obsidian | Dark cards, security and product panels |
| `--ink` | `#0E0E0E` | charcoal | Body text on white |
| `--pulse-blue` | `#131FA7` | mosaic-blue | The one accent: primary buttons, eyebrow labels, the highlighted half of a headline, links |
| `--pulse-blue-hover` | `#081170` | — | Primary button hover |
| `--pulse-blue-deep` | `#0F1988` | — | Secondary filled button |
| `--sky` | `#AACBFF` | royal-blue | Accent on dark backgrounds: eyebrows, hover fills, chart highlight |
| `--ice` | `#E5EFFF` | ice-blue | Soft blue panels and picked states |
| `--slate` | `#2D3C60` | light-blue | Quiet buttons on dark, borders on dark |
| `--slate-fade` | `#2D3C6066` | faded-blue | Icon buttons on dark cards |
| `--paper` | `#FAF8FB` | — | Light cards on white (number cards, link panels) |
| `--hover-gray` | `#EEEEEE` | — | White button hover, arrow chip |
| `--gray` | `#9C9C9C` | grey | Footer labels, muted text |
| `--white` | `#FFFFFF` | white | White sections and text on dark |
| `--navy-glass` | `#000522CC` | — | Sticky header after scroll, with 20px blur |
| `--navy-glass-2` | `#000417CC` | blue-fade | Footer, with 20px blur |

**Rules**
- Sections alternate: navy (`--navy-deep`) and white. A dark card (`--navy`) sits on white for contrast.
- `--pulse-blue` is the only strong color on white. `--sky` is the only strong color on navy.
- Status colors (green up, red down) appear only inside charts and number changes.
- No gradients in the app. The marketing hero may use one dark overlay fading to clear.

## Type

| Role | Mosaic font | Our font | Size (desktop / mobile) | Weight | Line height | Tracking |
|---|---|---|---|---|---|---|
| Display | GT Canon L | Display serif | 4.375em / 3.25em | 500 | 1 | -0.02em |
| H1 | GT Canon L | Display serif | 3.75em / 3.25em | 500 | 1 | -0.02em |
| H2 | GT Canon L | Display serif | 3.25em / 2.75em | 500 | 1 | -0.01em |
| H3 | GT Canon L | Display serif | 3em / 2.25em | 500 | 1 | -0.01em |
| Large text and quotes | GT Canon / GT Standard | Display serif for quotes, sans for body | 1.25em / 0.94em | 400 | 1.4 | -0.01em |
| Body | GT Standard L | Sans | 1em | 400 | 1.3 | 0.01em |
| Small | GT Standard L | Sans | 0.875em | 400 | 1.4 | 0 |
| Eyebrow | GT Standard L | Sans, uppercase | 0.88em | 500 | 1 | 0.15em |
| Button and nav | GT Standard L | Sans | 1em | 400 | 1 | 0.01em |

**Fonts:** GT Canon and GT Standard are paid fonts from Grilli Type and need a license (check price on grillitype.com). Until we buy one, use free stand-ins from Google Fonts:
- Display serif: **Newsreader** at weight 500 (check fit; Source Serif 4 is the backup)
- Sans: **Inter**

**Headline style:** split a headline into two parts and color the first part `--pulse-blue` on white or `--sky` on navy. Example: "**Revenue you can trust,** every single time."

**Sizes scale with the screen.** The base font size is the container width divided by 90 at desktop (1440 / 16), so the whole page scales together:
- Desktop: 992–1440px wide, design width 1440
- Tablet: 768–991px, design width 900
- Large phone: 480–767px, design width 600
- Phone: 320–479px, design width 390

The app uses a fixed 14px base. Only the marketing site scales.

## Corners and shapes
- Buttons, inputs and icon buttons: **8px** (`0.5rem`).
- Cards, panels and sections: **square** (0px).
- Small icons inside menus: 3px.
- The arrow chip next to text links: a 1.5em square, nearly sharp.
- No shadows on cards. Depth comes from the navy and white contrast.

## Buttons
| Variant | Background | Text | Hover |
|---|---|---|---|
| Primary | `--pulse-blue` | white | `--pulse-blue-hover` |
| Primary deep | `--pulse-blue-deep` | white | `--pulse-blue-hover` |
| White (on navy) | white | black | `--hover-gray` |
| Sky (on navy) | `--sky` | black | `--ice` |
| Ice (on white) | `--ice` | black | `--sky` |
| Slate (on navy) | `--slate` | white | `--navy` |

Padding is 0.84em by 1em. Color changes in 0.2s. One primary button per screen.

**Text link with arrow:** a square arrow chip (`--hover-gray`, turns `--sky` on hover) followed by bold `--pulse-blue` text. Used for "Learn more" links in cards.

## Layout
- Container: max 1440px, side padding 4em (desktop), 1.5em (tablet), 1em (phone).
- Feature rows: two equal columns, text on one side and a tall picture or animation on the other, switching sides each row. On phones they stack.
- Number cards: `--paper` background, square, 5em by 7em padding, label in small text above a big `--pulse-blue` H2 number.
- Link panels: two square panels side by side, one `--paper` and one `--ice`, each with a large two-tone H2, a line of text and a button.
- Trust row: three square cells with an icon and a label, on `--navy`.
- Customer logo strip: a slow side-scrolling row of logos in one color.
- Top banner: a thin `--navy-deep` strip with one short announcement and an underlined "Learn more."
- Header: clear over the hero, turns `--navy-glass` with blur after 10px of scroll, and the banner slides up out of view.
- Footer: `--navy-glass-2` with blur, six columns of small links under gray uppercase labels.

## Motion
- One easing curve: `cubic-bezier(0.65, 0.05, 0, 1)`, 0.735s, for section entrances and reveals.
- 0.2s for button and hover color changes. 0.4s for the header fade.
- Hero: a muted, looping background video or a scroll-driven frame sequence, with a dark overlay on top.
- Feature rows: titles and text slide up from a mask as they scroll in.
- Respect reduced motion: no video autoplay and no scroll sequences when the user asks for less motion.

## Using it in the app
- Shell and sidebar on `--navy-deep`, the working area on white.
- Charts: `--pulse-blue` for the main line, `--sky` for the comparison period, `--slate` for gridlines on dark, `--hover-gray` on white.
- The big number on a metric page uses the display serif. Everything else in the app uses the sans.
- Eyebrow labels mark sections ("MRR", "CHURN", "RECOVER").
- Follow the shared rules: no browser pop-ups or dropdowns, no text cut off, labels and real errors only.
