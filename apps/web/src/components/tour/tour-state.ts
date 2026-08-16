import type { TourStep } from "./types";

export type TourState = { active: boolean; index: number };

export type TourStatus = "on-track" | "off-script";

export type ResolvedStep = { index: number; status: TourStatus };

export type Rect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type Size = { width: number; height: number };

export const TOUR_STORAGE_KEY = "novagait.tour.v1";

/**
 * Same-document signal so the launch button and the overlay stay in sync
 * without a shared React tree (the overlay lives in the root layout).
 */
export const TOUR_CHANGE_EVENT = "novagait:tour-change";

const CARD_GAP = 16;
const VIEWPORT_MARGIN = 12;

function inactiveState(): TourState {
  return { active: false, index: 0 };
}

function normalizePath(pathname: string): string {
  if (typeof pathname !== "string" || pathname.length === 0) return "/";
  const bare = pathname.split(/[?#]/)[0];
  if (bare.length === 0) return "/";
  if (bare.length > 1 && bare.endsWith("/")) {
    return bare.replace(/\/+$/, "") || "/";
  }
  return bare;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * A usable index into `steps`, whatever arrives. The invariant belongs here,
 * not in the caller: an out-of-range index made resolveStep return a step that
 * does not exist, which is exactly the "off-script with no link" state the
 * resume pill is supposed to make impossible.
 */
function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isInteger(index) || index < 0) return 0;
  return Math.min(index, length - 1);
}

/**
 * Exact match ("/", "/backend") or a single trailing wildcard ("/runs/*").
 * "/runs/*" matches "/runs/abc" but never "/runs" or "/runsfoo".
 */
export function matchRoute(pattern: string, pathname: string): boolean {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  const path = normalizePath(pathname);
  const raw = pattern.trim();
  if (raw.endsWith("/*")) {
    const prefix = normalizePath(raw.slice(0, -2));
    const base = prefix === "/" ? "/" : `${prefix}/`;
    return path.startsWith(base) && path.length > base.length;
  }
  return path === normalizePath(raw);
}

/**
 * First step at or after `storedIndex` whose route matches the current
 * pathname. Never searches backwards: the tour only moves forward on its own.
 * No match means the visitor left the scripted path.
 */
export function resolveStep(
  steps: readonly TourStep[],
  storedIndex: number,
  pathname: string,
): ResolvedStep {
  const start = clampIndex(storedIndex, steps.length);
  for (let i = start; i < steps.length; i += 1) {
    const step = steps[i];
    if (step && matchRoute(step.route, pathname)) {
      return { index: i, status: "on-track" };
    }
  }
  // `start`, not `storedIndex`: the raw value may be negative, fractional or
  // NaN, and the off-script pill indexes TOUR_STEPS with whatever comes back.
  return { index: start, status: "off-script" };
}

function parseState(raw: string | null): TourState {
  if (!raw) return inactiveState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return inactiveState();
    const { active, index } = parsed as { active?: unknown; index?: unknown };
    if (typeof active !== "boolean") return inactiveState();
    if (typeof index !== "number") return inactiveState();
    if (!Number.isInteger(index) || index < 0) return inactiveState();
    return { active, index };
  } catch {
    // Corrupt payload: fail closed to "no tour running".
    return inactiveState();
  }
}

function readRaw(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(TOUR_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies).
    return null;
  }
}

export function readState(): TourState {
  if (typeof window === "undefined") return inactiveState();
  return parseState(readRaw());
}

const SERVER_SNAPSHOT: TourState = { active: false, index: 0 };

let snapshotRaw: string | null = null;
let snapshotValue: TourState = SERVER_SNAPSHOT;
let snapshotPrimed = false;

/**
 * useSyncExternalStore contract: the returned object must keep its identity
 * while the stored payload is unchanged, or React re-renders forever.
 */
export function getTourSnapshot(): TourState {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  const raw = readRaw();
  if (!snapshotPrimed || raw !== snapshotRaw) {
    snapshotPrimed = true;
    snapshotRaw = raw;
    snapshotValue = parseState(raw);
  }
  return snapshotValue;
}

