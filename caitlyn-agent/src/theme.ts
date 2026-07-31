/**
 * CAITLYN TUI Theme — "Bioluminescent Defense OS"
 *
 * Design language: dark glass panels over a deep-indigo backdrop, with a
 * cyan → violet → magenta bioluminescent gradient as the signature accent.
 * All colors are xterm-256 palette indices (safe on any 256-color terminal).
 *
 * The palette and helpers here are the single source of truth for every
 * component: footer, overlays, dashboards, scan banners, and logos.
 */

// ── ANSI Escapes ──────────────────────────────────────────────────

import { visibleWidth } from "@earendil-works/pi-tui";

/** Basic SGR codes — kept for one-off styling and back-compat. */
export const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  italic:  "\x1b[3m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  bgRed:   "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow:"\x1b[43m",
  bgBlue:  "\x1b[44m",
  bgMagenta:"\x1b[45m",
  bgCyan:  "\x1b[46m",
} as const;

// ── Palette (xterm-256) ───────────────────────────────────────────

/**
 * Named palette. Every visual decision in the TUI should reference these
 * tokens instead of raw indices, so the whole look can be retuned here.
 */
export const PAL = {
  // Base surfaces
  void:     234, // deep backdrop behind panels
  panel:    236, // glass panel fill
  panelHi:  238, // raised panel / header fill
  panelLo:  235, // recessed panel fill
  border:   240, // quiet panel border
  borderHi: 244, // emphasized border

  // Text
  text:     252, // primary text
  dim:      245, // secondary text
  faint:    240, // tertiary / decorative text
  ghost:    231, // bright white for on-dark emphasis

  // Signature gradient (cyan → violet → magenta)
  cyan:     45,
  cyanDeep: 38,
  teal:     79,
  violet:   141,
  violetDeep: 99,
  magenta:  205,
  pink:     213,

  // Semantic
  ok:       114, // benign / healthy
  okDeep:   78,
  warn:     214, // suspicious
  warnDeep: 172,
  danger:   203, // malicious
  dangerDeep: 160,
  info:     81,  // neutral informational accent

  // Backgrounds for badges (muted, dark enough for white text)
  okBg:     23,
  warnBg:   58,
  dangerBg: 88,
  cyanBg:   24,
  violetBg: 60,
  magentaBg: 96,
  grayBg:   239,
} as const;

// ── Color Helpers ─────────────────────────────────────────────────

/** 256-color foreground. */
export function fg(n: number): string { return `\x1b[38;5;${n}m`; }

/** 256-color background. */
export function bg(n: number): string { return `\x1b[48;5;${n}m`; }

/** Compose fg + bg + bold in one string. */
export function paint(text: string, f: number, b?: number, bold = false): string {
  return `${fg(f)}${b !== undefined ? bg(b) : ""}${bold ? C.bold : ""}${text}${C.reset}`;
}

/** Padded pill badge: `  LABEL  ` on a colored background. */
export function badge(text: string, f: number, b: number, bold = true): string {
  return paint(` ${text} `, f, b, bold);
}

/**
 * Vertical gradient across lines. Each line of `text` is colored with the
 * palette color whose index is interpolated along the `stops` ramp.
 */
export function gradLines(text: string, stops: readonly number[], bold = true): string {
  const lines = text.split("\n");
  if (stops.length === 0) return text;
  return lines
    .map((line, i) => `${fg(gradColorAt(stops, lines.length <= 1 ? 0 : i / (lines.length - 1)))}${bold ? C.bold : ""}${line}${C.reset}`)
    .join("\n");
}

/** Sample the gradient ramp at position `t` (0..1) — returns a palette index. */
export function gradColorAt(stops: readonly number[], t: number): number {
  if (stops.length === 0) return PAL.cyan;
  if (stops.length === 1) return stops[0];
  const pos = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const lo = Math.min(stops.length - 1, Math.floor(pos));
  const hi = Math.min(stops.length - 1, lo + 1);
  const frac = pos - lo;
  return Math.round(stops[lo] + (stops[hi] - stops[lo]) * frac);
}

/** One-line horizontal gradient over a single string. */
export function gradText(text: string, from: number, to: number, bold = true): string {
  if (text.length === 0) return text;
  const chars = [...text];
  return chars
    .map((ch, i) => {
      const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
      const c = Math.round(from + (to - from) * t);
      return `${fg(c)}${bold ? C.bold : ""}${ch}${C.reset}`;
    })
    .join("");
}

/** `▰▰▱▱`-style gauge. `ratio` clamped to [0,1]; filled cells use `f`, empty use `faint`. */
export function bar(ratio: number, width: number, f: number, emptyF = PAL.faint): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const full = "▰".repeat(filled);
  const empty = "▱".repeat(Math.max(0, width - filled));
  return `${fg(f)}${full}${C.reset}${fg(emptyF)}${empty}${C.reset}`;
}

/** Keycap hint like `[j]` — used in overlay nav footers. */
export function keycap(text: string): string {
  return paint(` ${text} `, PAL.ghost, PAL.grayBg, true);
}

