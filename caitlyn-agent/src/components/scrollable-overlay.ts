/**
 * Scrollable Overlay — wraps content in a box with keyboard scrolling.
 *
 * Supports: j/k, ↓/↑, Space/Shift+Space, PageDown/PageUp, Home/End
 */
import {
  Box,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import { C } from "../theme.js";

const overlayBg = (text: string) => `\x1b[48;5;236m\x1b[37m${text}\x1b[0m`;

export class ScrollableBox implements Component {
  children: Component[] = [];
  private lines: string[] = [];
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

    const header = `${C.bold}${C.cyan}${this.title}${C.reset}`;
    const hasMoreAbove = this.scrollOffset > 0;
    const hasMoreBelow = this.scrollOffset + this.visibleLines < this.lines.length;

    const nav = [
      hasMoreAbove ? `${C.dim}▲  scroll: j/k ↑/↓  PgUp/PgDn  q/Esc/Ctrl+C to close${C.reset}`
        : hasMoreBelow ? `${C.dim}▼  scroll: j/k ↑/↓  PgUp/PgDn  q/Esc/Ctrl+C to close${C.reset}`
        : `${C.dim}scroll: j/k ↑/↓  q/Esc/Ctrl+C to close${C.reset}`,
    ];

    const result = [header, "", ...visible, "", ...nav];
    const innerWidth = Math.max(1, width - 2);
    return result.map((line) => overlayBg(line.padEnd(innerWidth, " ")));
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
