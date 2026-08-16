import { afterEach, describe, expect, it, vi } from "vitest";
import type { TourStep } from "./types";
import {
  TOUR_STORAGE_KEY,
  clearState,
  matchRoute,
  placeCard,
  readState,
  resolveStep,
  resumeTarget,
  routeHref,
  writeState,
} from "./tour-state";

/** Mirrors the 8 beats of the contract; copy is irrelevant to the mechanism. */
const STEPS: TourStep[] = [
  {
    id: "intro",
    route: "/",
    anchor: "intro",
    title: "",
    body: "",
    advanceOn: "next",
  },
  {
    id: "intake",
    route: "/",
    anchor: "intake-form",
    title: "",
    body: "",
    advanceOn: "action",
  },
  {
    id: "timeline",
    route: "/runs/*",
    anchor: "run-timeline",
    title: "",
    body: "",
    advanceOn: "next",
  },
  {
    id: "the-park",
    route: "/runs/*",
    anchor: "approval-banner",
    title: "",
    body: "",
    advanceOn: "next",
  },
  {
    id: "approve",
    route: "/approvals/*",
    anchor: "evidence-table",
    title: "",
    body: "",
    advanceOn: "action",
  },
  {
    id: "erp",
    route: "/backend",
    anchor: "erp-rows",
    title: "",
    body: "",
    advanceOn: "next",
  },
  {
    id: "memory",
    route: "/memory",
    anchor: "vendor-profiles",
    title: "",
    body: "",
    advanceOn: "next",
  },
  {
    id: "evals",
    route: "/eval",
    anchor: "eval-headline",
    title: "",
    body: "",
    advanceOn: "next",
  },
];

function stubWindow(seed: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(seed));
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    },
    dispatchEvent: () => true,
  });
  return data;
}

function stubThrowingWindow() {
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
    },
    dispatchEvent: () => true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("matchRoute", () => {
  it("matches exact routes only", () => {
    expect(matchRoute("/", "/")).toBe(true);
    expect(matchRoute("/", "/backend")).toBe(false);
    expect(matchRoute("/backend", "/backend")).toBe(true);
    expect(matchRoute("/backend", "/")).toBe(false);
    expect(matchRoute("/backend", "/backend-extra")).toBe(false);
    expect(matchRoute("/eval", "/evaluation")).toBe(false);
  });

  it("honours the trailing-wildcard boundary", () => {
    expect(matchRoute("/runs/*", "/runs/abc")).toBe(true);
    expect(matchRoute("/runs/*", "/runs/abc/trace")).toBe(true);
    expect(matchRoute("/runs/*", "/runs")).toBe(false);
    expect(matchRoute("/runs/*", "/runs/")).toBe(false);
    expect(matchRoute("/runs/*", "/runsfoo")).toBe(false);
    expect(matchRoute("/runs/*", "/")).toBe(false);
    expect(matchRoute("/approvals/*", "/approvals/run_123")).toBe(true);
    expect(matchRoute("/approvals/*", "/approvals")).toBe(false);
  });

  it("ignores a trailing slash, query and hash on the pathname", () => {
    expect(matchRoute("/backend", "/backend/")).toBe(true);
    expect(matchRoute("/", "")).toBe(true);
    expect(matchRoute("/runs/*", "/runs/abc?tab=trace")).toBe(true);
    expect(matchRoute("/runs/*", "/runs/abc#top")).toBe(true);
  });

  it("rejects an empty pattern", () => {
    expect(matchRoute("", "/")).toBe(false);
  });
});

describe("resolveStep", () => {
  it("stays put when the stored step matches the pathname", () => {
    expect(resolveStep(STEPS, 0, "/")).toEqual({
      index: 0,
      status: "on-track",
    });
    expect(resolveStep(STEPS, 1, "/")).toEqual({
      index: 1,
      status: "on-track",
    });
  });

  it("advances to the first matching step after a real navigation", () => {
    // Beat 2 is the intake form; submitting redirects to the run page.
    expect(resolveStep(STEPS, 1, "/runs/run_42")).toEqual({
      index: 2,
      status: "on-track",
    });
    // Beat 4 -> the visitor opens the approval from the banner.
    expect(resolveStep(STEPS, 3, "/approvals/run_42")).toEqual({
      index: 4,
      status: "on-track",
    });
  });

  it("never searches backwards", () => {
    // Stored at beat 3 (/runs/*) but the visitor is back on the landing page:
    // step 0 also matches "/" and must NOT be selected.
    expect(resolveStep(STEPS, 2, "/")).toEqual({
      index: 2,
      status: "off-script",
    });
  });

  it("goes off-script on the approval redirect (beat 5 -> 6)", () => {
    // Approving redirects to /runs/{id}, not /backend. No step at or after
    // index 4 matches /runs/*, so the resume pill has to take over.
    expect(resolveStep(STEPS, 4, "/runs/run_42")).toEqual({
      index: 4,
      status: "off-script",
    });
  });

  it("goes off-script on a route the tour never visits", () => {
    expect(resolveStep(STEPS, 0, "/admin")).toEqual({
      index: 0,
      status: "off-script",
    });
    expect(resolveStep([], 0, "/")).toEqual({ index: 0, status: "off-script" });
  });

  it("treats a junk stored index as the start of the list", () => {
    expect(resolveStep(STEPS, -3, "/")).toEqual({
      index: 0,
      status: "on-track",
    });
    expect(resolveStep(STEPS, Number.NaN, "/")).toEqual({
      index: 0,
      status: "on-track",
    });
  });
});

