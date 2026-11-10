# PulseARR brand guidelines

Version 1.0, November 10, 2026.

This guide covers everything PulseARR looks like and sounds like: the app, the website, emails, social posts, decks and anything else with our name on it. When something isn't covered here, pick the option that is calmer, clearer and more exact.

The visual system is taken from Mosaic's site (mosaic.pe, pulled November 10, 2026): deep navy and white, one strong blue, serif headlines over a clean sans, square shapes and slow, smooth motion. We use the system with our own names and our own assets. **Never use Mosaic's logo, pictures, videos, icons or wording.**

Code tokens live in `docs/brand-tokens.css`. Use tokens everywhere. A raw hex code in a screen is a bug.

---

## Contents
1. Brand core
2. Name
3. Logo
4. Color
5. Typography
6. Layout and spacing
7. Shape, borders and depth
8. Icons
9. Imagery and illustration
10. Data and charts
11. Motion
12. App components
13. Voice and tone
14. Writing rules
15. Website
16. Email
17. Social, ads and decks
18. Accessibility
19. Checklists
20. Files and assets

---

## 1. Brand core

### Mission
Give every subscription business numbers it can trust and the answers behind them.

### Promise
Your MRR, explained, with the money you're losing won back on its own.

### Positioning
For SaaS founders and small finance and growth teams who run on Stripe, PulseARR is the revenue analytics tool that tells you what moved, why it moved and what to do next. Baremetrics and ChartMogul show charts. PulseARR explains them, wins back failed payments and links revenue to the deals, campaigns and AI search answers that brought it in.

### Who we serve
| Person | What they want | What they fear |
|---|---|---|
| Founder ($0–2M ARR) | One honest number each morning and a clear next step | Wrong numbers in front of investors |
| Head of growth | Which channel and campaign brings paying customers | Spending on channels that don't pay back |
| Finance lead | Clean MRR, churn and cohorts that match Stripe | Spending month-end fixing spreadsheets |
| Investor watching a company | A trustworthy public revenue page | Numbers that change after the fact |

### Personality
| Trait | What it looks like | What we steer clear of |
|---|---|---|
| **Exact** | Real numbers with their source, dates and units | Rounding to sound good, vague claims |
| **Calm** | Plain words, lots of space, slow motion | Hype, alarms, exclamation points |
| **Direct** | Says what moved and what to do | Long setups before the point |
| **Warm** | Respects the founder's work and time | Jokes about churn or failed payments |
| **Confident** | Short sentences, no hedging when the data is clear | Bragging and superlatives |

### Brand story (use on the About page and in pitches)
Every subscription founder opens Stripe each morning and does math in their head. Was that a good day? Why did churn jump? Where did last month's best customers come from? The tools built to answer this show charts and leave the thinking to you. PulseARR does the thinking with you. It counts revenue the same way every time, explains each change in plain English, and wins back the money that slips away through failed cards and quiet cancels.

### Tagline and lines we can use
- **Main tagline:** Revenue you can trust.
- **Long version:** Your MRR, explained.
- **Recover:** Win back failed payments on autopilot.
- **Pulse AI:** Every morning, what moved and why.
- **Revenue by source:** See which deals, campaigns and AI answers pay.

---

## 2. Name

- Written **PulseARR**: capital P, lowercase "ulse," capital "ARR." No space.
- Say it "pulse A-R-R" (letters), or "pulse-are" in casual talk. Both are fine.
- The AI analyst is **Pulse**. The product is **PulseARR**. Never call the AI "PulseARR AI" or "the bot."
- Feature names use title case only as names: **Recover**, **Cancel Flow**, **Open Pages**, **Revenue by Source**. In a sentence about the idea, use lowercase: "set up failed payment recovery with Recover."
- Domain: pulsearr.com. App: app.pulsearr.com. Card page: pay.pulsearr.com. Public pages: pulsearr.com/open/name.

| Right | Wrong |
|---|---|
| PulseARR | Pulsearr, PULSEARR, Pulse ARR, Pulse-ARR, PulseArr |
| Pulse (the AI) | PulseBot, Pulse AI Assistant, our AI |
| Recover | ReCover, recovery tool (as a name) |

---

## 3. Logo

The logo has not been drawn yet. This section is the brief for it and the rules for using it.

### The brief
- **Wordmark:** "Pulse" in the display serif at weight 500, followed by "ARR" in the sans at weight 500, letter-spaced +0.04em. One baseline.
- **Mark:** a square tile holding one line that starts flat, rises in one sharp beat and ends higher than it started: a heartbeat that turns into growth. Single stroke, square ends, stroke width 1/12 of the tile.
- **Lockup:** mark on the left, wordmark on the right, gap equal to half the mark's width.
- Square corners on the tile. No gradients, shadows, outlines or 3D.

