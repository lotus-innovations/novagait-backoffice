// Synthetic seed set (spec 11 §2, spec 07 §2). Five fictional vendors,
// 10 open + 2 closed POs, amounts straddling the $500 autonomy cap and the
// $5,000 hard-escalation floor, seeded ledger history so vendor profiles
// have substance on first run. Everything here is invented.

import type {
  InboxItem,
  LedgerEntry,
  PurchaseOrder,
  ReceivingRecord,
  Vendor,
} from "./types";

export const VENDORS: Vendor[] = [
  {
    id: "V-001",
    canonical_name: "Corvida Billing Partners",
    type: "service",
    terms_days: 30,
    default_gl_code: "6100",
    active: true,
  },
  {
    id: "V-002",
    canonical_name: "Meridex Equipment Leasing",
    type: "service",
    terms_days: 30,
    default_gl_code: "6400",
    active: true,
  },
  {
    id: "V-003",
    canonical_name: "ChartNimbus EMR",
    type: "service",
    terms_days: 15,
    default_gl_code: "6200",
    active: true,
  },
  {
    id: "V-004",
    canonical_name: "Brightline Clinic Supply",
    type: "goods",
    terms_days: 30,
    default_gl_code: "5100",
    active: true,
  },
  {
    id: "V-005",
    canonical_name: "Pelora Facilities Group",
    type: "service",
    terms_days: 30,
    default_gl_code: "6300",
    active: true,
  },
  // V-006..V-009: held-out eval vendors (spec 09 §1). Seeded in the ERP so
  // matching works, but their names appear in no demo fixture or prompt —
  // only in their own eval cases. Names collision-checked 2026-08-10.
  {
    id: "V-006",
    canonical_name: "Quillbrook Medical Supply",
    type: "goods",
    terms_days: 30,
    default_gl_code: "5200",
    active: true,
  },
  {
    id: "V-007",
    canonical_name: "Vantrell Managed IT",
    type: "service",
    terms_days: 30,
    default_gl_code: "6500",
    active: true,
  },
  {
    id: "V-008",
    canonical_name: "Ferrowind Construction Group",
    type: "service",
    terms_days: 30,
    default_gl_code: "6600",
    active: true,
  },
  {
    id: "V-009",
    canonical_name: "Solvenne Compliance Partners",
    type: "service",
    terms_days: 30,
    default_gl_code: "6700",
    active: true,
  },
];

