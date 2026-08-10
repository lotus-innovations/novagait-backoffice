// Deterministic 3-way match + route decision (spec 07 §5-6). Reference
// implementation shared by the mock lane and (later) the eval graders.

import {
  AUTONOMY_CAP_CENTS,
  priceToleranceCents,
  type Decision,
  type ExtractedInvoice,
} from "@novagait/agent";
import type { PurchaseOrder, ReceivingRecord } from "@novagait/mock-backend";

export interface MatchResult {
  matched: boolean;
  exceptions: string[];
  po_total_cents: number | null;
  variance_cents: number | null;
}

export function matchInvoice(
  extraction: ExtractedInvoice,
  po: PurchaseOrder | null,
  receiving: ReceivingRecord | null,
): MatchResult {
  const exceptions: string[] = [];
  if (!extraction.po_reference) exceptions.push("missing_po_reference");
  if (extraction.currency !== "USD") exceptions.push("non_usd_currency");

  if (!po) {
    if (extraction.po_reference) exceptions.push("po_not_found");
    return {
      matched: false,
      exceptions,
      po_total_cents: null,
      variance_cents: null,
    };
  }
  if (po.status !== "open") exceptions.push("po_closed");
  if (extraction.vendor_id && po.vendor_id !== extraction.vendor_id) {
    exceptions.push("po_vendor_mismatch");
  }

  const poTotal = po.lines.reduce(
    (sum, line) => sum + line.qty * line.unit_price_cents,
    0,
  );
  const variance = Math.abs(extraction.total_cents - poTotal);
  if (variance > priceToleranceCents(poTotal)) {
    exceptions.push("price_variance_exceeds_tolerance");
  }

  if (po.type === "goods") {
    if (!receiving) {
      exceptions.push("receiving_record_missing");
    } else {
      const received = receiving.lines.reduce(
        (sum, line) => sum + line.qty_received,
        0,
      );
      const billedQty = extraction.line_items.reduce(
        (sum, line) => sum + line.qty,
        0,
      );
      // Fall back to value comparison when the invoice has no parsed lines:
      // billed value must not exceed received value.
      if (billedQty > 0) {
        if (billedQty > received)
          exceptions.push("qty_billed_exceeds_received");
      } else {
        const receivedValue = receiving.lines.reduce((sum, line) => {
          const poLine = po.lines.find(
            (candidate) => candidate.line_no === line.line_no,
          );
          return sum + line.qty_received * (poLine?.unit_price_cents ?? 0);
        }, 0);
        if (
          extraction.total_cents >
          receivedValue + priceToleranceCents(poTotal)
        ) {
          exceptions.push("qty_billed_exceeds_received");
        }
      }
    }
  }

  return {
    matched: exceptions.length === 0,
    exceptions,
    po_total_cents: poTotal,
    variance_cents: variance,
  };
}

export function decideRoute(context: {
  match: MatchResult;
  totalCents: number;
  vendorId: string | null;
  duplicate: boolean;
}): { route: Decision; reason: string } {
  if (context.duplicate) {
    return { route: "exception_hold", reason: "duplicate submission" };
  }
  if (context.vendorId === null) {
    return { route: "exception_hold", reason: "vendor unresolved" };
  }
  if (!context.match.matched) {
    return {
      route: "exception_hold",
      reason: `match failed: ${context.match.exceptions.join(", ")}`,
    };
  }
  if (context.totalCents <= AUTONOMY_CAP_CENTS) {
    return { route: "auto_approve", reason: "full match under autonomy cap" };
  }
  return {
    route: "route_for_approval",
    reason: "full match above autonomy cap",
  };
}
