/**
 * Shipped release notes, newest date first.
 *
 * README What's New and `caitlyn releases` both read this list.
 * KEYPOINT-REVIEW: a new tag needs a new entry here before the release commit,
 * or the in-tool page and the README drift apart.
 */

export interface ReleaseNote {
  /** Calendar date of the release, YYYY-MM-DD. */
  date: string;
  /** Package version, without a leading v. */
  version: string;
  /** One or two sentences a user can read without the commit log. */
  summary: string;
}

/** Published releases. Keep the newest entry at index 0. */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    date: "2026-10-07",
    version: "0.5.2",
    summary: "What's New is a dated list. `caitlyn releases` and /releases open the same page inside the tool.",
  },
  {
    date: "2026-10-07",
    version: "0.5.1",
    summary: "On Windows, skill builds and the OpenClaw, OpenCode, and pi hooks now start .cmd shims with a shell. Chinese instruction signatures from the first outside pull request were tightened so ordinary work sentences stay benign.",
  },
  {
    date: "2026-10-07",
    version: "0.5.0",
    summary: "Privacy protection is available and off by default. Setup asks before masking. standard hides credentials and format-dependent identifiers. strict also perturbs labeled ages and amounts.",
  },
  {
    date: "2026-09-24",
    version: "0.4.2",
    summary: "The npm package counts the skills/ directory, so a fresh install is no longer empty.",
  },
  {
    date: "2026-09-24",
    version: "0.4.1",
    summary: "TypeScript compiles again after the rename. v0.4.0 had been tagged, and npm publish had stopped on the leftover name.",
  },
  {
    date: "2026-09-24",
    version: "0.4.0",
    summary: "The immune metaphor left the project. Skills live in skills/, attacks live in attacks/, and caitlyn synthesize replaced caitlyn vaccinate.",
  },
  {
    date: "2026-09-02",
    version: "0.3.1",
    summary: "The terminal logo's right edge lines up, and paper credits moved into Acknowledgments.",
  },
  {
    date: "2026-08-31",
    version: "0.3.0",
    summary: "caitlyn setup walks through provider, API key, detected agents, and detection depth. Nothing is written until the final confirmation.",
  },
  {
    date: "2026-08-28",
    version: "0.2.0",
    summary: "The defense library is on npm: active skills, research entries, and the papers named in the README.",
  },
];

/**
 * Plain-text release page for the CLI and the terminal overlay.
 */
export function formatReleaseNotes(): string {
  const blocks = RELEASE_NOTES.map((note) => `${note.date}  ${note.version}\n  ${note.summary}`);
  return ["What's New", ...blocks].join("\n\n");
}
