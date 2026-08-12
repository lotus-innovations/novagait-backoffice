// Dev-gated run trigger for dev, previews, and e2e. Two lanes, and the lane
// is always explicit:
//
//   lane "mock" (the default, unchanged): available only when the mock agent
//   is active. This is what /runs demos before intake and what the e2e suite
//   drives.
//
//   lane "live": the real model. Available only when LIVE_AGENT=1 AND a key
//   is present, and only on this route. ANTHROPIC_API_KEY is not configured
//   on Vercel, so the deployed demo cannot reach it; /api/intake - the only
//   surface a visitor can reach - has no live branch at all and answers
//   "unavailable" when the mock lane is off. A live run costs money, so it
//   never happens by default, never by fallback, and never by inference from
//   the environment: the caller has to ask for it by name.

import Anthropic from "@anthropic-ai/sdk";
import {
  isLiveLaneEnabled,
  isMockMode,
  runLivePipeline,
  runMockPipeline,
} from "@novagait/pipeline";
import { isCapacityMode, type RunMode } from "@novagait/agent";
import { ensureSeeded, getBackend, getStore } from "@/lib/runtime";

const MODES: RunMode[] = ["shadow", "assisted", "autonomous"];

// The live branch is pinned to the cheapest model on the pricing table. This
// route exists for dev and demo verification, not for model comparison: the
// LOT-105 matrix drives createLivePipeline directly and picks its own models,
// so an operator-supplied model here would only be a way to spend more.
const LIVE_MODEL = "claude-haiku-4-5";
type Lane = "mock" | "live";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    item?: string;
    mode?: string;
    approver?: string;
    lane?: string;
    note?: string;
  };
  const lane: Lane = body.lane === "live" ? "live" : "mock";

  if (lane === "mock" && !isMockMode()) {
    return Response.json(
      { error: "dev run endpoint is mock-mode only" },
      { status: 403 },
    );
  }
  if (lane === "live" && !isLiveLaneEnabled()) {
    return Response.json(
      { error: "live lane requires LIVE_AGENT=1 and ANTHROPIC_API_KEY" },
      { status: 403 },
    );
  }

  // Capacity mode is the daily spend breaker (containment.ts). runLivePipeline
  // accumulates into the counter but deliberately does not consult it; this
  // route shares one process-wide store, so here the counter means something
  // and is checked before a run can add to it.
  if (lane === "live" && (await isCapacityMode(getStore()))) {
    return Response.json(
      { error: "capacity mode: daily live budget reached" },
      { status: 503 },
    );
  }

  await ensureSeeded();
  const mode = MODES.includes(body.mode as RunMode)
    ? (body.mode as RunMode)
    : "autonomous";
  const approver = body.approver === "script" ? "script" : "none";
  const common = {
    store: getStore(),
    backend: getBackend(),
    inboxItemId: body.item ?? "INB-001",
    mode,
    approver,
    note: body.note,
  } as const;

  try {
    if (lane === "mock") {
      return Response.json(await runMockPipeline(common));
    }
    return Response.json(
      await runLivePipeline({
        ...common,
        client: new Anthropic(),
        model: LIVE_MODEL,
      }),
    );
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
