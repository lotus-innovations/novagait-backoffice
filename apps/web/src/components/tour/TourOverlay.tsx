"use client";

import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { TOUR_RESUME_COPY, TOUR_STEPS } from "./steps";
import type { TourStep } from "./types";
import {
  clearState,
  getServerTourSnapshot,
  getTourSnapshot,
  matchRoute,
  placeCard,
  resolveStep,
  resumeTarget,
  routeHref,
  subscribeTour,
  writeState,
  type Rect,
  type Size,
} from "./tour-state";

const FALLBACK_CARD: Size = { width: 320, height: 220 };

function readViewport(): Size {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function findAnchor(anchor: string | null): HTMLElement | null {
  if (!anchor || !/^[A-Za-z0-9_-]+$/.test(anchor)) return null;
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
}

function toRect(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
  };
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * Move focus to the card without scrolling the page out from under the
 * visitor. The card is programmatically focusable only (tabindex -1), so it
 * never becomes an extra tab stop.
 */
function focusCard(node: HTMLElement): void {
  if (typeof document === "undefined") return;
  if (node.contains(document.activeElement)) return;
  node.focus({ preventScroll: true });
}

function sameSize(a: Size, b: Size): boolean {
  return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

export default function TourOverlay() {
  const pathname = usePathname();
  const tour = useSyncExternalStore(
    subscribeTour,
    getTourSnapshot,
    getServerTourSnapshot,
  );
  const [rect, setRect] = useState<Rect | null>(null);
  /**
   * Which beat we have measured as anchor-less, as "index:anchor". Keyed
   * rather than boolean so it cannot go stale: when the beat changes the key
   * stops matching and the flag is false again with no reset, which also
   * keeps this out of the effect body (setState there cascades renders).
   * Distinct from "not measured yet", so the card never flashes into the
   * resume pill for a frame on every step.
   */
  const [missingFor, setMissingFor] = useState<string | null>(null);
  const [cardSize, setCardSize] = useState<Size>(FALLBACK_CARD);
  const [viewport, setViewport] = useState<Size>(readViewport);

  const total = TOUR_STEPS.length;
  const active = tour.active && total > 0;
  const path = pathname || "/";
  const storedIndex = active ? Math.min(Math.max(tour.index, 0), total - 1) : 0;
  const resolved = active ? resolveStep(TOUR_STEPS, storedIndex, path) : null;
  /** Route-level match only. A pattern matches on shape, not on the record existing. */
  const routeOnTrack = resolved?.status === "on-track";
  const stepIndex = resolved
    ? Math.min(Math.max(resolved.index, 0), Math.max(total - 1, 0))
    : 0;
  const step: TourStep | undefined = active ? TOUR_STEPS[stepIndex] : undefined;
  // Derived from routeOnTrack, NOT from onTrack: making the measure target
  // depend on the measurement result would oscillate.
  const anchor = routeOnTrack && step ? step.anchor : null;
  /**
   * The beat is only truly on-track once its anchor is really on the page.
   * "/approvals/*" matches "/approvals/bad-id", which Next serves as a 404,
   * and narrating "Check the reading" over a "page could not be found" is the
   * worst thing this component could do in front of a buyer. No anchor means
   * fall back to the resume pill.
   */
  const anchorKey = `${stepIndex}:${anchor ?? ""}`;
  const onTrack = routeOnTrack && missingFor !== anchorKey;

  const navigating = useRef(false);
  const cardNode = useRef<HTMLElement | null>(null);

  const goTo = useCallback((index: number) => {
    writeState({ active: true, index });
  }, []);

  /**
   * Stage an index for a page we are about to load. No notify and no further
   * resolving: the outgoing page must not rewrite what it is handing over.
   */
  const stageAndLeave = useCallback((index: number) => {
    navigating.current = true;
    writeState({ active: true, index }, false);
  }, []);

  const endTour = useCallback(() => {
    clearState();
    // SC 2.4.3: ending the tour must not strand the visitor at the top of the
    // document. Hand focus back to the control that started it where it
    // exists; otherwise to the beat's own anchor, which is where they were
    // looking.
    if (typeof document === "undefined") return;
    const launch = document.querySelector<HTMLElement>(".tour-launch");
    if (launch) {
      launch.focus();
      return;
    }
    const main = document.querySelector<HTMLElement>("main");
    if (main) {
      main.setAttribute("tabindex", "-1");
      main.focus();
    }
  }, []);

  // A real navigation can land the visitor one step further along the script
  // than the stored index (the intake POST, "Review and decide", an action
  // link). Persist THAT, and only that.
  //
  // Strictly +1: a route pattern matches on shape, not on the record existing,
  // and the app's own nav can jump several beats at once. Persisting a jump
  // would mark every skipped beat complete for the rest of the session,
  // including beat 4, the park that the whole demo exists to show. A visitor
  // who clicks "Evals" out of curiosity still SEES beat 8, they just do not
  // lose their place getting back.
  useEffect(() => {
    if (!active || !onTrack) return;
    if (navigating.current) return;
    if (stepIndex !== storedIndex + 1) return;
    goTo(stepIndex);
  }, [active, onTrack, stepIndex, storedIndex, goTo]);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const measure = () => {
      setViewport((previous) => {
        const next = readViewport();
        return sameSize(previous, next) ? previous : next;
      });
      const element = findAnchor(anchor);
      const next = element ? toRect(element) : null;
      setRect((previous) => (sameRect(previous, next) ? previous : next));
      setMissingFor(anchor !== null && next === null ? anchorKey : null);
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    // First pass is deferred a frame so anchors rendered by this same commit
    // are measured after layout, never at 0,0.
    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [active, anchor, stepIndex, anchorKey]);

  useEffect(() => {
    if (!active || !anchor) return;
    const element = findAnchor(anchor);
    if (!element) return;
    const box = element.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight) return;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [active, anchor, stepIndex]);

  // Drives the SC 1.4.3 rescue in globals.css: muted page text is promoted to
  // --ink for exactly as long as the dimmer is on screen.
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const root = document.documentElement;
    root.setAttribute("data-tour-active", "");
    return () => root.removeAttribute("data-tour-active");
  }, [active]);

  useEffect(() => {
    if (!active || !onTrack) return;
    const node = cardNode.current;
    if (node) focusCard(node);
  }, [active, onTrack, stepIndex]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") endTour();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, endTour]);

  // Ref callback rather than an effect: the card is placed against its real
  // measured box, and the observer keeps that true as copy or width changes.
  const cardRef = useCallback((node: HTMLElement | null) => {
    cardNode.current = node;
    if (!node) return;
    // SC 2.4.11: the card is fixed-position and can sit over the very controls
    // its copy tells the visitor to operate, hiding their focus ring. Starting
    // focus ON the card means they tab OUT of it into those controls instead
    // of tabbing blindly underneath it. Not a focus trap: nothing is confined,
    // and it also gives the beat's copy a focus event to be announced by.
    focusCard(node);
    const measure = () => {
      const next = toRect(node);
      setCardSize((previous) =>
        sameSize(previous, next) ? previous : { ...next },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!active || !step || !resolved) return null;

  // Off-script: the visitor is on a page the script does not cover. Approving
  // an invoice redirects to the run page and lands exactly here, so this is a
  // normal path through the tour, not an error state.
  if (!onTrack) {
    // resumeTarget, NOT this step's own route. The stored step is the one the
    // visitor has already finished, and on the approval path its route is the
    // wildcard "/approvals/*", which yields no link at all. Scanning forward
    // for the next reachable step is what keeps them from being stranded.
    const target = resumeTarget(TOUR_STEPS, stepIndex);
    const targetStep = target ? TOUR_STEPS[target.index] : undefined;
    return (
      <div className="tour-resume" role="region" aria-label="Guided tour">
        <p aria-live="polite">{TOUR_RESUME_COPY.message}</p>
        {target && targetStep ? (
          <a
            href={target.href}
            onClick={() => stageAndLeave(target.index)}
          >{`Continue the tour: ${targetStep.title}`}</a>
        ) : null}
        <button type="button" onClick={endTour}>
          End tour
        </button>
      </div>
    );
  }

  const isLast = stepIndex === total - 1;
  const previousStep = stepIndex > 0 ? TOUR_STEPS[stepIndex - 1] : undefined;
  const nextStep = isLast ? undefined : TOUR_STEPS[stepIndex + 1];
  const nextHref = nextStep ? routeHref(nextStep.route) : null;
  const position = placeCard(rect, cardSize, viewport);

  let backControl: ReactNode = null;
  if (previousStep) {
    const backHref = routeHref(previousStep.route);
    if (matchRoute(previousStep.route, path)) {
      backControl = (
        <button type="button" onClick={() => goTo(stepIndex - 1)}>
          Back
        </button>
      );
    } else if (backHref) {
      // Different page: hand the browser a real link and stage the index
      // without notifying, so this page does not re-resolve on its way out.
      backControl = (
        <a href={backHref} onClick={() => stageAndLeave(stepIndex - 1)}>
          Back
        </a>
      );
    }
  }

  let nextControl: ReactNode = null;
  if (isLast) {
    nextControl = (
      <button type="button" onClick={endTour}>
        Finish
      </button>
    );
  } else if (step.advanceOn === "next" && nextStep) {
    nextControl =
      nextHref && !matchRoute(nextStep.route, path) ? (
        <a href={nextHref} onClick={() => stageAndLeave(stepIndex + 1)}>
          Next
        </a>
      ) : (
        <button type="button" onClick={() => goTo(stepIndex + 1)}>
          Next
        </button>
      );
  }

  return (
    <>
      {/* Scrim and ring are inert: the visitor drives the real controls.
          The scrim renders ONLY without a rect; with one, the spotlight's
          spread shadow is the dimmer and a second layer would double-dim. */}
      {rect ? null : (
        <div
          className="tour-scrim"
          aria-hidden="true"
          style={{ position: "fixed", inset: 0, pointerEvents: "none" }}
        />
      )}
      {rect ? (
        <div
          className="tour-spotlight"
          aria-hidden="true"
          style={{
            position: "fixed",
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            pointerEvents: "none",
          }}
        />
      ) : null}
      <section
        ref={cardRef}
        className="tour-card"
        tabIndex={-1}
        aria-label="Guided tour"
        style={{ position: "fixed", top: position.top, left: position.left }}
      >
        <div className="tour-card-copy" aria-live="polite" aria-atomic="true">
          <p className="tour-progress">
            Step {stepIndex + 1} of {total}
          </p>
          <h2>{step.title}</h2>
          <p>{step.body}</p>
          {step.advanceOn === "action" && step.actionLabel ? (
            <p>
              {step.actionHref ? (
                <a href={step.actionHref}>{step.actionLabel}</a>
              ) : (
                <strong>{step.actionLabel}</strong>
              )}
            </p>
          ) : null}
        </div>
        <div className="tour-controls">
          {backControl}
          {nextControl}
          {isLast ? null : (
            <button type="button" onClick={endTour}>
              Skip tour
            </button>
          )}
        </div>
      </section>
    </>
  );
}
