// Tolerance-edge routing (spec 07 §5-6): a nonzero price variance within
// max(2%, $25) keeps the match valid but is a minor exception, so autonomy
// is barred even under the cap. Boundary: variance == tolerance is within
// (match.ts uses strict >); one cent more is an exception_hold.

import { describe, expect, it } from "vitest";
import { priceToleranceCents, type ExtractedInvoice } from "@novagait/agent";
import type { PurchaseOrder } from "@novagait/mock-backend";
import { decideRoute, matchInvoice } from "./match";

const PO: PurchaseOrder = {
  id: "PO-9001",
  vendor_id: "V-001",
  status: "open",
  type: "service",
  lines: [
    {
      line_no: 1,
      description: "Test service",
      qty: 1,
      unit_price_cents: 40000,
    },
  ],
  service_period: { start: "2026-01-01", end: "2026-12-31" },
};

function extraction(totalCents: number): ExtractedInvoice {
  return {
    vendor_name_raw: "Corvida Billing Partners",
    vendor_id: "V-001",
    invoice_number: "T-100",
    invoice_date: "2026-08-01",
    due_date: null,
    currency: "USD",
    subtotal_cents: totalCents,
    tax_cents: 0,
    total_cents: totalCents,
    po_reference: "PO-9001",
    line_items: [],
    remit_to: null,
    source_spans: {},
  };
}

function route(totalCents: number) {
  const match = matchInvoice(extraction(totalCents), PO, null);
  return {
    match,
    decision: decideRoute({
      match,
      totalCents,
      vendorId: "V-001",
      duplicate: false,
    }),
  };
}

describe("tolerance-edge routing", () => {
  const tolerance = priceToleranceCents(40000); // max(2% of 400.00, $25) = 2500

  it("exact match under the cap auto-approves", () => {
    const { match, decision } = route(40000);
    expect(match.matched).toBe(true);
    expect(match.minor_exceptions).toEqual([]);
    expect(decision.route).toBe("auto_approve");
  });

  it("nonzero variance within tolerance routes for approval even under cap", () => {
    const { match, decision } = route(40000 + 1200);
    expect(match.matched).toBe(true);
    expect(match.minor_exceptions).toEqual(["price_variance_within_tolerance"]);
    expect(decision.route).toBe("route_for_approval");
    expect(decision.reason).toContain("minor exception");
  });

  it("variance exactly at tolerance is within (strict >) and routes", () => {
    const { match, decision } = route(40000 + tolerance);
    expect(match.matched).toBe(true);
    expect(match.minor_exceptions).toEqual(["price_variance_within_tolerance"]);
    expect(decision.route).toBe("route_for_approval");
  });

  it("one cent beyond tolerance is an exception hold", () => {
    const { match, decision } = route(40000 + tolerance + 1);
    expect(match.matched).toBe(false);
    expect(match.exceptions).toContain("price_variance_exceeds_tolerance");
    expect(decision.route).toBe("exception_hold");
  });

  it("under-billing within tolerance is also a minor exception", () => {
    const { match, decision } = route(40000 - 900);
    expect(match.matched).toBe(true);
    expect(match.minor_exceptions).toEqual(["price_variance_within_tolerance"]);
    expect(decision.route).toBe("route_for_approval");
  });
});
