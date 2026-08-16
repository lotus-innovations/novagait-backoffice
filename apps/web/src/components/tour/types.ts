export type TourAdvance = "next" | "action";

export type TourStep = {
  /** stable slug, used by e2e and sessionStorage; never renumber */
  id: string;
  /** glob against location.pathname: "/", "/runs/*", "/approvals/*", "/backend", "/memory", "/eval" */
  route: string;
  /** value of the data-tour attribute to spotlight; null = centered card, no spotlight */
  anchor: string | null;
  /** card heading, business language */
  title: string;
  /** card body, business language, 1-3 short sentences */
  body: string;
  /**
   * "next"   -> card shows a Next button that moves to the following step.
   * "action" -> the visitor must do the real thing. Card shows `actionLabel`
   *             as a REAL <a href={actionHref}> (or, when actionHref is null,
   *             instructions only, e.g. "submit the form"). The tour advances
   *             when the next step's route matches the new pathname.
   */
  advanceOn: TourAdvance;
  actionLabel?: string;
  actionHref?: string | null;
};