### Color versions
| Version | Mark tile | Line | Wordmark | Use on |
|---|---|---|---|---|
| Primary | `--pulse-blue` | white | `--ink` | White and `--paper` |
| Reverse | `--sky` | `--navy-deep` | white | `--navy-deep` and `--navy` |
| One color dark | `--ink` | white | `--ink` | Print, single-color merch |
| One color light | white | `--navy-deep` | white | Photos and video with a dark overlay |

### Clear space and size
- Keep clear space on every side equal to the height of the mark tile's line beat (about 1/3 of the tile).
- Smallest size: lockup 96px wide on screen, 24mm in print. Mark alone: 16px (favicon), 24px in the app.
- Favicon and app icon: the mark alone on its tile.

### Never
- Stretch, squash, rotate or outline the logo.
- Recolor it outside the four versions.
- Put it on a busy photo without the dark overlay.
- Add effects, a tagline inside the lockup, or a pill behind it.
- Use Mosaic's logo or anything that looks like it.

---

## 4. Color

### Core palette
| Token | Hex | Role |
|---|---|---|
| `--navy-deep` | `#000522` | Dark sections, app sidebar, hero, top banner |
| `--navy` | `#131824` | Dark cards on white, dark panels |
| `--ink` | `#0E0E0E` | Main text on light backgrounds |
| `--pulse-blue` | `#131FA7` | The one accent on light: primary button, links, eyebrows, highlighted headline words, main chart line |
| `--pulse-blue-hover` | `#081170` | Primary button hover and pressed |
| `--pulse-blue-deep` | `#0F1988` | Second filled button |
| `--sky` | `#AACBFF` | The one accent on dark: eyebrows, highlighted headline words, hover fills, comparison chart line |
| `--ice` | `#E5EFFF` | Soft blue panels, picked rows, picked tabs |
| `--slate` | `#2D3C60` | Quiet buttons and lines on dark |
| `--slate-fade` | `#2D3C6066` | Icon buttons on dark cards |
| `--paper` | `#FAF8FB` | Light cards on white |
| `--hover-gray` | `#EEEEEE` | White button hover, arrow chip, gridlines on white |
| `--line` | `#E6E6E9` | Borders and dividers on white |
| `--muted` | `#6B6B6B` | Secondary text on white (labels, captions, timestamps) |
| `--gray` | `#9C9C9C` | Secondary text on dark only, footer labels |
| `--white` | `#FFFFFF` | Light sections, text on dark |
| `--navy-glass` | `#000522CC` | Sticky header after scroll (with 20px blur) |
| `--navy-glass-2` | `#000417CC` | Footer (with 20px blur) |

### Status colors (numbers and states only)
| Token | Hex on light | Token | Hex on dark | Means |
|---|---|---|---|---|
| `--up` | `#0B7A4B` | `--up-on-dark` | `#3FD08A` | Growth, recovered, paid, good change |
| `--down` | `#B42318` | `--down-on-dark` | `#FF7A6B` | Churn, failed, lost, bad change |
| `--warn` | `#B54708` | `--warn-on-dark` | `#FFB45C` | Past due, at risk, needs a look |

Each status color has a soft fill for tags: `--up-soft #E7F5EE`, `--down-soft #FDECEA`, `--warn-soft #FEF3E6`.

"Good" depends on the metric. Churn going down is green. Always color by what the change means for the business, not by the direction of the arrow.

### How much of each
On a light screen, roughly:
- 70% white and `--paper`
- 20% `--ink` and `--muted` text
- 7% `--navy` or `--navy-deep` blocks
- 3% `--pulse-blue`

On a dark screen, swap white for `--navy-deep` and `--pulse-blue` for `--sky`. If a screen has more than about 5% blue, take some away.

### Section order on the website
Navy hero, white feature rows, navy product panels, white quotes, navy trust row, white or light call to action, glass footer. Two navy sections never touch. Two white sections may touch if a `--paper` card separates them.

