/**
 * The SwayQ skin for guest-facing pages (booking, confirm, confirmation,
 * manage). It is a token override on top of the upstream stylesheet, not a
 * fork of it: upstream's `pageCss()` is unchanged, so a rebase onto a newer
 * Punctual never conflicts here.
 *
 * Values are the `[data-brand="swayq-2026"]` light tokens from
 * swayq/apps/web/app/assets/css/main.css (`--ui-*`), copied as literals:
 *   page #f8f7f5 · surface #ffffff · sunken #eeece7 · line #d9d9d6
 *   ink #0e0e0e · ink-soft #2e2e2e · muted #4a4a4a
 *   Learning Lime #dbed72 (wash #f2f7d8) with carbon ink on it · error #a32116
 *
 * Lime is a FILL behind carbon ink, never ink itself (1.2:1 on the page), and
 * it is used sparingly: the primary button, the chosen day, a pressed slot.
 * #0e0e0e on #dbed72 is 16.4:1; muted #4a4a4a on page #f8f7f5 is 8.1:1.
 *
 * Guest pages are light only. The brand has a dark mode, but a booking page
 * embedded in someone else's light site must not flip with the guest's OS.
 *
 * The wordmark is `swayq.` lowercase, monochrome: the period is the SAME
 * colour as the letters (never lime), so `.pu-mark span` inherits.
 */

import { BASE_CSS, TOKENS } from './styles.js'

export const SWAYQ_LIME = '#dbed72'
export const SWAYQ_LIME_HOVER = '#cfe45a'
export const SWAYQ_INK = '#0e0e0e'
export const SWAYQ_PAGE = '#f8f7f5'

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'

/** Self-hosted OFL files under assets/fonts/ (see OFL-Poppins.txt). Same origin, so no token page ever calls a font CDN. */
export const SWAYQ_FONT_FILES = ['poppins-400.woff2', 'poppins-500.woff2', 'poppins-600.woff2'] as const

export const SWAYQ_FONT_FACES = `
@font-face{font-family:"Poppins";font-style:normal;font-weight:400;font-display:optional;src:url(/fonts/poppins-400.woff2) format("woff2");unicode-range:${LATIN}}
@font-face{font-family:"Poppins";font-style:normal;font-weight:500;font-display:optional;src:url(/fonts/poppins-500.woff2) format("woff2");unicode-range:${LATIN}}
@font-face{font-family:"Poppins";font-style:normal;font-weight:600;font-display:optional;src:url(/fonts/poppins-600.woff2) format("woff2");unicode-range:${LATIN}}
`

