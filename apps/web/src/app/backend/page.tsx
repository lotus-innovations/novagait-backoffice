import Link from "next/link";
import type { PurchaseOrder } from "@novagait/mock-backend";
import { ensureSeeded, getBackend } from "@/lib/runtime";

export const dynamic = "force-dynamic";

function centsToUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function poTotalCents(po: PurchaseOrder): number {
  return po.lines.reduce(
    (sum, line) => sum + line.qty * line.unit_price_cents,
    0,
  );
}

// The closing-the-loop beat (spec 11 §4): the "existing system" the agent
// integrates with, rendered live. Rows the agent wrote are highlighted and
// link to the run that wrote them; seeded history has no run.
export default async function BackendPage() {
  await ensureSeeded();
  const backend = getBackend();
  const [vendors, firstPage, ledger, payments] = await Promise.all([
    backend.listVendors(),
    backend.listPurchaseOrders(1),
    backend.ledgerEntries(),
    backend.paymentSchedule(),
  ]);
  const pos = [...firstPage.items];
  let nextPage = firstPage.next_page;
  while (nextPage !== null) {
    const page = await backend.listPurchaseOrders(nextPage);
    pos.push(...page.items);
    nextPage = page.next_page;
  }

  return (
    <main>
      <h1>Mock ERP (live)</h1>
      <p>
        The fictional back office the agent works against, reachable by the
        agent only through its tool schemas. <mark>Highlighted rows</mark> were
        written by an agent run and link to the run that wrote them: an
        approved invoice visibly lands here. Read-only; resets nightly.
      </p>

      <section aria-labelledby="vendors-h">
        <h2 id="vendors-h">Vendors</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Id</th>
              <th scope="col">Canonical name</th>
              <th scope="col">Type</th>
              <th scope="col">Terms</th>
              <th scope="col">Default GL</th>
              <th scope="col">Active</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((vendor) => (
              <tr key={vendor.id}>
                <td>
                  <code>{vendor.id}</code>
                </td>
                <td>{vendor.canonical_name}</td>
                <td>{vendor.type}</td>
                <td>net-{vendor.terms_days}</td>
                <td>{vendor.default_gl_code}</td>
                <td>{vendor.active ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="pos-h">
        <h2 id="pos-h">Purchase orders</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Id</th>
              <th scope="col">Vendor</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Lines</th>
              <th scope="col">Total</th>
              <th scope="col">Service period</th>
            </tr>
          </thead>
          <tbody>
            {pos.map((po) => (
              <tr key={po.id}>
                <td>
                  <code>{po.id}</code>
                </td>
                <td>
                  <code>{po.vendor_id}</code>
                </td>
                <td>{po.type}</td>
                <td>{po.status}</td>
                <td>{po.lines.length}</td>
                <td>{centsToUsd(poTotalCents(po))}</td>
                <td>
                  {po.service_period
                    ? `${po.service_period.start} to ${po.service_period.end}`
                    : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="ledger-h">
        <h2 id="ledger-h">Ledger</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Id</th>
              <th scope="col">Vendor</th>
              <th scope="col">Invoice #</th>
              <th scope="col">Amount</th>
              <th scope="col">Posted</th>
              <th scope="col">Written by</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((entry) => (
              <tr key={entry.id} className={entry.run_id ? "row-agent" : ""}>
                <td>
                  <code>{entry.id}</code>
                </td>
                <td>
                  <code>{entry.vendor_id}</code>
                </td>
                <td>{entry.invoice_number}</td>
                <td>{centsToUsd(entry.amount_cents)}</td>
                <td>{entry.posted_date}</td>
                <td>
                  {entry.run_id ? (
                    <Link href={`/runs/${entry.run_id}`}>
                      <code>{entry.run_id.slice(-8)}</code>
                    </Link>
                  ) : (
                    "seeded history"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="payments-h">
        <h2 id="payments-h">Payment schedule</h2>
        {payments.length === 0 ? (
          <div className="empty">
            <p>
              Nothing scheduled. An executed run lands a payment row here:{" "}
              <Link href="/">launch a run</Link> to watch it happen.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Id</th>
                <th scope="col">Vendor</th>
                <th scope="col">Amount</th>
                <th scope="col">GL code</th>
                <th scope="col">Pay date</th>
                <th scope="col">Status</th>
                <th scope="col">Written by</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id} className="row-agent">
                  <td>
                    <code>{payment.id}</code>
                  </td>
                  <td>
                    <code>{payment.vendor_id}</code>
                  </td>
                  <td>{centsToUsd(payment.amount_cents)}</td>
                  <td>{payment.gl_code}</td>
                  <td>{payment.pay_date}</td>
                  <td>{payment.status}</td>
                  <td>
                    <Link href={`/runs/${payment.run_id}`}>
                      <code>{payment.run_id.slice(-8)}</code>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
