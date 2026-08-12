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
import { pricingFor, type RunMode } from "@novagait/agent";
import { ensureSeeded, getBackend, getStore } from "@/lib/runtime";

const MODES: RunMode[] = ["shadow", "assisted", "autonomous"];
type Lane = "mock" | "live";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    item?: string;
    mode?: string;
    approver?: string;
    lane?: string;
    model?: string;
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
    // An unpriced model id must never reach a run: the cost breaker and the
    // daily budget counter both depend on being able to price every token.
    const model = body.model ? pricingFor(body.model).model : undefined;
    return Response.json(
      await runLivePipeline({ ...common, client: new Anthropic(), model }),
    );
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
