# Three-Way Match Policy

How an inbound invoice is matched before payment. A clean match requires
agreement between the invoice, the purchase order, and (for goods) the
receiving record.

## Goods purchases

Goods invoices match on three documents: the invoice lines, the open
purchase order lines, and the receiving record for that PO. Quantity billed
must not exceed quantity received on any line. A missing receiving record is
an exception; the invoice is held until receiving posts.

## Service purchases

Service purchase orders carry no receiving record. Service invoices match
two ways: invoice lines against PO lines, and the invoice's service period
must fall within the PO's stated service period. Billing outside the service
period is an exception.

## Purchase order requirements

Every invoice must reference an open purchase order. A missing PO reference,
a PO that cannot be found, a closed PO, or a PO issued to a different vendor
than the invoice's resolved vendor are each match exceptions
(`missing_po_reference`, `po_not_found`, `po_closed`, `po_vendor_mismatch`).

## Match outcome

A fully matched invoice proceeds to the routing decision. Any exception
routes the invoice to an exception hold with a drafted vendor communication;
the exception codes are listed verbatim in the hold summary.
