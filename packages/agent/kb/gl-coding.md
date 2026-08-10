# GL Coding Policy

How invoices are coded to the general ledger.

## Chart of accounts (AP-relevant codes)

Clinic supplies and other goods post to 5100. Service spend posts to the
6000 range: billing services 6100, EMR and software subscriptions 6200,
facilities services 6300, equipment leasing 6400. The vendor master carries
each vendor's default GL code.

## Default and learned codes

A payment draft uses the vendor's default GL code unless the vendor profile
carries a learned GL code. A learned code is recorded when approvers have
recoded the vendor's invoices consistently; it then takes precedence over
the default until the vendor master itself is corrected.

## Recoding at approval

Approvers may edit the GL code on a drafted payment before approving. The
edit is recorded with the approval decision, and repeated recodes should
flow back into the vendor profile as a learned GL code rather than being
re-entered every run.

## Split coding

Splitting one invoice across multiple GL codes is out of scope for the
automation; such invoices are drafted against the single best code and
flagged for the approver in the summary.
