# Vendor Master and Name Resolution

The canonical vendor list and how printed vendor names resolve against it.

## Canonical vendors

Payments are made only to vendors on the canonical vendor master. Each
vendor record carries an id, canonical name, goods/service type, payment
terms, a default GL code, and an active flag. Inactive vendors are not
payable.

## Name resolution

Printed vendor names rarely match the master exactly. Resolution first
normalizes both names (case, punctuation, and legal suffixes such as LLC,
Inc, Corp, Co, Ltd are ignored), then compares with Jaro-Winkler
similarity. A normalized exact match resolves outright; a fuzzy match
resolves only at similarity 0.90 or above, and the resolution method and
score are recorded.

## Unresolved vendors

A name that resolves to no vendor at or above the 0.90 threshold is
unresolved. Unresolved-vendor invoices never auto-pay: they route to an
exception hold for a human to either map the name to an existing vendor or
initiate vendor onboarding. Onboarding a new vendor is out of scope for the
automation.

## Vendor profiles (memory)

Each vendor accumulates a bounded profile: last seen date, exception count,
and a learned GL code where approvers consistently recode. Profile writes
happen through an audited tool call and are visible in the run trace and on
the memory page.