// `:root:root:root` (specificity 0,3,0) beats upstream's dark-mode blocks
// (`:root:not([data-theme=light])` and `:root[data-theme=dark]`, both 0,2,0)
// without !important, so the skin holds whatever the guest's OS prefers.
export const SWAYQ_SKIN_CSS = `
:root:root:root{
  color-scheme:light;
  --pu-ink-950:#0e0e0e; --pu-ink-900:#2e2e2e; --pu-ink-700:#2e2e2e; --pu-ink-500:#4a4a4a;
  --pu-paper:#f8f7f5; --pu-paper-dim:#eeece7; --pu-line:#d9d9d6;
  --pu-green-700:#0e0e0e; --pu-green-800:#0e0e0e;
  --pu-green-fill:#dbed72; --pu-green-fill-hover:#cfe45a; --pu-green-tint:#f2f7d8;
  --pu-signal:#0e0e0e;
  --pu-danger:#a32116; --pu-danger-800:#7f1a11; --pu-danger-text:#a32116; --pu-danger-tint:#fbeae8;
  --pu-warn-text:#7a4a05; --pu-warn-tint:#fcefd9;
  --pu-font-display:"Poppins",system-ui,-apple-system,"Segoe UI",sans-serif;
  --pu-font-ui:"Poppins",system-ui,-apple-system,"Segoe UI",sans-serif;
  --pu-font-mono:"Poppins",system-ui,-apple-system,"Segoe UI",sans-serif;
  --pu-radius:12px; --pu-radius-lg:18px;
  --pu-shadow-sm:0 1px 2px rgba(14,14,14,.06);
  --pu-surface-canvas:#f8f7f5; --pu-surface-raised:#ffffff; --pu-surface-sunken:#eeece7;
  --pu-surface-overlay:rgba(14,14,14,.45);
  --pu-text-primary:#0e0e0e; --pu-text-secondary:#4a4a4a;
  --pu-text-muted:rgba(74,74,74,.8); --pu-text-disabled:rgba(74,74,74,.5);
  --pu-text-on-accent:#0e0e0e;
  --pu-border-subtle:#d9d9d6; --pu-border-strong:#4a4a4a; --pu-border-focus:#0e0e0e;
  --pu-field-border:#cbc7b7; --pu-url-bg:#eeece7;
  --pu-status-success:#0e0e0e; --pu-status-success-bg:#f2f7d8;
  --pu-slot-hover-bg:#f2f7d8; --pu-slot-hover-border:#0e0e0e;
  --pu-slot-selected-bg:#dbed72; --pu-slot-selected-border:#0e0e0e;
  --pu-ring:0 0 0 3px rgba(14,14,14,.18);
}
body{font-weight:400;letter-spacing:0}
h1,h2,h3{font-weight:600;letter-spacing:-.01em}
a{text-decoration-thickness:1px;text-underline-offset:.18em}
time,.pu-time{font-weight:500}
.pu-muted{font-weight:400}

/* Lime is a fill behind carbon ink. The primary button... */
.pu-btn{color:#0e0e0e;border-color:#0e0e0e}
.pu-btn:hover{color:#0e0e0e;border-color:#0e0e0e}
.pu-btn-ghost{background:none;color:#0e0e0e;border-color:#cbc7b7}
.pu-btn-ghost:hover{background:#eeece7;border-color:#0e0e0e}
.pu-btn-danger{background:#a32116;border-color:#a32116;color:#ffffff}
.pu-btn-danger:hover{background:#7f1a11;border-color:#7f1a11;color:#ffffff}
/* ...the chosen day, and a pressed slot. Everything else stays carbon on sand. */
.pu-day[data-has-slots="1"]{background:#ffffff;border-color:#d9d9d6;color:#0e0e0e}
.pu-day:hover[data-has-slots="1"]{background:#f2f7d8;border-color:#0e0e0e;color:#0e0e0e}
.pu-day[aria-selected="true"],.pu-day[aria-selected="true"]:hover{background:#dbed72;border-color:#0e0e0e;color:#0e0e0e}
.pu-day[aria-current="date"]{box-shadow:inset 0 0 0 2px #0e0e0e}
.pu-slot-available{background:#ffffff;border-color:#cbc7b7}
.pu-slot-available:hover{background:#f2f7d8;border-color:#0e0e0e}
.pu-slot-available:active{background:#dbed72;border-color:#0e0e0e;color:#0e0e0e}
.pu-dot,.pu-slot-chosen .pu-dot-lg{background:#0e0e0e}
.pu-slot-chosen{background:#f2f7d8}
.pu-badge{background:#dbed72;color:#0e0e0e}
::selection{background:#dbed72;color:#0e0e0e}
.pu-confirm-icon .pu-ring-dot{fill:#0e0e0e}
.pu-confirm-icon .pu-ring-arc{stroke:#0e0e0e}

/* Wordmark: lowercase, monochrome, the period the same colour as the letters. */
.pu-mark{font-family:var(--pu-font-display);font-weight:600;letter-spacing:-.03em;color:#0e0e0e;text-decoration:none}
.pu-mark span{color:inherit}
.pu-topbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:0 0 1.5rem}
.pu-topbar .pu-mark{font-size:1.375rem;line-height:1}
.pu-lang{display:inline-flex;gap:.25rem;align-items:center;font-size:.8125rem;font-weight:500}
.pu-lang a,.pu-lang span{padding:.3rem .55rem;border-radius:99px;text-decoration:none;color:#4a4a4a;border:1px solid transparent}
.pu-lang a:hover{border-color:#0e0e0e;color:#0e0e0e}
.pu-lang [aria-current="true"]{background:#0e0e0e;color:#f8f7f5}
.pu-foot .pu-mark{font-size:1rem}
.pu-tz-note{font-size:.8125rem;margin:.25rem 0 0}
.pu-turnstile{margin:1.25rem 0 0;min-height:65px}
`

/** Fonts + tokens + base + skin, in that order, for guest pages. */
export function guestPageCss(): string {
  return SWAYQ_FONT_FACES + TOKENS + BASE_CSS + SWAYQ_SKIN_CSS
}
