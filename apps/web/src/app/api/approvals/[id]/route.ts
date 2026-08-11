// Approval decision endpoint (LOT-104, hardened at the milestone review).
// The decision names the approval id from the URL; resumeRun refuses stale
// ids (post-revision) and concurrent decisions (atomic claim). By design
// the DEMO VISITOR IS THE APPROVER (spec F: assisted mode is the visitor
// playing the approver), so there is deliberately no login here; the actor
// is the anonymous session, honestly recorded in the trace, and the
// same-origin guard keeps third-party pages from posting decisions.

import { NextResponse } from "next/server";
import { getApproval } from "@novagait/agent";
import { resumeRun } from "@novagait/pipeline";
import { sameOriginViolation } from "@/lib/origin";
import { getBackend, getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const DECISIONS = ["approve", "reject", "edit_approve"] as const;
type DecisionKind = (typeof DECISIONS)[number];

const GL_CODE_RE = /^\d{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function actorFrom(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  const session = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("ng_session="))
    ?.slice("ng_session=".length);
  return session ? `visitor:${session.slice(-8)}` : "visitor:anon";
}

function backToApproval(
  request: Request,
  id: string,
  error: string,
): NextResponse {
  const url = new URL(`/approvals/${id}`, request.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (sameOriginViolation(request)) {
    return NextResponse.json({ error: "cross-origin" }, { status: 403 });
  }
  const store = getStore();
  const approval = await getApproval(store, id);
  if (!approval) {
    return NextResponse.json({ error: "unknown approval" }, { status: 404 });
  }

  const form = await request.formData().catch(() => null);
  const decision = String(form?.get("decision") ?? "") as DecisionKind;
  const reason = String(form?.get("reason") ?? "").trim();
  const glCode = String(form?.get("gl_code") ?? "").trim();
  const payDate = String(form?.get("pay_date") ?? "").trim();

  if (!DECISIONS.includes(decision)) {
    return NextResponse.json({ error: "invalid decision" }, { status: 400 });
  }
  if ((decision === "reject" || decision === "edit_approve") && !reason) {
    return backToApproval(request, id, "reason_required");
  }
  // Malformed edits refuse the decision with a message - never silently
  // dropped and executed with the original values.
  if (decision === "edit_approve") {
    if (glCode && !GL_CODE_RE.test(glCode)) {
      return backToApproval(request, id, "bad_gl_code");
    }
    if (payDate && !DATE_RE.test(payDate)) {
      return backToApproval(request, id, "bad_pay_date");
    }
  }

  try {
    const result = await resumeRun(store, getBackend(), approval.run_id, {
      approvalId: id,
      actor: actorFrom(request),
      decision,
      // Honest audit content: no fabricated "approved" default.
      reason: reason || "(no reason given)",
      edits:
        decision === "edit_approve"
          ? {
              ...(glCode ? { gl_code: glCode } : {}),
              ...(payDate ? { pay_date: payDate } : {}),
            }
          : undefined,
    });
    return NextResponse.redirect(
      new URL(`/runs/${result.runId}`, request.url),
      303,
    );
  } catch (error) {
    const message = String(error);
    if (message.includes("superseded")) {
      return backToApproval(request, id, "superseded");
    }
    if (message.includes("already being decided")) {
      return NextResponse.json(
        { error: "decision already in progress" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