### Contrast (WCAG)
| Text | On | Ratio | Passes |
|---|---|---|---|
| `--ink` | white | 19.3 | AAA |
| `--pulse-blue` | white | 11.8 | AAA |
| white | `--pulse-blue` | 11.8 | AAA |
| `--pulse-blue` | `--ice` | 10.2 | AAA |
| `--pulse-blue` | `--paper` | 11.2 | AAA |
| white | `--navy-deep` | 20.1 | AAA |
| white | `--navy` | 17.7 | AAA |
| `--sky` | `--navy-deep` | 12.2 | AAA |
| `--sky` | `--navy` | 10.7 | AAA |
| black | `--sky` | 12.7 | AAA |
| white | `--slate` | 10.9 | AAA |
| `--muted` | white | 5.3 | AA |
| `--gray` | `--navy-deep` | 7.3 | AAA |
| `--gray` | white | 2.75 | **Fails. Never use `--gray` text on white.** |
| `--up` | white | 5.4 | AA |
| `--down` | white | 6.6 | AA |
| `--warn` | white | 5.4 | AA |
| `--up-on-dark` | `--navy-deep` | 10.2 | AAA |
| `--down-on-dark` | `--navy-deep` | 7.9 | AAA |

### Never
- Gradients in the app or on buttons. The only gradient allowed is the dark overlay on a hero video.
- Blue text on navy or navy text on blue.
- Status colors for decoration.
- New colors without adding them here first.

---

## 5. Typography

### Families
| Role | Licensed font | Free stand-in (use now) | Fallback |
|---|---|---|---|
| Display serif | GT Canon (Grilli Type) | **Newsreader** 500 | Source Serif 4, Georgia, serif |
| Sans | GT Standard (Grilli Type) | **Inter** 400, 500, 600 | Arial, sans-serif |
| Mono (code and IDs only) | — | **JetBrains Mono** 400 | ui-monospace, monospace |

GT Canon and GT Standard need a paid license from Grilli Type (price: check grillitype.com). Switching later only means changing `--font-display` and `--font-sans`.

Load Newsreader, Inter and JetBrains Mono from Google Fonts with `display=swap`.

### Website scale (fluid)
The base size grows with the screen (section 6). Sizes are in em of that base.

| Style | Font | Desktop | Mobile | Weight | Line height | Tracking |
|---|---|---|---|---|---|---|
| Display | Serif | 4.375em | 3.25em | 500 | 1.0 | -0.02em |
| H1 | Serif | 3.75em | 3.25em | 500 | 1.0 | -0.02em |
| H2 | Serif | 3.25em | 2.75em | 500 | 1.0 | -0.01em |
| H3 | Serif | 3em | 2.25em | 500 | 1.0 | -0.01em |
| H4 | Serif | 2.375em | 2em | 500 | 1.1 | -0.01em |
| Quote | Serif | 2em | 1.5em | 400 | 1.25 | -0.01em |
| Lead | Sans | 1.25em | 0.94em | 400 | 1.4 | -0.01em |
| Body | Sans | 1em | 1em | 400 | 1.3 | 0.01em |
| Small | Sans | 0.875em | 0.875em | 400 | 1.4 | 0 |
| Eyebrow | Sans, uppercase | 0.88em | 0.88em | 500 | 1.0 | 0.15em |
| Button and nav | Sans | 1em | 1em | 400 | 1.0 | 0.01em |
| Footer link | Sans | 0.81em | 0.81em | 400 | 1.4 | 0 |

### App scale (fixed)
| Style | Font | Size | Weight | Line height |
|---|---|---|---|---|
| Hero number (metric page) | Serif | 48px | 500 | 52px |
| Card number | Serif | 28px | 500 | 32px |
| Page title | Serif | 24px | 500 | 30px |
| Section title | Sans | 16px | 600 | 22px |
| Body | Sans | 14px | 400 | 20px |
| Table and label | Sans | 13px | 400 | 18px |
| Eyebrow | Sans, uppercase | 11px | 500 | 14px, tracking 0.12em |
| Caption | Sans | 12px | 400 | 16px |

### Rules
- **Numbers:** always tabular figures in tables, charts and number cards (`font-variant-numeric: tabular-nums`), so digits line up.
- **Two-tone headlines:** split the headline at a natural break. The first part takes the accent (`--pulse-blue` on light, `--sky` on dark), and the rest stays the base color. One two-tone headline per section at most.
  - "**Revenue you can trust,** every single time."
  - "**Every failed card,** followed up for you."
- **Case:** sentence case for every headline, button, label and menu item. Uppercase only for eyebrows.
- **Line length:** 45–75 characters for body text. Headlines may wrap; use `text-wrap: balance` for headlines and `text-wrap: pretty` for paragraphs.
- **Weights:** the serif uses 500 only (400 for quotes). The sans uses 400 for text, 500 for buttons and eyebrows, 600 for section titles. No bold inside paragraphs except a number or a product name.
- **Never cut text off.** No ellipsis, `truncate` or line clamps. Text wraps and the layout makes room.
- Never set body text in the serif. Never set a headline in the mono.

---

