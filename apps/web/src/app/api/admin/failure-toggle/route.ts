// Failure-toggle admin (LOT-92, Demo 2 pattern, spec 11 §3): when armed,
// the next payment-schedule write fails once, the retry is visible in the
// trace, and the toggle disarms itself. Gated by ADMIN_KEY; the /admin UI
// (LOT-107) drives this route.

import { sameOriginViolation } from "@/lib/origin";
import { getBackend } from "@/lib/runtime";

export const dynamic = "force-dynamic";

function notConfigured(): Response | null {
  if (!process.env.ADMIN_KEY) {
    return Response.json(
      { error: "admin disabled: ADMIN_KEY not configured" },
      { status: 503 },
    );
  }
  return null;
}

function authorized(request: Request): boolean {
  const secret = process.env.ADMIN_KEY;
  return (
    !!secret && request.headers.get("authorization") === `Bearer ${secret}`
  );
}

export async function GET(request: Request) {
  const disabled = notConfigured();
  if (disabled) return disabled;
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(await getBackend().failureToggle());
}

export async function POST(request: Request) {
  const disabled = notConfigured();
  if (disabled) return disabled;
  if (sameOriginViolation(request)) {
    return Response.json({ error: "cross-origin" }, { status: 403 });
  }
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