export const PURCHASE_ORDERS: PurchaseOrder[] = [
  {
    id: "PO-2201",
    vendor_id: "V-001",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Claims processing service, monthly",
        qty: 1,
        unit_price_cents: 43875,
      },
    ],
    service_period: { start: "2026-07-01", end: "2026-09-30" },
  },
  {
    id: "PO-2202",
    vendor_id: "V-003",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "EMR subscription, monthly",
        qty: 1,
        unit_price_cents: 32900,
      },
    ],
    service_period: { start: "2026-01-01", end: "2026-12-31" },
  },
  {
    id: "PO-2203",
    vendor_id: "V-002",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Therapy laser lease, monthly",
        qty: 1,
        unit_price_cents: 124000,
      },
    ],
    service_period: { start: "2026-05-01", end: "2027-04-30" },
  },
  {
    id: "PO-2144",
    vendor_id: "V-002",
    status: "closed",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Treatment table lease, monthly (ended)",
        qty: 1,
        unit_price_cents: 89000,
      },
    ],
    service_period: { start: "2025-05-01", end: "2026-04-30" },
  },
  {
    id: "PO-2204",
    vendor_id: "V-004",
    status: "open",
    type: "goods",
    lines: [
      {
        line_no: 1,
        description: "Kinesiology tape, roll",
        qty: 24,
        unit_price_cents: 390,
      },
      {
        line_no: 2,
        description: "Resistance bands",
        qty: 50,
        unit_price_cents: 215,
      },
      {
        line_no: 3,
        description: "Sanitizing wipes, canister",
        qty: 30,
        unit_price_cents: 405,
      },
    ],
    service_period: null,
  },
  {
    id: "PO-2205",
    vendor_id: "V-004",
    status: "open",
    type: "goods",
    lines: [
      {
        line_no: 1,
        description: "Exercise putty, case",
        qty: 40,
        unit_price_cents: 725,
      },
    ],
    service_period: null,
  },
  {
    id: "PO-2206",
    vendor_id: "V-005",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Clinic cleaning service, monthly",
        qty: 1,
        unit_price_cents: 61200,
      },
    ],
    service_period: { start: "2026-01-01", end: "2026-12-31" },
  },
  {
    id: "PO-2207",
    vendor_id: "V-005",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Lobby renovation project, fixed fee",
        qty: 1,
        unit_price_cents: 580000,
      },
    ],
    service_period: { start: "2026-08-01", end: "2026-10-31" },
  },
  {
    id: "PO-2208",
    vendor_id: "V-004",
    status: "open",
    type: "goods",
    lines: [
      {
        line_no: 1,
        description: "Theraband clips, pack",
        qty: 25,
        unit_price_cents: 380,
      },
    ],
    service_period: null,
  },
  {
    id: "PO-2209",
    vendor_id: "V-003",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "EMR staff training add-on",
        qty: 1,
        unit_price_cents: 18000,
      },
    ],
    service_period: { start: "2026-08-01", end: "2026-08-31" },
  },
  {
    id: "PO-2210",
    vendor_id: "V-001",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Special denial-analytics report",
        qty: 1,
        unit_price_cents: 21000,
      },
    ],
    service_period: { start: "2026-08-01", end: "2026-08-31" },
  },
  {
    id: "PO-2145",
    vendor_id: "V-005",
    status: "closed",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Signage refresh project (completed)",
        qty: 1,
        unit_price_cents: 145000,
      },
    ],
    service_period: { start: "2026-02-01", end: "2026-03-31" },
  },
  // POs below exist for the held-out eval vendors (evals/CASE-PLAN.md).
  {
    id: "PO-2211",
    vendor_id: "V-006",
    status: "open",
    type: "goods",
    lines: [
      {
        line_no: 1,
        description: "Exam gloves, nitrile, box",
        qty: 40,
        unit_price_cents: 425,
      },
      {
        line_no: 2,
        description: "Gauze pads, sterile, case",
        qty: 20,
        unit_price_cents: 610,
      },
    ],
    service_period: null,
  },
  {
    id: "PO-2212",
    vendor_id: "V-006",
    status: "open",
    type: "goods",
    lines: [
      {
        line_no: 1,
        description: "Ultrasound gel, case",
        qty: 30,
        unit_price_cents: 480,
      },
    ],
    service_period: null,
  },
  {
    id: "PO-2213",
    vendor_id: "V-007",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Managed IT support, monthly",
        qty: 1,
        unit_price_cents: 18500,
      },
    ],
    service_period: { start: "2026-01-01", end: "2026-12-31" },
  },
  {
    id: "PO-2214",
    vendor_id: "V-008",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Treatment room buildout, fixed fee",
        qty: 1,
        unit_price_cents: 780000,
      },
    ],
    service_period: { start: "2026-08-01", end: "2026-11-30" },
  },
  {
    id: "PO-2215",
    vendor_id: "V-008",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Quarterly HVAC maintenance",
        qty: 1,
        unit_price_cents: 44000,
      },
    ],
    service_period: { start: "2026-07-01", end: "2026-09-30" },
  },
  {
    id: "PO-2216",
    vendor_id: "V-009",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Compliance audit retainer, monthly",
        qty: 1,
        unit_price_cents: 27500,
      },
    ],
    service_period: { start: "2026-01-01", end: "2026-12-31" },
  },
  {
    id: "PO-2217",
    vendor_id: "V-007",
    status: "open",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Network refresh project, fixed fee",
        qty: 1,
        unit_price_cents: 620000,
      },
    ],
    service_period: { start: "2026-08-01", end: "2026-10-31" },
  },
  {
    id: "PO-2146",
    vendor_id: "V-008",
    status: "closed",
    type: "service",
    lines: [
      {
        line_no: 1,
        description: "Parking lot restriping (completed)",
        qty: 1,
        unit_price_cents: 96000,
      },
    ],
    service_period: { start: "2026-04-01", end: "2026-04-30" },
  },
];

