/**
 * CAITLYN Agent — Simple YAML Parser
 *
 * Minimal YAML parser for config files. No external dependencies needed.
 * Supported: key-value pairs, nested objects, lists (as arrays),
 * multi-line strings (|, >), quoted strings, numbers, booleans, null, comments.
 */

/**
 * Coerce a raw string value to its appropriate JavaScript type.
 * Handles numbers, booleans, null, and quoted strings.
 */
export function coerceValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const v = raw.trim();
  if (v === '""' || v === "''") return "";
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "" || v === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  return v;
}

// ── Token types ──────────────────────────────────────────────────────

type TokenKind = "key-scalar" | "key-open" | "list-scalar" | "list-object";

/** Sentinel: value signals "this key opens a nested mapping" (key: with empty value). */
const OPEN_MAPPING = Symbol("open-mapping");

interface Token {
  indent: number;
  kind: TokenKind;
  key: string;
  /** Coerced scalar value; OPEN_MAPPING for key-open and list-object when no inline value. */
  value: unknown;
}

// ── Stack frame ──────────────────────────────────────────────────────

interface Frame {
  indent: number;
  container: Record<string, unknown>;
  key: string;
}

// ── Phase 1: tokenize ────────────────────────────────────────────────

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const rawLines = text.split("\n");

  // Multi-line block state
  let mlKey: string | null = null;
  let mlIndent = 0;
  let mlBuf = "";
  let mlStyle: "|" | ">" | null = null;
  let mlBaseIndent = -1; // -1 = unknown, set by first content line

  for (const rawLine of rawLines) {
    const trimmedStart = rawLine.trimStart();
    const indent = rawLine.length - trimmedStart.length;
    const trimmed = trimmedStart;

    // ── Inside a multi-line block ──
    if (mlKey !== null) {
      if (mlBaseIndent < 0) {
        // First content line not yet seen
        if (trimmed === "") continue; // blank line before content
        if (indent > mlIndent) {
          mlBaseIndent = indent;
          mlBuf = trimmed;
          continue;
        }
        // indent <= mlIndent means no content for this block — fall through
      } else if (indent >= mlBaseIndent || trimmed === "") {
        const sep = mlStyle === "|" ? "\n" : " ";
        if (mlBuf !== "") mlBuf += sep;
        mlBuf += trimmed;
        continue;
      }
      // Block ended — emit the accumulated value
      tokens.push({
        indent: mlIndent,
        kind: "key-scalar",
        key: mlKey,
        value: mlBuf,
      });
      mlKey = null;
      mlBuf = "";
      mlStyle = null;
      mlBaseIndent = -1;
      // Fall through to process current line
    }

    if (!trimmed || trimmed.startsWith("#")) continue;

    // ── Check for multi-line block start (key: | or key: >) ──
    const colon = trimmed.indexOf(":");
    if (colon !== -1) {
      const after = trimmed.slice(colon + 1).trim();
      if (after === "|" || after === ">") {
        mlKey = trimmed.slice(0, colon).trim();
        mlIndent = indent;
        mlBuf = "";
        mlStyle = after;
        mlBaseIndent = -1; // Will be set by first content line
        continue;
      }
    }

    // ── List item ──
    if (trimmed.startsWith("- ")) {
      const rest = trimmed.slice(2).trim();
      const restColon = rest.indexOf(":");

      if (restColon === -1) {
        tokens.push({
          indent,
          kind: "list-scalar",
          key: "",
          value: coerceValue(rest),
        });
      } else {
        const itemKey = rest.slice(0, restColon).trim();
        const itemVal = rest.slice(restColon + 1).trim();
        if (itemVal === "") {
          tokens.push({ indent, kind: "list-object", key: itemKey, value: OPEN_MAPPING });
        } else {
          tokens.push({ indent, kind: "list-object", key: itemKey, value: coerceValue(itemVal) });
        }
      }
      continue;
    }

    // ── Key-value pair ──
    if (colon !== -1) {
      const key = trimmed.slice(0, colon).trim();
      const rawValue = trimmed.slice(colon + 1).trim();

      if (rawValue === "") {
        tokens.push({ indent, kind: "key-open", key, value: OPEN_MAPPING });
      } else {
        tokens.push({ indent, kind: "key-scalar", key, value: coerceValue(rawValue) });
      }
      continue;
    }

    // Line without colon — skip
  }

  // Pending multi-line value at EOF
  if (mlKey !== null) {
    tokens.push({ indent: mlIndent, kind: "key-scalar", key: mlKey, value: mlBuf });
  }

  return tokens;
}

// ── Phase 2: build tree ──────────────────────────────────────────────

function buildTree(tokens: Token[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [];

  for (const token of tokens) {
    // Pop frames at equal or deeper indent
    while (stack.length > 0 && stack[stack.length - 1].indent >= token.indent) {
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1].container : root;

    switch (token.kind) {
      case "key-scalar": {
        parent[token.key] = token.value;
        break;
      }

      case "key-open": {
        if (token.value === OPEN_MAPPING) {
          const nested: Record<string, unknown> = {};
          parent[token.key] = nested;
          stack.push({ indent: token.indent, container: nested, key: token.key });
        } else {
          parent[token.key] = token.value;
        }
        break;
      }

      case "list-scalar": {
        const lk = stack.length > 0 ? stack[stack.length - 1].key : "";
        const arr = (parent[lk] as unknown[]) ?? [];
        arr.push(token.value);
        parent[lk] = arr;
        break;
      }

      case "list-object": {
        const lk = stack.length > 0 ? stack[stack.length - 1].key : "";
        const arr = (parent[lk] as unknown[]) ?? [];
        const item: Record<string, unknown> = {};
        if (token.value !== OPEN_MAPPING) {
          item[token.key] = token.value;
        }
        arr.push(item);
        parent[lk] = arr;
        stack.push({ indent: token.indent, container: item, key: lk });
        break;
      }
    }
  }

  return root;
}

// ── Public API ───────────────────────────────────────────────────────

/** Parse a YAML string into a Record<string, unknown>. */
export function parseYaml(text: string): Record<string, unknown> {
  const tokens = tokenize(text);
  return buildTree(tokens);
}