## 6. Layout and spacing

### Website container and fluid size
- Max width 1440px, centered.
- Side padding: 4em desktop, 1.5em tablet, 1em phone.
- The base font size equals the container width ÷ (design width ÷ 16), so the page scales as one piece:

| Range | Container min–max | Design width |
|---|---|---|
| Desktop | 992–1440px | 1440 |
| Tablet | 768–991px | 900 |
| Large phone | 480–767px | 600 |
| Phone | 320–479px | 390 |

### Grid
- Website: 12 columns, gap 2em. Feature rows use 6 + 6.
- App: 12 columns inside the main area, gap 16px. Sidebar 240px fixed. Right rail 320px when shown.

### Spacing scale
The app uses a 4px grid. The website uses em steps of the same ratios.

| Token | App | Website | Use |
|---|---|---|---|
| `--space-1` | 4px | 0.25em | Icon to label |
| `--space-2` | 8px | 0.5em | Inside tags and small controls |
| `--space-3` | 12px | 0.75em | Between label and value |
| `--space-4` | 16px | 1em | Card padding (small), grid gap |
| `--space-6` | 24px | 1.5em | Card padding (default) |
| `--space-8` | 32px | 2em | Between cards |
| `--space-10` | 40px | 2.5em | Inside large panels |
| `--space-16` | 64px | 4em | Between page sections in the app |
| `--space-24` | 96px | 6.25em | Section padding on the site |
| `--space-40` | 160px | 10em | Space above the final call to action |

### Website section patterns
- **Section padding:** 6.25em top and bottom on desktop, 3.75em on phones.
- **Feature row:** text on one side, a tall product picture or animation (about 41em by 42.5em) on the other, switching sides each row. Stacks on tablet and phone with the picture first.
- **Product panel:** full-width `--navy` block, 6.25em by 11em padding, title and text on the left, square icon button on the right.
- **Number cards:** two or more `--paper` cards, 5em by 7em padding, small label above a big `--pulse-blue` serif number.
- **Link panels:** two square panels side by side, one `--paper` and one `--ice`, each with a large two-tone H2, one line and a button.
- **Trust row:** three square cells on `--navy`, icon on top, label below, 5em padding.
- **Call to action:** centered, max 41em wide, H2 plus one line plus one button.

---

## 7. Shape, borders and depth

| Element | Corner |
|---|---|
| Cards, panels, sections, tables, images, charts | 0px (square) |
| Buttons, inputs, menus, tooltips, dialogs | 8px |
| Tags and status labels | 2px |
| Icons in menus, arrow chip | 2px |
| Avatars | 0px (square crop) |

- Borders: 1px `--line` on white, 1px `--slate` on dark.
- No shadows on cards or panels. Depth comes from navy against white and `--paper` against white.
- The only shadows allowed are on floating layers (menus, tooltips, dialogs): `0 8px 24px rgba(0, 5, 34, 0.12)`.
- Focus ring: 2px `--pulse-blue` outline with 2px offset on light, 2px `--sky` on dark.
- No pills. No circles except the status dot (8px) in the live feed.

---

## 8. Icons

- Set: **Lucide**, stroke 1.5px, square line caps where the icon allows.
- Sizes: 16px in tables and buttons, 20px in navigation, 24px in empty states and feature cards.
- Color: same as the text next to it. `--pulse-blue` only when the icon is the action itself.
- Icon buttons sit in an 8px-corner square: 32px in the app, 2.5em on the site. On dark cards use `--slate-fade` behind a white icon.
- Every icon button has a tooltip and an accessible name.
- **Arrow chip:** a 1.5em square in `--hover-gray` (turns `--sky` on hover) holding a small arrow, placed before bold `--pulse-blue` link text. Use it for "Learn more" style links only.
- No emoji anywhere: app, site, emails, social posts.

---

## 9. Imagery and illustration

### Product pictures
- The main image type. Show real screens with realistic but invented data. Never show a real customer's numbers without written permission.
- Crop tight to the part that matters. Place screens on `--navy` or `--paper` with generous space around them.
- Never tilt screens in 3D or add device frames on the website. Phone frames are fine in app store and social posts.

### Abstract art
- One motif: **the pulse line.** A thin line (1–2px, `--sky` on navy or `--pulse-blue` on white) that runs flat, beats once and keeps rising. Use it in hero backgrounds, section breaks and empty states.
- Grids of small squares that fill in like a cohort chart are the second motif.
- Keep art in two colors at most, plus the background.

### Video and motion art
- Hero video: muted, looping, under 20 seconds, under 4 MB, with a still poster frame. A dark overlay (navy to clear, top to middle) keeps text readable.
- Show product motion: numbers counting up, a line drawing itself, a chart splitting into segments.

