// Deterministic fixture parser for the mock lane (LOT-98). This is NOT the
// live extraction path (the model does that); it is the reference
// extraction that makes CI/e2e/preview runs deterministic and key-free.

import {
  resolveVendorName,
  type ExtractedInvoice,
  type VendorCandidate,
} from "@novagait/agent";

function money(text: string): number | null {
  const cleaned = text.replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const us = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1]}-${us[2]}`;
  return null; // ambiguous formats stay null: never guess (spec 07)
}

export function parseFixture(
  text: string,
  vendors: VendorCandidate[],
): ExtractedInvoice {
  const currency = /\bEUR\b|€/.test(text) ? "EUR" : "USD";
  const totalRaw = firstMatch(text, [
    /total due[ .:]*\$?\s?([\d,]+\.\d{2})/i,
    /\btotal:\s*\$?([\d,]+\.\d{2})/i,
    /EUR\s*([\d,]+\.\d{2})/,
    /\$\s?([\d,]+\.\d{2})\s*USD/i,
  ]);
  const totalCents = totalRaw ? (money(totalRaw) ?? 0) : 0;

  const invoiceNumber =
    firstMatch(text, [
      /invoice number:\s*(\S+)/i,
      /INVOICE\s+#?([A-Z]{2,}[A-Z0-9-]*\d[A-Z0-9-]*)/,
      /invoice\s+([A-Z]{2,}-[\dA-Z-]+)/i,
      /#([A-Z]{2,}-\d+)/,
    ]) ?? "UNKNOWN";

  // Best vendor resolution across candidate lines (letterhead, remit line).
  let bestLine: ReturnType<typeof resolveVendorName> = {
    vendor_id: null,
    canonical_name: null,
    score: 0,
    method: "unresolved",
  };
  let vendorNameRaw = "unknown";
  for (const line of text.split("\n")) {
    const candidate = line
      .trim()
      .replace(/^(From:|Remit to:?|Sold to:)\s*/i, "");
    if (!candidate || candidate.length > 60 || candidate.split(" ").length > 6)
      continue;
    const resolution = resolveVendorName(candidate, vendors);
    if (resolution.score > bestLine.score) {
      bestLine = resolution;
      vendorNameRaw = candidate;
    }
  }

  const remit = firstMatch(text, [/remit(?: to)?:?\s*(.+)/i]);
  const invoiceDate = normalizeDate(
    firstMatch(text, [/invoice date:\s*([\d/-]+)/i, /date:\s*([\d/-]+)/i]),
  );
  const dueDate = normalizeDate(
    firstMatch(text, [/due(?: date)?:\s*([\d/-]+)/i]),
  );

  return {
    vendor_name_raw: vendorNameRaw,
    vendor_id: bestLine.vendor_id,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate ?? "1970-01-01",
    due_date: dueDate,
    currency,
    subtotal_cents: totalCents,
    tax_cents: 0,
    total_cents: totalCents,
    po_reference: firstMatch(text, [
      /PO(?: reference)?:?\s*(PO-\d+)/i,
      /purchase order:\s*(PO-\d+)/i,
      /\b(PO-\d{4})\b/,
    ]),
    line_items: [],
    remit_to: remit,
    source_spans: {
      total_cents: totalRaw ? `total ${totalRaw}` : "not found",
      invoice_number: invoiceNumber,
    },
  };
}
