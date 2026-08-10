# Approval Authority and Autonomy Limits

Novagait Physical Therapy accounts-payable policy on who (or what) may
approve an invoice for payment. All amounts are invoice totals in USD.

## Autonomy cap

A fully matched invoice with a total at or under $500.00 may be approved and
scheduled for payment without a human in the loop, provided the vendor is
resolved against the vendor master and no policy exception is open. Above
$500.00, a named approver must review the drafted action before execution.

## Hard escalation floor

Any invoice with a total at or above $5,000.00 always requires human
approval, regardless of match quality, vendor history, or operating mode.
There are no exceptions to the floor; automation may draft the action but
must not execute it.

## What autonomy never covers

Automation must never approve its own exception: a duplicate flag, an
unresolved vendor, a failed three-way match, or any guardrail block routes
the invoice to a human queue. Autonomy applies only to clean, in-policy
invoices under the cap.

## Approval records

Every approval decision records the actor, the decision, the reason, and the
policy line that produced the route. Approval decisions are part of the run
trace and are auditable after the fact.