### Photos
- Use rarely: About page and team pages only. Natural light, real people from the team, no stock photos of people pointing at screens.

### Never
- Stock illustrations, 3D blobs, robots, brains or glowing "AI" art.
- Mosaic's pictures, videos or frame sequences.

---

## 10. Data and charts

Charts are the product. They follow the strictest rules in this guide.

### Chart colors
| Series | Light background | Dark background |
|---|---|---|
| Main metric | `--pulse-blue` | `--sky` |
| Comparison period | `--sky` (dashed) | `--slate` (dashed) |
| Second series | `#5B6CF0` | `#7F8CFF` |
| Third series | `#8FA3C7` | `#8FA3C7` |
| Fourth series | `#C4CCDA` | `#4A5778` |
| Good movement (new, expansion, reactivation) | `--up` | `--up-on-dark` |
| Bad movement (churn, contraction) | `--down` | `--down-on-dark` |
| Gridlines | `--hover-gray` | `--slate` at 40% |
| Axis labels | `--muted` | `--gray` |

At most four series in one chart. More than four: switch to a table or let the person pick segments.

### Chart rules
- Lines 2px, square joins. Area fills at 8% opacity of the line color.
- Bars square, gap 25% of bar width.
- MRR movement bars: good movements stack above zero, bad ones below, net line on top in `--ink`.
- Y axis starts at zero for bars. Lines may start above zero only when the axis label says so.
- No 3D, no pie charts, no donut charts. Use a bar or a table.
- Every chart has a title, the date range, and the source ("From Stripe, updated 4 min ago").
- Hover shows one tooltip with the date, each value and the change. Click opens the customers behind the point.
- Cohort heat maps use one blue ramp from `--ice` (low) to `--pulse-blue` (high). Numbers sit inside each square.

### Number formatting
| Kind | Format | Example |
|---|---|---|
| Money under $10K | Full, no cents | $8,420 |
| Money $10K–$1M | One decimal and K | $48.2K |
| Money over $1M | Two decimals and M | $1.24M |
| Money in tables and exports | Full with cents | $48,213.50 |
| Percent | One decimal | 3.4% |
| Change | Sign and arrow-free | +12.3%, −2.1% |
| Change in money | Sign and value | +$1.2K |
| Counts | Commas | 1,284 customers |
| Dates | Mon D, YYYY | Nov 10, 2026 |
| Short dates in charts | Mon D or Mon 'YY | Nov 10, Nov '26 |
| Time ago | Plain | 4 min ago, yesterday |

- Use the real minus sign (−) for negatives.
- Currency follows the team's setting. Show the code when more than one currency appears ("€4,200 EUR").
- Never round in a way that changes a sign or hides a loss.

### Number cards
- Label (eyebrow) on top, big serif number, change below in the status color with the comparison period ("+4.2% vs. last 30 days").
- A tiny line chart (sparkline) at the bottom, 32px tall, no axes.

---

## 11. Motion

| Token | Value | Use |
|---|---|---|
| `--ease` | `cubic-bezier(0.65, 0.05, 0, 1)` | Everything that enters, leaves or moves |
| `--dur-reveal` | 0.735s | Section and card entrances on the site |
| `--dur-panel` | 0.4s | Header fade, sheets, dialogs |
| `--dur-hover` | 0.2s | Color changes on hover and press |
| `--dur-number` | 0.8s | Numbers counting to their value |

### What moves
- **Site entrances:** headlines and paragraphs slide up 16px from a mask and fade in, one after another, 80ms apart.
- **Header:** clear over the hero, turns `--navy-glass` with 20px blur after 10px of scroll, and the top banner slides up out of view.
- **Hero:** muted looping video or a scroll-driven frame sequence of the pulse line.
- **Charts:** lines draw left to right on first load only. Numbers count up on first load only.
- **App:** menus and dialogs fade and rise 4px. Rows don't animate when data refreshes; the changed value flashes `--ice` for 0.6s.

### Rules
- Motion answers something the person did, or shows a first load. Nothing loops in the app.
- No bounces, spins, shakes or pulsing dots (except the live dot in the feed).
- With reduced motion on: no video autoplay, no scroll sequences, no count-ups. Everything appears in place.
- Loading uses skeleton blocks in `--hover-gray`. No spinners.

---

## 12. App components

### Shell
- Sidebar: `--navy-deep`, 240px, logo at top, nav items in white at 14px, picked item on `--slate` with a 2px `--sky` bar on the left.
- Main area: white. Page header with a serif page title, one primary button on the right.
- Pulse's morning brief sits at the top of the dashboard in a `--paper` block with an eyebrow "PULSE" and a timestamp.

