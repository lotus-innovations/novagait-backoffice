// Canonical trace export (spec 08 §6): one event per line, exactly as
// stored. Read-only.

import { toJsonl } from "@novagait/agent";
import { getRunTrace } from "@/lib/runs";
import { getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const events = await getRunTrace(getStore(), id);
  if (events.length === 0) {
    return new Response("run not found\n", { status: 404 });
  }
  return new Response(toJsonl(events), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${id}-trace.jsonl"`,
    },
  });
}
