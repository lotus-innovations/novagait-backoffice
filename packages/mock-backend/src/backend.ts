// The fictional "existing system" (spec 11). The agent reaches these modules
// only through tool schemas; every method is a plausible ERP/inbox surface.
// Deliberate frictions (spec 11 §3): latency jitter, paginated PO listing,
// a payment-schedule write that can fail once via the failure toggle.
// Date-format inconsistency and the vendor-name variant live in the
// fixtures, not here.

import type { Store } from "@novagait/agent";
import { FIXTURES } from "./fixtures.generated";
import {
  INBOX_SEED,
  LEDGER_HISTORY,
  PURCHASE_ORDERS,
  RECEIVING_RECORDS,
  VENDORS,
} from "./seed-data";
import type {
  Disposition,
  InboxItem,
  LedgerEntry,
  Page,
  PaymentScheduleRow,
  PurchaseOrder,
  ReceivingRecord,
  Vendor,
} from "./types";

const KEYS = {
  vendors: "erp:vendors",
  pos: "erp:pos",
  receiving: "erp:receiving",
  ledger: "erp:ledger",
  payments: "erp:payments",
  inbox: "inbox:items",
  dispositions: "records:dispositions",
  failureToggle: "admin:failure-toggle",
} as const;

export const PO_PAGE_SIZE = 5;

export interface MockBackendOptions {
  // Latency jitter 50-300ms (spec 11 §3). Off in unit tests.
  jitter?: boolean;
}

export class MockBackend {
  constructor(
    private readonly store: Store,
    private readonly options: MockBackendOptions = {},
  ) {}

