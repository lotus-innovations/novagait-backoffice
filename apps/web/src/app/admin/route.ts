// Operator panel (LOT-107, spec 12 §1, 13 §2): budget/capacity state,
// failure toggle, manual reset. HTTP Basic auth against ADMIN_KEY (the
// Demo 2 admin pattern); server-rendered HTML, no client JS. This is the
// operator's view; the public capacity banner lives on the landing page.

import { NextRequest, NextResponse } from "next/server";
import {
  DAILY_BUDGET_MICRO_USD,
  IP_LIMIT_PER_DAY,
  IP_LIMIT_PER_HOUR,
  MAX_ITERATIONS,
  MAX_RUN_COST_MICRO_USD,
  RUN_WALL_CLOCK_MS,
  SESSION_RUN_CAP,
  getDailySpendMicroUsd,
  isCapacityMode,
  traceKeys,
} from "@novagait/agent";
import { resetDemo } from "@novagait/pipeline";
import { sameOriginViolation } from "@/lib/origin";
import { getBackend, getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function requireBasicAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.ADMIN_KEY;
  if (!secret) {
    // Not-configured is a 503, not a 401: same convention as the
    // maintenance route, and it cannot be confused with bad credentials.
    return NextResponse.json(
      { error: "admin disabled: ADMIN_KEY not configured" },
      { status: 503 },
    );
  }
  const header = request.headers.get("authorization") ?? "";
  let ok = false;
  if (header.startsWith("Basic ")) {
    try {
      const [user, ...rest] = Buffer.from(header.slice(6), "base64")
        .toString("utf8")
        .split(":");
      ok = user === "admin" && rest.join(":") === secret;
    } catch {
      ok = false;
    }
  }
  if (ok) return null;
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Novagait Backoffice Admin"' },
  });
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;

export async function GET(request: NextRequest) {
  const denied = requireBasicAuth(request);
  if (denied) return denied;

  const store = getStore();
  const backend = getBackend();
  const [spend, capacity, toggle, runIds, payments] = await Promise.all([
    getDailySpendMicroUsd(store),
    isCapacityMode(store),
    backend.failureToggle(),
    store.listRange(traceKeys.recent(), 0, -1),
    backend.paymentSchedule(),
  ]);
  const acted = new URL(request.url).searchParams.get("acted");

  const body = `
<h1>Backoffice admin</h1>
${acted ? `<p role="status" class="banner">Done: ${esc(acted)}.</p>` : ""}
<h2>Budget and capacity</h2>
<table>
<tr><th scope="row">Spend today</th><td>${esc(usd(spend))} of ${esc(
    usd(DAILY_BUDGET_MICRO_USD),
  )}</td>
<th scope="row">Capacity mode</th><td>${capacity ? "<strong>TRIPPED - intake paused</strong>" : "off (intake open)"}</td></tr>
<tr><th scope="row">Per-run caps</th><td>${esc(usd(MAX_RUN_COST_MICRO_USD))}, ${MAX_ITERATIONS} iterations, ${RUN_WALL_CLOCK_MS / 1000}s</td>
<th scope="row">Visitor limits</th><td>${SESSION_RUN_CAP}/session, ${IP_LIMIT_PER_HOUR}/hr + ${IP_LIMIT_PER_DAY}/day per IP</td></tr>
<tr><th scope="row">Runs in index</th><td>${runIds.length}</td>
<th scope="row">Payments scheduled</th><td>${payments.length}</td></tr>
</table>

<h2>Failure toggle</h2>
<p>State: <strong>${toggle.armed ? "armed" : "disarmed"}</strong>${
    toggle.fired ? " (fired, will self-disarm on next write)" : ""
  }. When armed, the next payment write fails once and retries; the retry is
visible in the run trace.</p>
<form method="post" action="/admin">
<input type="hidden" name="action" value="${toggle.armed ? "disarm" : "arm"}">
<button type="submit">${toggle.armed ? "Disarm" : "Arm"} the failure toggle</button>
</form>

<h2>Reset</h2>
<p>Restores seed state; clears runs, traces, approvals, vendor profiles,
dedupe ledger, and the budget counter. Same operation as the nightly cron.</p>
<form method="post" action="/admin">
<input type="hidden" name="action" value="reset">
<button type="submit">Reset the demo now</button>
</form>
`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Admin | Novagait Back Office</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:900px;margin:24px auto;padding:0 24px;line-height:1.5;color:#1c2430;background:#fff}
table{border-collapse:collapse;width:100%;font-size:.95rem}
th,td{border:1px solid #d7dde5;padding:6px 10px;text-align:left}
th{background:#f2f5f8}
button{background:#0b5fff;color:#fff;border:0;border-radius:6px;padding:9px 18px;font-size:1rem;cursor:pointer}
.banner{background:#fff7e0;border:1px solid #b98900;border-radius:6px;padding:10px 14px}
:focus-visible{outline:3px solid #0b5fff;outline-offset:2px}
</style>
</head>
<body>
<main>${body}</main>
</body>
</html>`;
  return new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(request: NextRequest) {
  if (sameOriginViolation(request)) {
    return NextResponse.json({ error: "cross-origin" }, { status: 403 });
  }
  const denied = requireBasicAuth(request);
  if (denied) return denied;

  const form = await request.formData().catch(() => null);
  const action = String(form?.get("action") ?? "");
  const store = getStore();
  const backend = getBackend();

  if (action === "arm" || action === "disarm") {
    await backend.setFailureToggle(action === "arm");
  } else if (action === "reset") {
    await resetDemo(store);
  } else {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  const url = new URL("/admin", request.url);
  url.searchParams.set("acted", action);
  return NextResponse.redirect(url, 303);
}