export const RECEIVING_RECORDS: ReceivingRecord[] = [
  {
    id: "RCV-1101",
    po_id: "PO-2204",
    received_date: "2026-08-01",
    lines: [
      { line_no: 1, qty_received: 24 },
      { line_no: 2, qty_received: 50 },
      { line_no: 3, qty_received: 30 },
    ],
  },
  {
    id: "RCV-1102",
    po_id: "PO-2205",
    received_date: "2026-08-05",
    lines: [{ line_no: 1, qty_received: 25 }],
  },
  {
    id: "RCV-1103",
    po_id: "PO-2208",
    received_date: "2026-08-07",
    lines: [{ line_no: 1, qty_received: 25 }],
  },
  {
    id: "RCV-1104",
    po_id: "PO-2211",
    received_date: "2026-08-08",
    lines: [
      { line_no: 1, qty_received: 40 },
      { line_no: 2, qty_received: 20 },
    ],
  },
  {
    id: "RCV-1105",
    po_id: "PO-2212",
    received_date: "2026-08-09",
    lines: [{ line_no: 1, qty_received: 18 }],
  },
];

// Seeded history: three posted invoices per recurring vendor so vendor
// profiles are non-empty on first run (spec 11 §2).
export const LEDGER_HISTORY: LedgerEntry[] = [
  ["V-001", "CB-2026-0503", 43875, "2026-05-04"],
  ["V-001", "CB-2026-0603", 43875, "2026-06-03"],
  ["V-001", "CB-2026-0703", 43875, "2026-07-03"],
  ["V-002", "MEL-8841", 124000, "2026-06-01"],
  ["V-002", "MEL-8902", 124000, "2026-07-01"],
  ["V-002", "MEL-8963", 124000, "2026-08-01"],
  ["V-003", "CN-33102", 32900, "2026-06-01"],
  ["V-003", "CN-33290", 32900, "2026-07-01"],
  ["V-003", "CN-33471", 32900, "2026-08-01"],
  ["V-004", "BCS-70213", 28450, "2026-06-12"],
  ["V-004", "BCS-70544", 41320, "2026-07-15"],
  ["V-005", "PFG-2214", 61200, "2026-06-05"],
  ["V-005", "PFG-2288", 61200, "2026-07-05"],
  ["V-006", "QMS-5480", 29200, "2026-07-12"],
  ["V-007", "VMI-2201", 18500, "2026-06-02"],
  ["V-007", "VMI-2288", 18500, "2026-07-02"],
  ["V-008", "FCG-801", 44000, "2026-07-08"],
  ["V-009", "SCP-1120", 27500, "2026-07-15"],
].map(([vendor, invoice, amount, date], index) => ({
  id: `LED-H${String(index + 1).padStart(3, "0")}`,
  vendor_id: vendor as string,
  invoice_number: invoice as string,
  amount_cents: amount as number,
  posted_date: date as string,
  run_id: null,
}));

export const INBOX_SEED: InboxItem[] = [
  "2026-08-03-corvida-monthly.md",
  "2026-08-04-brightline-supplies.md",
  "2026-08-05-pelora-cleaning.md",
  "2026-08-05-chartnimbus-email.md",
  "2026-08-06-corvida-reporting.md",
  "2026-08-06-lumenpay-unknown.md",
  "2026-08-07-meridex-closed-po.md",
  "2026-08-07-pelora-overbill.md",
  "2026-08-08-brightline-qty.md",
  "2026-08-08-corvida-monthly-dup.md",
  "2026-08-09-meridex-remit-redirect.md",
  "2026-08-09-brightline-dispute-note.md",
  "2026-08-09-pelora-renovation.md",
  "2026-08-10-chartnimbus-eur.md",
  "2026-08-10-wellness-newsletter.md",
].map((name, index) => ({
  id: `INB-${String(index + 1).padStart(3, "0")}`,
  fixture: `inbox/${name}`,
  received_at: `${name.slice(0, 10)}T09:00:00-07:00`,
  state: "new" as const,
}));