### Buttons
| Variant | Background | Text | Hover | Use |
|---|---|---|---|---|
| Primary | `--pulse-blue` | white | `--pulse-blue-hover` | The one main action on a screen |
| Secondary | white, 1px `--line` | `--ink` | `--hover-gray` | Other actions |
| Soft | `--ice` | `--pulse-blue` | `--sky` | Picked or in-place actions |
| Danger | white, 1px `--down` | `--down` | `--down-soft` | Delete and disconnect (always with a confirm dialog) |
| On dark: white | white | black | `--hover-gray` | Main action on navy |
| On dark: sky | `--sky` | black | `--ice` | Second action on navy |
| On dark: slate | `--slate` | white | `--navy` | Quiet action on navy |

- Height 36px in the app (32px small). Padding 0 16px. 8px corners. Sans 14px, weight 500.
- One primary button per screen. Secondary actions use icon buttons with tooltips where they fit.
- Disabled: 40% opacity, no hover.

### Inputs
- 36px tall, white, 1px `--line`, 8px corners, 12px side padding.
- Focus: 2px `--pulse-blue` ring. Error: 1px `--down` border with the error text under the field in `--down`.
- Labels above fields in 13px `--ink`. No placeholder-as-label.
- Dropdowns use the app's own `Select` and menus. Never the browser's `<select>`, `alert`, `confirm` or `prompt`.

### Tags and status
- 2px corners, 20px tall, 8px side padding, 12px text, weight 500.
- Soft fill with deep text: `--up-soft` and `--up`, `--down-soft` and `--down`, `--warn-soft` and `--warn`, `--ice` and `--pulse-blue` for neutral.
- Status words: Active, Trialing, Past due, Canceled, Recovered, Failed, Saved.

### Tables
- Header row: 12px eyebrow-style labels in `--muted`, no fill, 1px `--line` below.
- Rows 44px minimum, grow to fit wrapped text. 1px `--line` between rows. Hover row `--paper`. Picked row `--ice`.
- Numbers right-aligned in tabular figures. Text left-aligned.
- Bulk bar appears at the bottom in `--navy-deep` with white text when rows are picked.

### Cards
- Square, white with 1px `--line`, or `--paper` with no border. 24px padding.
- Card title in 16px sans weight 600, or an eyebrow plus a serif number for number cards.

### Tabs and segmented switches
- Tabs: text in `--muted`, picked tab in `--ink` with a 2px `--pulse-blue` underline.
- Segmented switch (for chart views): 8px corners, picked segment on `--ice` with `--pulse-blue` text.

### Dialogs, sheets and menus
- Dialog: white, 8px corners, the floating shadow, max 480px wide, title in 18px sans 600, buttons bottom right (primary last).
- Sheet: slides in from the right, 480px, square.
- Menus and tooltips open on the floating layer above the page and are never clipped by a card or table.

### Notices
- One short line at the bottom left with an action ("Couldn't sync Stripe. Retry"). Errors retry on their own before showing a notice.

### Empty states
- First screen of a tool: one pulse-line drawing, a short title ("Connect Stripe to see your MRR"), one line and the one button.
- Other empty lists: one line ("No cancels in this range") and nothing else.

### Pulse (the AI) in the app
- Pulse's words appear in `--paper` blocks with the eyebrow "PULSE."
- Every number Pulse states links to the rows behind it.
- When Pulse isn't sure, it says so in plain words ("4 of these 6 matches are unsure").

---

## 13. Voice and tone

### Voice (always the same)
We sound like a sharp finance friend: clear, exact and on your side. We say the number, say what it means and say what to do. We keep it short.

### Tone (changes with the moment)
| Moment | Tone | Example |
|---|---|---|
| Good news | Plain, no cheering | "MRR rose 4.2% this week. Two annual upgrades drove most of it." |
| Bad news | Calm and useful | "Churn was higher than usual yesterday. 4 of 6 cancels named price. See the cancels." |
| Errors | Short, says the fix | "Couldn't reach Stripe. We'll try again in 2 minutes." |
| Selling | Confident, specific | "See your real MRR in 60 seconds. Free up to $20K MRR." |
| Emails to a team's customers (Recover) | Polite, helpful, in the team's brand | "Your card didn't go through. Update it here to keep your account active." |
| Help and docs | Patient, step by step | "Open Settings, then Sources, then Connect Stripe." |

