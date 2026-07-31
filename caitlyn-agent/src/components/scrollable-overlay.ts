/**
 * Scrollable Overlay — glass panel with gradient frame and keyboard scrolling.
 *
 * Supports: j/k, ↓/↑, Space/Shift+Space, PageDown/PageUp, Home/End.
 * Renders a right-edge scrollbar thumb and keycap-styled nav hints.
 */
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { C, PAL, fg, bg, keycap, gradLines, gradColorAt, panelHeader } from "../theme.js";

const PANEL_BG = PAL.panelLo;
const glass = (text: string) => `${bg(PANEL_BG)}${text}${C.reset}`;

/** Gradient frame colors for the panel border. */
const FRAME_RAMP = [PAL.cyan, PAL.teal, PAL.violet, PAL.magenta] as const;

/** Pad an ANSI-colored string to an exact display width. */
function padAnsi(text: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(text));
  return text + " ".repeat(pad);
}

/** Top border: ╭──(gradient)──╮  */
function frameTop(innerWidth: number): string {
  return glass(`${fg(gradColorAt(FRAME_RAMP, 0))}╭${C.reset}${gradLines("─".repeat(innerWidth), FRAME_RAMP, false)}${fg(gradColorAt(FRAME_RAMP, 1))}╮${C.reset}`);
}

/** Bottom border: ╰──(gradient)──╯ */
function frameBottom(innerWidth: number): string {
  return glass(`${fg(gradColorAt(FRAME_RAMP, 1))}╰${C.reset}${gradLines("─".repeat(innerWidth), FRAME_RAMP, false)}${fg(gradColorAt(FRAME_RAMP, 0))}╯${C.reset}`);
}

export class ScrollableBox implements Component {
  children: Component[] = [];
  private lines: string[];
  private title: string;
  private visibleLines: number;
  private scrollOffset = 0;

  constructor(title: string, lines: string[], visibleLines = 15) {
    this.title = title;
    this.lines = lines;
    this.visibleLines = visibleLines;
  }

  render(width: number): string[] {
    const maxOffset = Math.max(0, this.lines.length - this.visibleLines);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));

    const visible = this.lines.slice(this.scrollOffset, this.scrollOffset + this.visibleLines);
    const innerWidth = Math.max(1, width - 2);

    // Right-edge scrollbar thumb
    const thumbSize = Math.max(1, Math.round((this.visibleLines / Math.max(1, this.lines.length)) * this.visibleLines));
    const thumbStart = maxOffset === 0
      ? 0
      : Math.round((this.scrollOffset / maxOffset) * Math.max(0, this.visibleLines - thumbSize));
    const scrollChar = (i: number): string =>
      i >= thumbStart && i < thumbStart + thumbSize
        ? `${fg(PAL.cyan)}▐${C.reset}`
        : `${fg(PAL.panelHi)}▐${C.reset}`;

    const hasMoreAbove = this.scrollOffset > 0;
    const hasMoreBelow = this.scrollOffset + this.visibleLines < this.lines.length;

    const navHints = `${keycap("j")} ${keycap("k")} ${keycap("PgUp")} ${keycap("PgDn")} · ${keycap("q")}/${keycap("Esc")} close`;
    const navHint = hasMoreAbove
      ? `${fg(PAL.faint)}▲ ${navHints}${C.reset}`
      : hasMoreBelow
        ? `${fg(PAL.faint)}▼ ${navHints}${C.reset}`
        : `${fg(PAL.faint)}${navHints}${C.reset}`;

    const body: string[] = [];
    body.push(frameTop(innerWidth));
    body.push(glass(padAnsi(panelHeader(this.title, innerWidth, "◈"), innerWidth)));
    body.push(glass(" ".repeat(innerWidth)));
    for (let i = 0; i < this.visibleLines; i++) {
      const content = visible[i] ?? "";
      const padded = padAnsi(content, innerWidth - 1);
      body.push(glass(`${padded}${scrollChar(i)}`));
    }
    body.push(glass(" ".repeat(innerWidth)));
    body.push(glass(padAnsi(navHint, innerWidth)));
    body.push(frameBottom(innerWidth));

    return body;
  }

  handleInput(data: string): void {
    const pageSize = Math.max(1, this.visibleLines - 2);

    if (data === "j" || data === "\x1b[B") {
      this.scrollOffset = Math.min(this.scrollOffset + 1, this.lines.length - this.visibleLines);
    } else if (data === "k" || data === "\x1b[A") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (data === " " || data === "\x1b[6~") {
      this.scrollOffset = Math.min(this.scrollOffset + pageSize, this.lines.length - this.visibleLines);
    } else if (data === "\x1b[5~") {
      this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
    } else if (data === "\x1b[1~" || data === "g") {
      this.scrollOffset = 0;
    } else if (data === "\x1b[4~" || data === "G") {
      this.scrollOffset = Math.max(0, this.lines.length - this.visibleLines);
    }

    this.invalidate?.();
  }

  invalidate(): void {
    /* no-op — TUI calls this after handleInput */
  }
}