describe("session storage round trip", () => {
  it("is inactive with no window (server render)", () => {
    expect(readState()).toEqual({ active: false, index: 0 });
    expect(() => writeState({ active: true, index: 2 })).not.toThrow();
    expect(() => clearState()).not.toThrow();
  });

  it("round trips an active tour", () => {
    const data = stubWindow();
    writeState({ active: true, index: 3 });
    expect(data.get(TOUR_STORAGE_KEY)).toBe('{"active":true,"index":3}');
    expect(readState()).toEqual({ active: true, index: 3 });
    clearState();
    expect(data.has(TOUR_STORAGE_KEY)).toBe(false);
    expect(readState()).toEqual({ active: false, index: 0 });
  });

  it("fails closed on corrupt or absent payloads", () => {
    stubWindow();
    expect(readState()).toEqual({ active: false, index: 0 });

    for (const junk of [
      "not json",
      "null",
      "[]",
      '"string"',
      "{}",
      '{"active":"yes","index":1}',
      '{"active":true}',
      '{"active":true,"index":"2"}',
      '{"active":true,"index":-1}',
      '{"active":true,"index":1.5}',
    ]) {
      stubWindow({ [TOUR_STORAGE_KEY]: junk });
      expect(readState()).toEqual({ active: false, index: 0 });
    }
  });

  it("survives storage that throws", () => {
    stubThrowingWindow();
    expect(readState()).toEqual({ active: false, index: 0 });
    expect(() => writeState({ active: true, index: 1 })).not.toThrow();
    expect(() => clearState()).not.toThrow();
  });
});

describe("placeCard", () => {
  const viewport = { width: 1200, height: 800 };
  const card = { width: 320, height: 200 };

  it("centres the card when there is no anchor", () => {
    expect(placeCard(null, card, viewport)).toEqual({ top: 300, left: 440 });
  });

  it("sits below an anchor near the top", () => {
    const anchor = { top: 100, left: 200, width: 400, height: 60 };
    expect(placeCard(anchor, card, viewport)).toEqual({ top: 176, left: 200 });
  });

  it("flips above an anchor near the bottom", () => {
    const anchor = { top: 620, left: 200, width: 400, height: 60 };
    expect(placeCard(anchor, card, viewport)).toEqual({ top: 404, left: 200 });
  });

  it("goes beside an anchor that fills the viewport height", () => {
    const anchor = { top: 10, left: 10, width: 300, height: 780 };
    expect(placeCard(anchor, card, viewport)).toEqual({ top: 12, left: 326 });
  });

  it("clamps the card inside the viewport", () => {
    const anchor = { top: 100, left: 1150, width: 40, height: 40 };
    const placed = placeCard(anchor, card, viewport);
    expect(placed.left).toBe(viewport.width - card.width - 12);
    expect(placed.top).toBe(156);
  });

  it("never leaves the viewport when nothing fits", () => {
    const tiny = { width: 320, height: 300 };
    const anchor = { top: 0, left: 0, width: 320, height: 300 };
    const placed = placeCard(anchor, card, tiny);
    expect(placed.top).toBeGreaterThanOrEqual(12);
    expect(placed.left).toBeGreaterThanOrEqual(12);
  });
});

describe("routeHref", () => {
  it("returns a concrete route and refuses a wildcard", () => {
    expect(routeHref("/backend")).toBe("/backend");
    expect(routeHref("/")).toBe("/");
    // Emitting href="/runs/*" would be a broken link on the page.
    expect(routeHref("/runs/*")).toBeNull();
    expect(routeHref("/approvals/*")).toBeNull();
  });
});

describe("resumeTarget", () => {
  it("sends a wandering visitor back to the step they were on", () => {
    // Beat 1 lives on "/", which is navigable: go back to it, not forward.
    expect(resumeTarget(STEPS, 0)).toEqual({ index: 0, href: "/" });
  });

  it("scans forward when the stored step's route cannot be linked to", () => {
    // The flagship path: approving on /approvals/{id} redirects to /runs/{id}.
    // Beat 5's own route is "/approvals/*", which is not a navigable href, so
    // the pill must reach forward to beat 6 (/backend) instead of pointing at
    // the step the visitor just finished.
    expect(resumeTarget(STEPS, 4)).toEqual({ index: 5, href: "/backend" });
  });

  it("sanitises a junk stored index instead of indexing out of range", () => {
    for (const junk of [-3, Number.NaN, 1.5]) {
      expect(resumeTarget(STEPS, junk)).toEqual({ index: 0, href: "/" });
    }
  });

  it("returns null when no later step is reachable", () => {
    const wildcardsOnly: TourStep[] = [
      {
        id: "only",
        route: "/runs/*",
        anchor: null,
        title: "",
        body: "",
        advanceOn: "next",
      },
    ];
    expect(resumeTarget(wildcardsOnly, 0)).toBeNull();
  });
});

describe("resolveStep off-script index hygiene", () => {
  it("returns a sanitised index when it goes off-script, never the raw one", () => {
    // Off-script feeds the pill, which indexes TOUR_STEPS with this value.
    for (const junk of [-3, Number.NaN, 1.5]) {
      const out = resolveStep(STEPS, junk, "/nowhere");
      expect(out.status).toBe("off-script");
      expect(out.index).toBe(0);
    }
  });
});

describe("index hygiene above the step count (D6)", () => {
  // The clamp that makes these unreachable lives in TourOverlay, not in these
  // functions. Pinning the boundary here so a refactor that moves the clamp
  // cannot silently reintroduce the "stranded, no link" state.
  it("resolveStep does not return an out-of-range index", () => {
    const out = resolveStep(STEPS, 99, "/runs/r1");
    expect(out.status).toBe("off-script");
    expect(out.index).toBeLessThan(STEPS.length);
  });

  it("resumeTarget never returns an out-of-range index", () => {
    const out = resumeTarget(STEPS, 99);
    if (out) expect(out.index).toBeLessThan(STEPS.length);
    else expect(out).toBeNull();
  });
});
