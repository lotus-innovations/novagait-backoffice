# Payment Terms and Scheduling

When approved invoices are paid.

## Terms

Vendor payment terms come from the vendor master, expressed in days from
invoice date (net-15, net-30, and so on). Most Novagait vendors are net-30;
ChartNimbus EMR is net-15.

## Pay date selection

An approved invoice is scheduled for its due date: the invoice's stated due
date when present, otherwise invoice date plus the vendor's terms. Invoices
are not paid early by default; early-payment discounts are taken only when
the invoice states a discount term and the approver opts in.

## Late arrivals

An invoice that arrives already past its due date is scheduled for the next
payment run. Late fees on the invoice are payable only when a human
approver accepts them; automation never adds or accepts fees on its own.

## Scheduling record

Every scheduled payment records vendor, amount, GL code, pay date, and the
run that produced it. Transient scheduling failures are retried once and
the retry is visible in the trace.
