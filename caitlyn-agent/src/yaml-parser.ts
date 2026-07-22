/**
 * CAITLYN Agent — Simple YAML Parser
 *
 * Minimal YAML parser for flat config files. No external dependencies needed.
 * Supports key-value pairs, nested objects, lists (via _list_* convention),
 * quoted strings, numbers, booleans, null, and comments.
 */

/**
 * Coerce a raw string value to its appropriate JavaScript type.
 * Handles numbers, booleans, null, and quoted strings.
 */
export function coerceValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  let v: string = raw;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (/^-?\d+\.?\d*$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "" || v === "null") return null;
  return v;
}

/**
 * Parse a YAML string into a Record<string, unknown>.
 *
 * Supported features:
 * - Top-level key: value pairs
 * - Nested objects via indentation (2+ spaces)
 * - Lists via "- value" under a parent key (stored as _list_<key>)
 * - Comments (# …)
 * - Scalar types: strings, numbers, booleans, null
 */
export function parseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentNested: Record<string, unknown> | null = null;
  let nestedKey = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Nested line (indented under a parent key that had an empty value)
    if (indent >= 2 && currentNested !== null) {
      // YAML list item: "- value"
      if (trimmed.startsWith("- ")) {
        const itemValue = coerceValue(trimmed.slice(2).trim());
        const listKey = `_list_${nestedKey}`;
        const list = (currentNested[listKey] as unknown[]) ?? [];
        list.push(itemValue);
        currentNested[listKey] = list;
        continue;
      }
      // Regular nested key: "key: value"
      const colon = trimmed.indexOf(":");
      if (colon !== -1) {
        const key = trimmed.slice(0, colon).trim();
        const rawValue = trimmed.slice(colon + 1).trim();
        currentNested[key] = coerceValue(rawValue);
      }
      continue;
    }

    // Top-level line — resets nesting context
    currentNested = null;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();

    if (rawValue === "") {
      // Empty value → this key opens a nested block (object or list)
      currentNested = {};
      nestedKey = key;
      out[key] = currentNested;
    } else if (rawValue === "null") {
      // Explicit null scalar
      out[key] = null;
    } else {
      out[key] = coerceValue(rawValue);
    }
  }

  return out;
}
