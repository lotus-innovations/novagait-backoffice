// Write-boundary redaction (spec 08 §4). Applied exactly once, in the trace
// writer, never at read/render time. The demo data is synthetic; the layer
// exists because it is the client-engagement pattern being demonstrated.

import { createHash } from "node:crypto";

export interface RedactedText {
  digest: string;
  length: number;
  redacted: true;
}

export function digestText(text: string): RedactedText {
  return {
    digest: createHash("sha256")
      .update(text, "utf8")
      .digest("hex")
      .slice(0, 16),
    length: text.length,
    redacted: true,
  };
}

// Tool-arg fields redacted in traces. The approver-facing draft keeps the
// clear value; the trace keeps a digest (spec 08 §4).
const REDACTED_ARG_FIELDS = new Set(["remit_to", "free_text", "note_text"]);

export type Redactable =
  | string
  | number
  | boolean
  | null
  | RedactedText
  | Redactable[]
  | { [key: string]: Redactable };

export function redactToolArgs(
  args: Record<string, Redactable>,
): Record<string, Redactable> {
  const out: Record<string, Redactable> = {};
  for (const [key, value] of Object.entries(args)) {
    if (REDACTED_ARG_FIELDS.has(key) && typeof value === "string") {
      out[key] = digestText(value);
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = redactToolArgs(value as Record<string, Redactable>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
