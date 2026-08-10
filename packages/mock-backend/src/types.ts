// Mock ERP/inbox/records data model (spec 11 §1-2, spec 07 §2).
// All money is integer cents; all data is synthetic and fictional.

export interface Vendor {
  id: string; // V-xxx
  canonical_name: string;
  type: "goods" | "service";
  terms_days: number;
  default_gl_code: string;
  active: boolean;
}

export interface PoLine {
  line_no: number;
  description: string;
  qty: number;
  unit_price_cents: number;
}

export interface PurchaseOrder {
  id: string; // PO-xxxx
  vendor_id: string;
  status: "open" | "closed";
  type: "goods" | "service";
  lines: PoLine[];
  // Service POs match on period instead of receiving (spec 07 §5).
  service_period: { start: string; end: string } | null;
}

export interface ReceivingLine {
  line_no: number;
  qty_received: number;
}

export interface ReceivingRecord {
  id: string; // RCV-xxxx
  po_id: string;
  received_date: string;
  lines: ReceivingLine[];
}

export interface LedgerEntry {
  id: string;
  vendor_id: string;
  invoice_number: string;
  amount_cents: number;
  posted_date: string;
  run_id: string | null; // null for seeded history
}

export interface PaymentScheduleRow {
  id: string;
  vendor_id: string;
  amount_cents: number;
  gl_code: string;
  pay_date: string;
  run_id: string;
  status: "scheduled";
}

export interface InboxItem {
  id: string; // INB-xxx
  fixture: string; // relative fixture name, e.g. "inbox/2026-08-03-corvida-monthly.md"
  received_at: string;
  state: "new" | "processing" | "processed" | "held" | "rejected";
}

export interface Disposition {
  id: string;
  run_id: string;
  kind: "payment_draft" | "vendor_email_draft" | "hold_note" | "rejection_note";
  summary: string;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  next_page: number | null;
  total: number;
}
