import type { TourStep } from "./types";

/**
 * The eight beats of the guided tour (LOT-118).
 *
 * Copy rules, from the ticket and the Lotus voice standard: a non-technical
 * business owner reads these cards, so no system vocabulary appears in them.
 * No card states a dollar threshold. Every threshold lives in
 * packages/agent/src/policy-constants.ts, and a literal anywhere else is a bug,
 * so the cards describe limits qualitatively instead.
 *
 * Beat 4 is the pivot the demo exists to show: the invoice stops even in
 * Autonomous mode. Beat 8 stays inside what /eval itself publishes, which is a
 * NO-GO for fully autonomous operation.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "intro",
    route: "/",
    anchor: "intro",
    title: "The back office",
    body: "This demo runs an accounts payable desk. The agent reads a supplier invoice and matches it to your order. Every step it takes stays visible.",
    advanceOn: "next",
  },
  {
    id: "intake",
    route: "/",
    anchor: "intake-form",
    title: "Start a run",
    body: "Pick the invoice named INB-005. Choose Autonomous, the mode that acts without asking first. Then press Run the agent.",
    advanceOn: "action",
    actionLabel: "Submit the form to continue.",
    actionHref: null,
  },
  {
    id: "timeline",
    route: "/runs/*",
    anchor: "run-timeline",
    title: "The work, step by step",
    body: "Here is what the agent did, in order. It read the invoice, identified the vendor, and compared the lines to your order. Open any step to see the detail behind it.",
    advanceOn: "next",
  },
  {
    id: "the-park",
    route: "/runs/*",
    anchor: "approval-banner",
    title: "Where it stops",
    body: "The agent stopped and asked for a person. The invoice price differs slightly from the order, inside the allowed range but not zero. The policy calls that an exception.",
    // "action", not "next": the next beat lives on /approvals/{id}, and that
    // id only exists on this page. A Next button here stored an index whose
    // wildcard route no later scan could reach, so it fell through to the
    // resume pill and skipped beat 5, the evidence beat, entirely.
    advanceOn: "action",
    actionLabel: "Open the approval to continue.",
    actionHref: null,
  },
  {
    id: "approve",
    route: "/approvals/*",
    anchor: "evidence-table",
    title: "Check the reading",
    body: "Each field shows the exact words printed on the invoice. You compare what the machine read against the document itself. Approve it once the reading looks right.",
    advanceOn: "action",
    actionLabel: "Approve the invoice to continue.",
    actionHref: null,
  },
  {
    id: "erp",
    route: "/backend",
    anchor: "erp-rows",
    title: "Into the books",
    body: "Your approval wrote these rows into the accounting system. The screen highlights the new rows. Each one links back to the run that created it.",
    advanceOn: "action",
    actionLabel: "See what the system remembers",
    actionHref: "/memory",
  },
  {
    id: "memory",
    route: "/memory",
    anchor: "vendor-profiles",
    title: "What it remembers",
    body: "The system keeps a profile for each vendor, so the next invoice goes faster. It also records every document it has handled. The same invoice cannot be paid twice.",
    advanceOn: "action",
    actionLabel: "Open the test results",
    actionHref: "/eval",
  },
  {
    id: "evals",
    route: "/eval",
    anchor: "eval-headline",
    title: "The proof, and the limits",
    body: "This page grades the agent against a fixed set of test cases. The results say no to running fully on its own. They do support the mode where a person approves.",
    advanceOn: "next",
  },
];

/**
 * Copy for the off-script pill (.tour-resume).
 *
 * The visitor can leave the tour path at more than one point. Approving an
 * invoice redirects to the run page, and any manual navigation does the same
 * thing. So this message stays generic and names no destination. The overlay
 * derives the pill's link from the next step's route; a target hardcoded here
 * would be wrong from every position except one.
 */
export const TOUR_RESUME_COPY = {
  message:
    "You have stepped off the tour path. The tour can pick up where it left off.",
} as const;

/** Words on the button that starts the walkthrough. Rendered by Lane A. */
export const TOUR_LAUNCH_LABEL = "Take the guided tour";
