/**
 * The in-tool release page stays dated and newest-first.
 */
import { describe, expect, it } from "vitest";
import { RELEASE_NOTES, formatReleaseNotes } from "../src/releases.js";

describe("release notes", () => {
  it("lists shipped versions newest first, with calendar dates", () => {
    expect(RELEASE_NOTES[0]?.version).toBe("0.6.0");
    const dates = RELEASE_NOTES.map((note) => note.date);
    expect(dates).toEqual([...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
    for (const note of RELEASE_NOTES) {
      expect(note.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(note.summary.endsWith("!")).toBe(true);
    }
  });

  it("prints the date before the version", () => {
    const text = formatReleaseNotes();
    expect(text.startsWith("What's New")).toBe(true);
    expect(text).toContain("2026-10-19  0.6.0");
    expect(text.indexOf("2026-10-19  0.6.0")).toBeLessThan(text.indexOf("2026-08-28  0.2.0"));
  });
});