### Writing principles
1. **Number first.** Lead with what changed and by how much.
2. **Then why.** One sentence with the main cause.
3. **Then what to do.** One link or button.
4. **Short.** Sentences under 20 words. Paragraphs under 3 sentences in the app.
5. **Plain words.** Write for a busy reader at a 9th grade level.

### Words we use
| Use | Instead of |
|---|---|
| MRR, ARR, churn, NRR | Spelled out every time (spell out once on the site) |
| Customers | Users, accounts (for paying customers) |
| Cancels | Churned users |
| Failed payment | Involuntary churn (in app copy) |
| Win back | Recapture, salvage |
| Connect | Integrate |
| Set up | Configure |
| Update your card | Update payment method details |
| Pulse found | AI detected, our algorithm identified |

### Words we never use
Unlock, supercharge, leverage, seamless, robust, revolutionary, game-changing, cutting-edge, delve, empower, synergy, best-in-class, world-class, magic, effortless, ninja, rockstar, crush it, skyrocket, 10x (as hype), "quietly," "simply," "just" (as in "just click").

Also never: emoji, exclamation points in the app, negative words about customers ("deadbeats," "bad payers," "losers").

### Sample copy
- **Home headline:** "**Revenue you can trust,** every single time."
- **Home subline:** "PulseARR turns Stripe into clear numbers, explains every change and wins back failed payments."
- **Primary button:** "Connect Stripe"
- **Secondary button:** "See a live demo"
- **Pricing line:** "Free up to $20K MRR."
- **Recover headline:** "**Every failed card,** followed up for you."
- **Morning brief:** "MRR is $48.2K, up $640 since yesterday. One expansion from Acme ($400) and two new Starter plans. Nothing needs you today."
- **Alert:** "Failed payments hit $1.1K this week, 2.4x normal. Most are cards from one bank. Recover is following up."
- **Empty state:** "Connect Stripe to see your MRR."
- **Error:** "Stripe didn't answer. Trying again."

---

## 14. Writing rules

- Sentence case everywhere except eyebrows.
- Use numerals for all numbers in the app ("3 customers"). On the site, spell out one through nine in running text.
- Oxford comma: yes.
- Contractions: yes ("we'll," "didn't").
- Dashes: avoid em dashes. Use a period or a comma.
- Use "you" for the reader and "we" for PulseARR. Pulse speaks in plain statements and never says "I think."
- Dates: "Nov 10, 2026." Times: "9:40 AM ET." Ranges: "Nov 1–10."
- Links say where they go ("See the cancels"), never "click here."
- Buttons start with a verb: Connect, Export, Save, Send, Turn on.
- Headlines have no period. Sentences under them do.
- No help text or cost notes inside working screens. Labels, buttons and real errors only. Explain things once on a tool's first screen.

---

## 15. Website

### Page list
Home, Pricing, Recover, Cancel Flow, Pulse, Revenue by Source, Open Pages, Integrations, Compare (one per rival), Metrics glossary (one per metric), Calculators, Security, About, Changelog, Blog, Login.

### Home page outline
1. **Top banner** (`--navy-deep`): one short news line and "Learn more."
2. **Hero** (navy, video or pulse-line art): H1, one line, "Connect Stripe" and "See a live demo," then a slow strip of customer logos in one color.
3. **Feature rows** (white, eyebrow "PLATFORM," H2 "**Accuracy, answers** and money back"): three rows, each with a two-tone H3, two lines and an arrow-chip link.
   - "**Numbers you can trust,** every single time" (the metrics engine)
   - "**Every morning,** what moved and why" (Pulse)
   - "**Every failed card,** followed up for you" (Recover)
4. **Product panels** (navy): Recover, Cancel Flow, Revenue by Source, each a full-width panel with a square arrow button.
5. **Quotes** (white): a slider of customer quotes in the serif at quote size, with role and company size.
6. **Trust row** (navy): "Read-only Stripe access," "Card numbers never touch our servers," "Your data, deletable any time."
7. **Link panels** (white): "**Free up to** $20K MRR" (`--paper`) and "**See it live** on a demo account" (`--ice`).
8. **By the numbers:** two number cards, for example MRR tracked and failed payments won back (real numbers only, once we have them).
9. **Call to action:** "Connect Stripe in 60 seconds."
10. **Footer** (glass): Product, Compare, Resources, Company, Legal, Social.

### Pricing page
- Four square cards side by side (Free, Starter, Growth, Scale), Growth marked with an eyebrow "MOST TEAMS."
- MRR range under each price. Feature list with checks in `--pulse-blue`.
- A plain comparison row: "Baremetrics Launch plus Recover and Cancellation Insights: $333 a month. PulseARR Starter: $29."