// ── Semantic Presets ──────────────────────────────────────────────

/** Verdict → { icon, fg, bg } used by scan results and history rows. */
export function verdictMeta(verdict: string): { icon: string; fg: number; bg: number } {
  switch (verdict) {
    case "malicious": return { icon: "🚨", fg: PAL.ghost, bg: PAL.dangerBg };
    case "suspicious": return { icon: "⚠", fg: PAL.ghost, bg: PAL.warnBg };
    default: return { icon: "✓", fg: PAL.ghost, bg: PAL.okBg };
  }
}

/** Antibody category → accent color. */
export function categoryColor(category: string): number {
  switch (category) {
    case "injection": return PAL.cyan;
    case "jailbreak": return PAL.magenta;
    case "poisoning": return PAL.warn;
    case "exfiltration": return PAL.violet;
    default: return PAL.dim;
  }
}

/** Detection tier → accent color. */
export function tierColor(tier: number): number {
  switch (tier) {
    case 0: return PAL.cyan;
    case 1: return PAL.violet;
    default: return PAL.magenta;
  }
}

// ── SelectList Theme ──────────────────────────────────────────────

/** Gradient-flavored selection cursor + bright selected text. */
export const selectListTheme = {
  selectedPrefix: (text: string) => `${fg(PAL.magenta)}${C.bold}${text}${C.reset}`,
  selectedText: (text: string) =>
    `${C.bold}${fg(PAL.ghost)}${text}${C.reset}`,
  description: (text: string) => `${fg(PAL.faint)}${text}${C.reset}`,
  scrollInfo: (text: string) => `${fg(PAL.faint)}${text}${C.reset}`,
  noMatch: (text: string) => `${fg(PAL.faint)}${text}${C.reset}`,
};

// ── Panel Primitive ───────────────────────────────────────────────

/**
 * Draw a glass-panel header line: `═◈ TITLE ═══════` with a gradient
 * title and a quiet rule. Used by overlays and section banners.
 */
export function panelHeader(title: string, width: number, icon = "◈"): string {
  const head = `${paint(` ${icon} `, PAL.cyan, PAL.cyanBg, true)} ${gradText(title, PAL.cyan, PAL.violet)} `;
  const headWidth = visibleWidth(head);
  const rule = "─".repeat(Math.max(1, width - headWidth));
  return `${head}${fg(PAL.border)}${rule}${C.reset}`;
}

// ── Defense Quotes ─────────────────────────────────────────────────

/**
 * Epigrams on attack and defense, shown at random on TUI startup.
 */
export const DEFENSE_QUOTES: Array<{ text: string; author: string }> = [
  { text: "Trust, but verify.", author: "proverb, popularized by Ronald Reagan" },
  { text: "The best defense is a good offense.", author: "proverb" },
  { text: "Security is a process, not a product.", author: "Bruce Schneier" },
  { text: "Amateurs hack systems, professionals hack people.", author: "Bruce Schneier" },
  { text: "Never trust user input.", author: "folklore" },
  { text: "Attack is the secret of defense; defense is the planning of an attack.", author: "Sun Tzu" },
  { text: "A chain is only as strong as its weakest link.", author: "proverb" },
  { text: "You can't trust code that you did not totally create yourself.", author: "Ken Thompson" },
  { text: "Eternal vigilance is the price of liberty.", author: "Wendell Phillips" },
  { text: "The only truly secure system is powered off, unplugged, locked in a safe, and buried in a concrete bunker.", author: "Gene Spafford" },
  { text: "Know thy enemy and know yourself; in a hundred battles you will never be in peril.", author: "Sun Tzu" },
  { text: "The hammer of the defense is forged from the anvil of the attack.", author: "CAITLYN doctrine" },
];

/** Pick a random defense quote for the startup banner. */
export function randomDefenseQuote(): { text: string; author: string } {
  return DEFENSE_QUOTES[Math.floor(Math.random() * DEFENSE_QUOTES.length)];
}

// ── Token Estimation ──────────────────────────────────────────────

/** Rough token count (4 chars approx 1 token for English, 1 char approx 1 token for CJK). */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp && cp > 0x2000) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
    if (cp && cp > 0xffff) i++;
  }
  return Math.ceil(tokens);
}

// ── LLM Error Translation ─────────────────────────────────────────

export function translateLlmError(err: Error): string {
  const msg = err.message;
  if (msg.includes("401") || msg.includes("Unauthorized")) return "Authentication failed. Check your API key.";
  if (msg.includes("429") || msg.includes("rate")) return "Rate limited. Wait and try again.";
  if (msg.includes("context_length") || msg.includes("too long")) return "Input too long. Try /compact or use a shorter message.";
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) return "Cannot reach LLM provider. Check your network.";
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) return "LLM request timed out. Try again.";
  if (msg.includes("insufficient_quota")) return "API quota exceeded. Check your billing.";
  return msg.length > 200 ? msg.slice(0, 197) + "..." : msg;
}
