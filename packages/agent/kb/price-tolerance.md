# Price Variance Tolerance

Allowed difference between invoiced line totals and purchase-order line
totals.

## The tolerance rule

Per matched line, the invoiced total may differ from the PO line total by at
most the greater of 2% of the PO line total or $25.00. Formally:
allowed variance = max(2% of PO line total, $25.00).

## Over-tolerance handling

A line outside tolerance raises the `price_variance_exceeds_tolerance`
exception. The invoice is not partially paid: the whole document routes to
an exception hold, and the drafted vendor email cites the offending line,
the PO price, and the invoiced price.

## Under-billing

Invoices under the PO amount within tolerance are payable as billed. Large
under-billings are not exceptions but are worth an approver glance; the
match summary shows the delta.

## Currency

All purchase orders are denominated in USD. An invoice in any other
currency raises the `non_usd_currency` exception and is held for manual
review; there is no automatic FX conversion.
