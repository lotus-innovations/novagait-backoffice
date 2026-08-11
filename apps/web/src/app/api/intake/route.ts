// Intake (LOT-103): the only way a visitor starts a run. Containment order:
// capacity mode -> note length -> IP limits -> session cap -> mock-lane
// gate -> run. Every rejection is an honest redirect back to the picker.

import { NextResponse } from "next/server";
import {
  INTAKE_NOTE_MAX_CHARS,
  checkIpLimit,
  checkSessionCap,
  isCapacityMode,
  recordRunCost,
  refundSessionRun,
  ulid,
  type RunMode,
} from "@novagait/agent";
import { isMockMode, runMockPipeline } from "@novagait/pipeline";
import { ensureSeeded, getBackend, getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const MODES: RunMode[] = ["shadow", "assisted", "autonomous"];
const SESSION_COOKIE = "ng_session";

function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "local";
}

function back(request: Request, error: string): NextResponse {
  const url = new URL("/", request.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  const store = getStore();
  await ensureSeeded();

  if (await isCapacityMode(store)) {
    return back(request, "capacity");
  }

  const form = await request.formData().catch(() => null);
  const item = String(form?.get("item") ?? "");
  const modeRaw = String(form?.get("mode") ?? "");
  const note = String(form?.get("note") ?? "").trim();
  if (!item || !MODES.includes(modeRaw as RunMode)) {
    return back(request, "invalid");
  }
  if (note.length > INTAKE_NOTE_MAX_CHARS) {
    return back(request, "note_too_long");
  }

  const ipCheck = await checkIpLimit(store, clientIp(request.headers));
  if (!ipCheck.allowed) return back(request, "rate");

  const cookies = request.headers.get("cookie") ?? "";
  const existing = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const sessionId = existing || ulid();
  const sessionCheck = await checkSessionCap(store, sessionId);
  if (!sessionCheck.allowed) {
    return back(request, "session");
  }

  if (!isMockMode()) {
    // Live-model lane is wired at launch; until then the mock lane is the
    // only runner (spec 13: never a silent fallback to live spend).
    return back(request, "unavailable");
  }

  try {
    const result = await runMockPipeline({
      store,
      backend: getBackend(),
      inboxItemId: item,
      mode: modeRaw as RunMode,
      note: note || undefined,
      approver: form?.get("approver") === "script" ? "script" : "none",
    });
    await recordRunCost(store, 0); // mock lane: measured cost is zero
    if (result.outcome === "error") {
      // The pipeline recorded the failure honestly (error event + run.end);
      // the visitor still gets the trace, but the failed run does not
      // count against their session cap.
      await refundSessionRun(store, sessionId);
    }
    const response = NextResponse.redirect(
      new URL(`/runs/${result.runId}`, request.url),
      303,
    );
    if (!existing) {
      response.cookies.set(SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 24 * 60 * 60,
        path: "/",
      });
    }
    return response;
  } catch (error) {
    // Pre-run failures only (unknown item, malformed store state): nothing
    // was traced, so refund the session slot and say what happened.
    console.error("intake failed before a run could start:", error);
    await refundSessionRun(store, sessionId);
    return back(request, "run_failed");
  }
}
