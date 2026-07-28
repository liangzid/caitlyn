/**
 * CAITLYN TUI Theme — ANSI helpers, select-list theme, and small utilities
 * shared between the TUI class, overlay builders, and command handlers.
 */

// ── ANSI Helpers ──────────────────────────────────────────────────

export const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  bgRed:   "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgCyan:  "\x1b[46m",
} as const;

// ── Default SelectList Theme ──────────────────────────────────────

export const selectListTheme = {
  selectedPrefix: (text: string) => `${C.cyan}${text}${C.reset}`,
  selectedText: (text: string) => `${C.bold}${text}${C.reset}`,
  description: (text: string) => `${C.dim}${text}${C.reset}`,
  scrollInfo: (text: string) => `${C.dim}${text}${C.reset}`,
  noMatch: (text: string) => `${C.dim}${text}${C.reset}`,
};

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
