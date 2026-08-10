// Failure-toggle admin (LOT-92, Demo 2 pattern, spec 11 §3): when armed,
// the next payment-schedule write fails once, the retry is visible in the
// trace, and the toggle disarms itself. Gated by ADMIN_KEY; the /admin UI
// (LOT-107) drives this route.

import { getBackend } from "@/lib/runtime";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.ADMIN_KEY;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(await getBackend().failureToggle());
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    armed?: unknown;
  } | null;
  if (!body || typeof body.armed !== "boolean") {
    return Response.json(
      { error: 'body must be {"armed": true|false}' },
      { status: 400 },
    );
  }
  await getBackend().setFailureToggle(body.armed);
  return Response.json(await getBackend().failureToggle());
}