  private async friction(): Promise<void> {
    if (!this.options.jitter) return;
    const ms = 50 + Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.store.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  private async writeJson(key: string, value: unknown): Promise<void> {
    await this.store.set(key, JSON.stringify(value));
  }

  // --- seeding -----------------------------------------------------------

  async seed(): Promise<void> {
    await this.writeJson(KEYS.vendors, VENDORS);
    await this.writeJson(KEYS.pos, PURCHASE_ORDERS);
    await this.writeJson(KEYS.receiving, RECEIVING_RECORDS);
    await this.writeJson(KEYS.ledger, LEDGER_HISTORY);
    await this.writeJson(KEYS.payments, []);
    await this.writeJson(KEYS.inbox, INBOX_SEED);
    await this.writeJson(KEYS.dispositions, []);
    await this.writeJson(KEYS.failureToggle, { armed: false, fired: false });
  }

  // --- ERP: vendors ------------------------------------------------------

  async listVendors(): Promise<Vendor[]> {
    await this.friction();
    return (await this.readJson<Vendor[]>(KEYS.vendors)) ?? [];
  }

  async getVendor(id: string): Promise<Vendor | null> {
    await this.friction();
    const vendors = (await this.readJson<Vendor[]>(KEYS.vendors)) ?? [];
    return vendors.find((vendor) => vendor.id === id) ?? null;
  }

  // --- ERP: purchase orders (paginated by design, spec 11 §3) ------------

  async listPurchaseOrders(page = 1): Promise<Page<PurchaseOrder>> {
    await this.friction();
    const all = (await this.readJson<PurchaseOrder[]>(KEYS.pos)) ?? [];
    const start = (page - 1) * PO_PAGE_SIZE;
    const items = all.slice(start, start + PO_PAGE_SIZE);
    const nextPage = start + PO_PAGE_SIZE < all.length ? page + 1 : null;
    return {
      items,
      page,
      page_size: PO_PAGE_SIZE,
      next_page: nextPage,
      total: all.length,
    };
  }

  async getPurchaseOrder(id: string): Promise<PurchaseOrder | null> {
    await this.friction();
    const all = (await this.readJson<PurchaseOrder[]>(KEYS.pos)) ?? [];
    return all.find((po) => po.id === id) ?? null;
  }

  async getReceivingForPo(poId: string): Promise<ReceivingRecord | null> {
    await this.friction();
    const all = (await this.readJson<ReceivingRecord[]>(KEYS.receiving)) ?? [];
    return all.find((record) => record.po_id === poId) ?? null;
  }

  // --- ERP: ledger -------------------------------------------------------

  async ledgerEntries(): Promise<LedgerEntry[]> {
    await this.friction();
    return (await this.readJson<LedgerEntry[]>(KEYS.ledger)) ?? [];
  }

  async invoiceExists(
    vendorId: string,
    invoiceNumber: string,
  ): Promise<boolean> {
    const entries = await this.ledgerEntries();
    return entries.some(
      (entry) =>
        entry.vendor_id === vendorId && entry.invoice_number === invoiceNumber,
    );
  }

  async postToLedger(entry: LedgerEntry): Promise<void> {
    await this.friction();
    const entries = (await this.readJson<LedgerEntry[]>(KEYS.ledger)) ?? [];
    if (
      entries.some(
        (existing) =>
          existing.vendor_id === entry.vendor_id &&
          existing.invoice_number === entry.invoice_number,
      )
    ) {
      throw new Error(
        `duplicate ledger entry: ${entry.vendor_id}/${entry.invoice_number}`,
      );
    }
    entries.push(entry);
    await this.writeJson(KEYS.ledger, entries);
  }

  // --- ERP: payment schedule (failure-toggle friction lives here) --------

  async schedulePayment(row: PaymentScheduleRow): Promise<void> {
    await this.friction();
    const toggle = (await this.readJson<{ armed: boolean; fired: boolean }>(
      KEYS.failureToggle,
    )) ?? { armed: false, fired: false };
    if (toggle.armed && !toggle.fired) {
      await this.writeJson(KEYS.failureToggle, { armed: true, fired: true });
      throw new Error(
        "payment schedule service unavailable (simulated transient failure)",
      );
    }
    const rows =
      (await this.readJson<PaymentScheduleRow[]>(KEYS.payments)) ?? [];
    rows.push(row);
    await this.writeJson(KEYS.payments, rows);
  }

  async paymentSchedule(): Promise<PaymentScheduleRow[]> {
    await this.friction();
    return (await this.readJson<PaymentScheduleRow[]>(KEYS.payments)) ?? [];
  }

  async setFailureToggle(armed: boolean): Promise<void> {
    await this.writeJson(KEYS.failureToggle, { armed, fired: false });
  }

  async failureToggle(): Promise<{ armed: boolean; fired: boolean }> {
    return (
      (await this.readJson<{ armed: boolean; fired: boolean }>(
        KEYS.failureToggle,
      )) ?? { armed: false, fired: false }
    );
  }

  // --- inbox -------------------------------------------------------------

  async listInbox(): Promise<InboxItem[]> {
    await this.friction();
    return (await this.readJson<InboxItem[]>(KEYS.inbox)) ?? [];
  }

  async getInboxItem(id: string): Promise<InboxItem | null> {
    const items = await this.listInbox();
    return items.find((item) => item.id === id) ?? null;
  }

  /**
   * Append one document to the inbox index. The demo inbox is seeded, so
   * nothing in the product enqueues; the eval lanes do, one fixture per
   * case, and they should not be reaching around the backend to write
   * `inbox:items` by hand to do it. Duplicate ids are refused so a
   * mis-ordered pre-seed fails loudly instead of shadowing a case.
   */
  async enqueueInboxItem(item: {
    id: string;
    fixture: string;
    received_at?: string;
  }): Promise<InboxItem> {
    await this.friction();
    const items = (await this.readJson<InboxItem[]>(KEYS.inbox)) ?? [];
    if (items.some((candidate) => candidate.id === item.id)) {
      throw new Error(`inbox item already enqueued: ${item.id}`);
    }
    const enqueued: InboxItem = {
      id: item.id,
      fixture: item.fixture,
      received_at: item.received_at ?? new Date().toISOString(),
      state: "new",
    };
    items.push(enqueued);
    await this.writeJson(KEYS.inbox, items);
    return enqueued;
  }

  async setInboxState(id: string, state: InboxItem["state"]): Promise<void> {
    await this.friction();
    const items = (await this.readJson<InboxItem[]>(KEYS.inbox)) ?? [];
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`unknown inbox item: ${id}`);
    item.state = state;
    await this.writeJson(KEYS.inbox, items);
  }

  // Fixtures are compiled into the bundle (fixtures.generated.ts) so the
  // backend is bundler/serverless-safe; the files on disk stay the source
  // of truth and a unit test fails on drift. Unknown names throw, which
  // also closes the path-traversal surface entirely.
  async readFixture(fixture: string): Promise<string> {
    const text = FIXTURES[fixture];
    if (text === undefined) throw new Error(`unknown fixture: ${fixture}`);
    return text;
  }

  // --- records -----------------------------------------------------------

  async saveDisposition(disposition: Disposition): Promise<void> {
    await this.friction();
    const all = (await this.readJson<Disposition[]>(KEYS.dispositions)) ?? [];
    all.push(disposition);
    await this.writeJson(KEYS.dispositions, all);
  }

  async dispositions(): Promise<Disposition[]> {
    await this.friction();
    return (await this.readJson<Disposition[]>(KEYS.dispositions)) ?? [];
  }
}
