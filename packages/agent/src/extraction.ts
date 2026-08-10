// Invoice extraction schema (spec 07 §4). Frozen with the trace schema:
// golden-case expected.fields and the graders key off these names.

import { z } from "zod";

export const lineItemSchema = z.object({
  description: z.string(),
  qty: z.number(),
  unit_price_cents: z.number().int(),
  amount_cents: z.number().int(),
});

export const extractionSchema = z.object({
  vendor_name_raw: z.string().describe("Vendor name exactly as printed"),
  vendor_id: z
    .string()
    .nullable()
    .describe("Resolved ERP vendor id, null if unresolved"),
  invoice_number: z.string(),
  invoice_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date required")
    .describe("Normalized to YYYY-MM-DD"),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date required")
    .nullable()
    .describe("Normalized to YYYY-MM-DD, null if absent or ambiguous"),
  currency: z
    .string()
    .length(3)
    .describe("ISO currency code; non-USD is an exception, not an error"),
  subtotal_cents: z.number().int(),
  tax_cents: z.number().int(),
  total_cents: z.number().int(),
  po_reference: z.string().nullable(),
  line_items: z.array(lineItemSchema),
  remit_to: z.string().nullable(),
  source_spans: z
    .record(z.string(), z.string())
    .describe("Field name -> verbatim quote from the source document"),
});

export type ExtractedInvoice = z.infer<typeof extractionSchema>;
