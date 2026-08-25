import {
  APPROVAL_HANDOFF_STEP_ID,
  APPROVAL_RETURN_ROUTE,
  TOUR_APPROVED_COPY,
  TOUR_RESUME_COPY,
} from "./steps";
import { matchRoute } from "./tour-state";
import type { TourStep } from "./types";

export interface ResumePillCopy {
  message: string;
  /** Null only when no reachable step remains, which hides the link. */
  linkLabel: string | null;
}

/**
 * What the off-script pill says. Two arrivals reach it and they mean opposite
 * things: a genuine detour (manual navigation) gets the generic message, while
 * the redirect that follows an approval is the script working, so it gets
 * progress copy. Pure so both branches stay testable without a DOM.
 */
export function resumePillCopy(
  targetStep: TourStep | undefined,
  path: string,
): ResumePillCopy {
  if (
    targetStep &&
    targetStep.id === APPROVAL_HANDOFF_STEP_ID &&
    matchRoute(APPROVAL_RETURN_ROUTE, path)
  ) {
    return {
      message: TOUR_APPROVED_COPY.message,
      linkLabel: TOUR_APPROVED_COPY.linkLabel,
    };
  }
  return {
    message: TOUR_RESUME_COPY.message,
    linkLabel: targetStep ? `Continue the tour: ${targetStep.title}` : null,
  };
}