export function getServerTourSnapshot(): TourState {
  return SERVER_SNAPSHOT;
}

export function subscribeTour(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(TOUR_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(TOUR_CHANGE_EVENT, onChange);
}

/**
 * `notify: false` is for handlers that immediately hand the browser a real
 * navigation. Skipping the event keeps the outgoing page from re-rendering
 * (and re-resolving) against a pathname it is about to leave.
 */
export function writeState(state: TourState, notify: boolean = true): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The tour is decorative; a failed write must not break the page.
  }
  if (notify) notifyTourChange();
}

export function clearState(notify: boolean = true): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(TOUR_STORAGE_KEY);
  } catch {
    // See writeState.
  }
  if (notify) notifyTourChange();
}

export function notifyTourChange(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(TOUR_CHANGE_EVENT));
  } catch {
    // Event constructor missing (non-browser host): nothing to notify.
  }
}

/**
 * Viewport-fixed position for the tour card. Prefers the side of the anchor
 * with room, so the card never covers its own spotlight, and always clamps
 * inside the viewport. A null anchor centres the card.
 */
export function placeCard(
  anchor: Rect | null,
  card: Size,
  viewport: Size,
  gap: number = CARD_GAP,
  margin: number = VIEWPORT_MARGIN,
): { top: number; left: number } {
  const maxLeft = viewport.width - card.width - margin;
  const maxTop = viewport.height - card.height - margin;

  if (!anchor) {
    return {
      top: clamp((viewport.height - card.height) / 2, margin, maxTop),
      left: clamp((viewport.width - card.width) / 2, margin, maxLeft),
    };
  }

  const anchorBottom = anchor.top + anchor.height;
  const anchorRight = anchor.left + anchor.width;
  const below = anchorBottom + gap;
  const above = anchor.top - gap - card.height;
  const toRight = anchorRight + gap;
  const toLeft = anchor.left - gap - card.width;

  if (below + card.height <= viewport.height - margin) {
    return { top: below, left: clamp(anchor.left, margin, maxLeft) };
  }
  if (above >= margin) {
    return { top: above, left: clamp(anchor.left, margin, maxLeft) };
  }
  if (toRight + card.width <= viewport.width - margin) {
    return { top: clamp(anchor.top, margin, maxTop), left: toRight };
  }
  if (toLeft >= margin) {
    return { top: clamp(anchor.top, margin, maxTop), left: toLeft };
  }

  const preferAbove = anchor.top > viewport.height - anchorBottom;
  return {
    top: clamp(preferAbove ? above : below, margin, maxTop),
    left: clamp(anchor.left, margin, maxLeft),
  };
}

/** A route we can link to directly, or null when it needs a real record id. */
export function routeHref(route: string): string | null {
  return typeof route === "string" && !route.includes("*") ? route : null;
}

/**
 * Where the off-script pill sends the visitor, and what to call the link.
 *
 * Two shapes reach this, and they want opposite answers:
 *  1. The visitor merely wandered off a step whose own route is navigable
 *     (clicked "Runs" in the nav during beat 1). Send them BACK to that step.
 *  2. The stored step's route is a wildcard we cannot navigate to, which is
 *     what the approval redirect produces: beat 5 lives on "/approvals/*",
 *     approving lands on /runs/{id}, and there is no way to link to
 *     "/approvals/*". Scan FORWARD to the next step we can actually reach.
 *
 * Returning the stored step in case 2 is the bug this function exists to
 * prevent: it points at a step already completed and yields no link at all,
 * stranding the visitor mid-tour.
 */
export function resumeTarget(
  steps: readonly TourStep[],
  storedIndex: number,
): { index: number; href: string } | null {
  const start = clampIndex(storedIndex, steps.length);
  for (let i = start; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step) continue;
    const href = routeHref(step.route);
    if (href) return { index: i, href };
  }
  return null;
}
