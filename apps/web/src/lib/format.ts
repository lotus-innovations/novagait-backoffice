// Shared display formatting for the viewer pages. Two jobs: render stored
// ISO-UTC instants as something a person reads, and refuse to print the
// parser's date sentinel as if it were a date the document actually carried.

import { INVOICE_DATE_SENTINEL } from "@novagait/pipeline";

export const UNREADABLE_DATE_LABEL = "could not read the date";

/** True when the parser stored its sentinel because no date could be read. */
export function isUnreadableDate(value: string | null | undefined): boolean {
  return value === INVOICE_DATE_SENTINEL;
}

/**
 * "2026-08-25T20:52:20.254Z" -> "2026-08-25 20:52 UTC". Values that are not
 * parsable instants pass through unchanged rather than becoming "Invalid Date".
 */
export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return "-";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  return `${date} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}
