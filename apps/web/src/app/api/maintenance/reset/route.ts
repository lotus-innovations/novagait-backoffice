// Nightly demo reset (LOT-92, spec 11 §1, spec 13 §4). Invoked by Vercel
// Cron (GET with `Authorization: Bearer ${CRON_SECRET}`) or manually (same
// header). Restores seed state and clears runs, traces, approvals, vendor
// profiles, dedupe ledger, and the failure toggle.

import { resetDemo } from "@novagait/pipeline";
import { getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

async function handleReset(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "maintenance disabled: CRON_SECRET not configured" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await resetDemo(getStore());
  return Response.json({ ok: true, ...summary, at: new Date().toISOString() });
}

export async function GET(request: Request) {
  return handleReset(request);
}

export async function POST(request: Request) {
  return handleReset(request);
}
