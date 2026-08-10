// Mock-lane run trigger for dev, previews, and e2e (available ONLY when the
// mock agent is active: never a live-spend surface). The real intake UI is
// LOT-103; this endpoint is what makes /runs demoable before it and what
// the e2e suite drives.

import { isMockMode, runMockPipeline } from "@novagait/pipeline";
import type { RunMode } from "@novagait/agent";
import { ensureSeeded, getBackend, getStore } from "@/lib/runtime";

const MODES: RunMode[] = ["shadow", "assisted", "autonomous"];

export async function POST(request: Request) {
  if (!isMockMode()) {
    return Response.json(
      { error: "dev run endpoint is mock-mode only" },
      { status: 403 },
    );
  }
  await ensureSeeded();
  const body = (await request.json().catch(() => ({}))) as {
    item?: string;
    mode?: string;
    approver?: string;
  };
  const mode = MODES.includes(body.mode as RunMode)
    ? (body.mode as RunMode)
    : "autonomous";
  try {
    const result = await runMockPipeline({
      store: getStore(),
      backend: getBackend(),
      inboxItemId: body.item ?? "INB-001",
      mode,
      approver: body.approver === "script" ? "script" : "none",
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
