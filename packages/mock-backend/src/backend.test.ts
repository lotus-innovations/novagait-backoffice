import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@novagait/agent";
import { MockBackend, PO_PAGE_SIZE } from "./backend";
import { INBOX_SEED, PURCHASE_ORDERS, VENDORS } from "./seed-data";

describe("MockBackend", () => {
  let backend: MockBackend;

  beforeEach(async () => {
    backend = new MockBackend(new InMemoryStore());
    await backend.seed();
  });

  it("seeds vendors, POs, receiving, history, and inbox", async () => {
    expect(await backend.listVendors()).toHaveLength(VENDORS.length);
    const firstPage = await backend.listPurchaseOrders(1);
    expect(firstPage.total).toBe(PURCHASE_ORDERS.length);
    expect(await backend.listInbox()).toHaveLength(INBOX_SEED.length);
    const history = await backend.ledgerEntries();
    expect(history.length).toBeGreaterThanOrEqual(13);
    expect(history.every((entry) => entry.run_id === null)).toBe(true);
  });

  it("straddles both decision thresholds in seed data", async () => {
    const totals = PURCHASE_ORDERS.map((po) =>
      po.lines.reduce((sum, line) => sum + line.qty * line.unit_price_cents, 0),
    );
    expect(totals.some((total) => total <= 50_000)).toBe(true); // under $500 cap
    expect(totals.some((total) => total > 50_000 && total < 500_000)).toBe(
      true,
    ); // between cap and floor
    expect(totals.some((total) => total >= 500_000)).toBe(true); // above $5,000 floor
  });

  it("paginates purchase orders at page size 5 with a next_page cursor", async () => {
    const page1 = await backend.listPurchaseOrders(1);
    expect(page1.items).toHaveLength(PO_PAGE_SIZE);
    expect(page1.next_page).toBe(2);
    const page3 = await backend.listPurchaseOrders(3);
    expect(page3.items.length).toBeGreaterThan(0);
    expect(page3.next_page).toBeNull();
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      for (const po of (await backend.listPurchaseOrders(page)).items) {
        seen.add(po.id);
      }
    }
    expect(seen.size).toBe(PURCHASE_ORDERS.length);
  });

  it("enforces ledger uniqueness on vendor + invoice number", async () => {
    expect(await backend.invoiceExists("V-001", "CB-2026-0703")).toBe(true);
    await expect(
      backend.postToLedger({
        id: "LED-X01",
        vendor_id: "V-001",
        invoice_number: "CB-2026-0703",
        amount_cents: 43875,
        posted_date: "2026-08-10",
        run_id: "RUN-TEST",
      }),
    ).rejects.toThrow(/duplicate ledger entry/);
  });

  it("failure toggle fails the first payment write once, then succeeds", async () => {
    await backend.setFailureToggle(true);
    const row = {
      id: "PAY-001",
      vendor_id: "V-001",
      amount_cents: 43875,
      gl_code: "6100",
      pay_date: "2026-09-02",
      run_id: "RUN-TEST",
      status: "scheduled" as const,
    };
    await expect(backend.schedulePayment(row)).rejects.toThrow(/simulated/);
    await backend.schedulePayment(row);
    expect(await backend.paymentSchedule()).toHaveLength(1);
    expect((await backend.failureToggle()).fired).toBe(true);
  });

  it("resolves receiving records by PO, including the short-shipped one", async () => {
    const full = await backend.getReceivingForPo("PO-2204");
    expect(full?.lines.map((line) => line.qty_received)).toEqual([24, 50, 30]);
    const partial = await backend.getReceivingForPo("PO-2205");
    expect(partial?.lines[0].qty_received).toBe(25); // billed qty will be 40
    expect(await backend.getReceivingForPo("PO-2206")).toBeNull(); // service PO
  });

  it("reads fixtures and tracks inbox state", async () => {
    const item = await backend.getInboxItem("INB-001");
    expect(item?.fixture).toBe("inbox/2026-08-03-corvida-monthly.md");
    const text = await backend.readFixture(item!.fixture);
    expect(text).toContain("CB-2026-0803");
    await backend.setInboxState("INB-001", "processing");
    expect((await backend.getInboxItem("INB-001"))?.state).toBe("processing");
  });

  it("refuses unknown fixture names (no fs, no traversal surface)", async () => {
    await expect(backend.readFixture("../../package.json")).rejects.toThrow(
      /unknown fixture/,
    );
  });

  it("every seeded inbox fixture file exists and is readable", async () => {
    for (const item of await backend.listInbox()) {
      const text = await backend.readFixture(item.fixture);
      expect(text.length).toBeGreaterThan(40);
    }
  });
});
