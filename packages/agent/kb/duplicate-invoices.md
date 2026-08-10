# Duplicate Invoice Policy

Preventing double payment of the same obligation.

## Dedupe ledger

Every inbound document is fingerprinted with a normalized-content digest
(whitespace-collapsed text, hashed). The digest is recorded in the dedupe
ledger with the run that processed it. A document whose digest already
appears in the ledger is a resubmission: the prior run is cited and the new
document is not processed as a fresh invoice.

## ERP ledger check

Independently of the content digest, an invoice number already posted for
the same resolved vendor in the ERP ledger is a duplicate. Vendor plus
invoice number is the business key; a changed PDF with the same invoice
number still counts as a duplicate.

## Handling

A duplicate never auto-pays. The run routes to an exception hold citing the
prior submission (run id or ledger row). If the vendor genuinely re-issued
the invoice (corrected amount, new invoice number), the corrected document
processes as a new invoice and the hold note says so.

## Retention

Dedupe ledger entries are retained for the demo day (24 hours) and reset
nightly with the rest of the mock environment.
