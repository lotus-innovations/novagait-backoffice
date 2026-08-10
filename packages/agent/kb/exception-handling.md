# Exception Handling and Vendor Communication

What happens when an invoice cannot be cleanly processed.

## Exception holds

Any match exception, duplicate flag, or unresolved vendor routes the
invoice to an exception hold. A held invoice is parked with its full
extraction, the exception codes, and a drafted vendor email; nothing is
posted to the ledger and no payment is scheduled.

## Exception vocabulary

The system uses a fixed exception vocabulary: `missing_po_reference`,
`po_not_found`, `po_closed`, `po_vendor_mismatch`,
`price_variance_exceeds_tolerance`, `receiving_record_missing`,
`qty_billed_exceeds_received`, `non_usd_currency`, plus duplicate and
unresolved-vendor flags. Hold summaries quote codes verbatim so downstream
reporting can aggregate them.

## Vendor email drafts

The drafted email states what was received, which check failed, and what
the vendor should send to cure it (a corrected invoice, a PO reference, a
credit memo). Drafts are reviewed and sent by a human; automation never
sends vendor communications directly.

## Rejections

Documents that are not invoices at all (marketing, statements,
misdirected mail) are rejected with a note rather than held. Rejection is
terminal; nothing is drafted against the ERP.
