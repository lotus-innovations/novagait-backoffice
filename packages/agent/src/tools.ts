// Versioned tool surface (spec 07 §9, design brief A). This module owns the
// schemas; executors are supplied by the loop (LOT-93) and the approval gate
// (LOT-99) via buildTools(), so the gate stays code the model cannot reach
// around. TOOLS_VERSION is stamped into every run.start event.

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { extractionSchema } from "./extraction";

export const TOOLS_VERSION = "1.0.0";

export const TOOL_NAMES = [
  "lookup_vendor",
  "lookup_po",
  "lookup_receiving",
  "check_duplicate",
  "draft_action",
  "update_vendor_profile",
  "execute_action",
  "kb_search",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const toolInputSchemas = {
  lookup_vendor: z.object({
    name_raw: z
      .string()
      .describe("Vendor name exactly as printed on the document"),
  }),
  lookup_po: z.object({
    po_id: z.string().describe("Purchase order id, e.g. PO-2201"),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page cursor when listing (the PO list is paginated)"),
  }),
  lookup_receiving: z.object({
    po_id: z.string().describe("PO whose receiving record to fetch"),
  }),
  check_duplicate: z.object({
    vendor_id: z.string().nullable(),
    invoice_number: z.string(),
    content_digest: z
      .string()
      .describe("Normalized-content digest of the document"),
  }),
  draft_action: z.object({
    route: z.enum([
      "auto_approve",
      "route_for_approval",
      "exception_hold",
      "reject",
    ]),
    extraction: extractionSchema.describe(
      "Full extraction result with source spans as evidence",
    ),
    summary: z
      .string()
      .describe("One-paragraph plain-language summary for the approver"),
    policy_line: z
      .string()
      .describe("The policy rule that produced this route, quoted"),
    payment: z
      .object({
        amount_cents: z.number().int(),
        gl_code: z.string(),
        pay_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .nullable()
      .describe("Payment draft, only for approve routes"),
    vendor_email_draft: z
      .string()
      .nullable()
      .describe("Draft email to the vendor, only for exception_hold"),
  }),
  update_vendor_profile: z.object({
    vendor_id: z.string(),
    fields: z.object({
      last_seen: z.string().optional(),
      learned_gl_code: z.string().optional(),
      exception_increment: z.number().int().optional(),
    }),
  }),
  execute_action: z.object({
    draft_ref: z
      .string()
      .describe("Reference to the drafted action being executed"),
  }),
  kb_search: z.object({
    query: z
      .string()
      .describe("Policy question, e.g. tolerance for price variance"),
  }),
} as const;

const toolDescriptions: Record<ToolName, string> = {
  lookup_vendor:
    "Resolve a printed vendor name against the ERP canonical vendor list. Returns the vendor record or null; fuzzy resolution is reported with its score.",
  lookup_po:
    "Fetch a purchase order by id, or page through the PO list. POs carry lines, status, and service period.",
  lookup_receiving:
    "Fetch the receiving record for a goods PO. Service POs have none; they match on service period.",
  check_duplicate:
    "Check the dedupe ledger and the ERP ledger for a prior submission of this invoice.",
  draft_action:
    "Record the decision draft the approver will see: route, full extraction with evidence, summary, policy line, and the payment or vendor-email draft.",
  update_vendor_profile:
    "Write a bounded update to the vendor memory profile. Audited; visible at the approval gate.",
  execute_action:
    "Execute the drafted action against the ERP. Subject to the approval gate: returns awaiting_approval unless approval requirements are satisfied.",
  kb_search:
    "Search the AP policy knowledge base. Returns excerpts with citations.",
};

// Executors return the serialized tool result the model will see (the tool
// runner requires string/content-block results). Compact JSON by convention.
export type ToolExecutors = {
  [K in ToolName]: (
    input: z.infer<(typeof toolInputSchemas)[K]>,
  ) => Promise<string>;
};

// Assemble the runnable tool list for the tool runner. Executors are
// injected so this module stays pure schema. The per-name helper keeps the
// schema/executor pairing typed; the single cast at the call boundary is
// safe because both sides are keyed by the same name.
function toolFor<K extends ToolName>(name: K, executors: ToolExecutors) {
  return betaZodTool({
    name,
    description: toolDescriptions[name],
    inputSchema: toolInputSchemas[name],
    run: (input) => executors[name](input as never),
  });
}

export function buildTools(executors: ToolExecutors) {
  return TOOL_NAMES.map((name) => toolFor(name, executors));
}