### Compare pages
- Title: "PulseARR vs. Baremetrics." Short, fair, with a table of plans and features and a date ("Checked Nov 10, 2026"). Never insult the other product.

### SEO and AI search
- One H1 per page. Titles under 60 characters, descriptions under 155.
- Every metric glossary page has the formula, a worked example and a free calculator.
- Track PulseARR's visibility in ChatGPT, Perplexity and Google AI answers through Arrowsterr from day one.

---

## 16. Email

### PulseARR's own emails (morning brief, reports, alerts)
- Width 600px. White body, `--navy-deep` header strip with the reverse logo.
- Eyebrow, then one serif number, then 2–4 short lines, then one button.
- Plain-text version always included.
- Subject lines: number first, under 50 characters. "MRR $48.2K, up 1.3% this week."
- From: "Pulse at PulseARR <pulse@pulsearr.com>."

### Recover and cancel emails (sent for a team, to their customers)
- Wear the team's brand: their logo, their color, their name in "From." PulseARR appears only as a small "Sent with PulseARR" line, which paid teams can turn off.
- Polite and short. Never blame the customer. One button: "Update card."
- Default sequence tone moves from helpful ("Your card didn't go through") to clear ("Your account pauses in 3 days") and never threatening.

---

## 17. Social, ads and decks

### Social posts
| Place | Size |
|---|---|
| X and LinkedIn image | 1200 × 675 |
| LinkedIn square | 1200 × 1200 |
| Instagram and LinkedIn carousel | 1080 × 1350 |
| Open Graph image | 1200 × 630 |
| Product Hunt gallery | 1270 × 760 |

- Navy background, one two-tone headline in the serif, one product crop or one number card, logo bottom left.
- Build-in-public posts show our own Open page numbers with the date.
- No emoji, no hashtag walls (two at most).

### Ads
- One claim, one number, one button. "See your real MRR in 60 seconds. Free up to $20K MRR."
- Comparison ads may name Baremetrics only with a dated, true price fact.

### Decks
- 16:9. Title slides on `--navy-deep` with a two-tone serif title. Content slides on white.
- One idea per slide. Numbers as big serif figures with a small label.
- Charts follow section 10 exactly.
- Footer: logo bottom left, page number bottom right, nothing else.

### Open Graph and Open pages
- Each public revenue page gets an auto image: company name, MRR, change, and "Verified by PulseARR" with the date.

---

## 18. Accessibility

- Text meets WCAG AA at minimum (4.5:1 for body, 3:1 for large text). The contrast table in section 4 lists safe pairs.
- Never show meaning with color alone. Every status color comes with a word or a sign (+ or −).
- Focus is always visible. Every action works with the keyboard.
- Every icon button and chart has an accessible name. Charts have a table view.
- Touch targets at least 40px on phones.
- Reduced motion is respected everywhere (section 11).
- Videos have no sound or carry captions.

---

## 19. Checklists

### Before a screen ships
- [ ] Only tokens, no raw hex codes
- [ ] One primary button
- [ ] Sentence case, no help text, no emoji
- [ ] Numbers use tabular figures and section 10 formats
- [ ] Charts have a title, a range and a source
- [ ] No cut-off text at 320px wide
- [ ] Keyboard and screen reader check done
- [ ] Reduced motion check done

### Before a page or post goes out
- [ ] Two-tone headline used at most once per section
- [ ] Blue under about 5% of the area
- [ ] Every claim is true and dated where it can change
- [ ] No Mosaic assets or wording
- [ ] Logo has its clear space
- [ ] Alt text on every image

### Do and don't
| Do | Don't |
|---|---|
| Lead with the number | Open with a setup sentence |
| Square cards on white with navy for depth | Rounded cards with shadows |
| One blue accent | Several bright colors |
| Serif for headlines and big numbers | Serif in body text or tables |
| Calm, slow motion | Bounces, spinners, looping effects in the app |
| Real product screens | Stock art or glowing AI pictures |
| Say what to do next | Leave the reader with only a chart |

---

## 20. Files and assets

| File | Holds |
|---|---|
| `docs/brand.md` | This guide |
| `docs/brand-tokens.css` | Colors, type, spacing, shape and motion tokens |
| `public/brand/` (to make) | Logo files: SVG for each color version, PNG at 1x and 2x, favicon set, app icon |
| `public/brand/social/` (to make) | Social, Open Graph and deck templates |

### Still to make
1. Logo and mark from the brief in section 3.
2. Pulse-line art set (hero, section breaks, empty states).
3. Social and deck templates.
4. A GT Canon and GT Standard license, or a final decision to stay on Newsreader and Inter.
