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

interface LineInfo {
  indent: number;
  trimmed: string;
}

/** Parse a YAML string into a Record<string, unknown>. */
export function parseYaml(text: string): Record<string, unknown> {
  // Phase 1: tokenize into lines, handling multi-line string blocks
  const lines: LineInfo[] = [];
  const rawLines = text.split("\n");
  let mlBuf: string | null = null;
  let mlStyle: "|" | ">" | null = null;
  let mlBaseIndent = 0;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trimStart();
    const indent = rawLine.length - trimmed.length;

    if (mlBuf !== null) {
      // Inside a multi-line block
      if (indent > mlBaseIndent || trimmed === "") {
        const sep = mlStyle === "|" ? "\n" : " ";
        mlBuf += sep + trimmed;
        continue;
      }
      // End of multi-line block — the accumulated value will be set
      // by the calling context; just stop collecting
      mlBuf = null;
      mlStyle = null;
    }

    if (!trimmed || trimmed.startsWith("#")) continue;

    // Check for multi-line block start
    const colon = trimmed.indexOf(":");
    if (colon !== -1) {
      const val = trimmed.slice(colon + 1).trim();
      if (val === "|" || val === ">") {
        mlBuf = "";
        mlStyle = val;
        mlBaseIndent = indent;
        // Emit the key with an empty value marker so the phase-2 parser
        // knows to open a nested context
        lines.push({ indent, trimmed: trimmed.slice(0, colon).trim() + ":" });
        continue;
      }
    }

    lines.push({ indent, trimmed });
  }

  // Phase 2: parse the tokenized lines into a tree
  const root: Record<string, unknown> = {};
  const stack: Array<{ key: string; obj: Record<string, unknown>; indent: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const { indent, trimmed } = lines[i];

    // Pop stack to find parent at shallower indent
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack.length > 0 ? stack[stack.length - 1].obj : root;

    // List item: "- value" or "- key: value"
    if (trimmed.startsWith("- ")) {
      const rest = trimmed.slice(2).trim();
      const restColon = rest.indexOf(":");

      if (restColon !== -1 && rest.slice(restColon + 1).trim() === "") {
        // List of objects: "- key:" followed by indented sub-keys
        const listKey = stack.length > 0 ? stack[stack.length - 1].key : rest.slice(0, restColon).trim();
        const itemObj: Record<string, unknown> = {};
        const itemIndent = indent;
        // Collect following indented lines as keys of this item
        let j = i + 1;
        while (j < lines.length && lines[j].indent > itemIndent) {
          const sub = lines[j];
          const sc = sub.trimmed.indexOf(":");
          if (sc !== -1) {
            const sk = sub.trimmed.slice(0, sc).trim();
            const sv = sub.trimmed.slice(sc + 1).trim();
            itemObj[sk] = coerceValue(sv || null);
          }
          j++;
        }
        const arr = (parent[listKey] as unknown[]) ?? [];
        arr.push(itemObj);
        parent[listKey] = arr;
        i = j - 1;
      } else {
        // Simple list of scalars — find the parent key
        const listKey = stack.length > 0 ? stack[stack.length - 1].key : "";
        const arr = (parent[listKey] as unknown[]) ?? [];
        arr.push(coerceValue(rest));
        parent[listKey] = arr;
      }
      continue;
    }

    // Key: value pair
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();

    if (rawValue === "" || rawValue === "null" || rawValue === "~") {
      // Empty value → nested object (or explicit null)
      if (rawValue === "null" || rawValue === "~") {
        parent[key] = null;
      } else {
        const nested: Record<string, unknown> = {};
        parent[key] = nested;
        stack.push({ key, obj: nested, indent });
      }
    } else {
      parent[key] = coerceValue(rawValue);
    }
  }

  return root;
}
