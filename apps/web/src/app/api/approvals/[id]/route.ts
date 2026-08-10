// Approval decision endpoint (LOT-104). The decision is attributed to the
// visitor's anonymous session and resumes the parked run through the same
// gate that parked it (resumeRun).

import { NextResponse } from "next/server";
import { getApproval } from "@novagait/agent";
import { resumeRun } from "@novagait/pipeline";
import { getBackend, getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const DECISIONS = ["approve", "reject", "edit_approve"] as const;
type DecisionKind = (typeof DECISIONS)[number];

function actorFrom(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  const session = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("ng_session="))
    ?.slice("ng_session=".length);
  return session ? `visitor:${session.slice(-8)}` : "visitor:anon";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
    return NextResponse.redirect(new URL(`/approvals/${id}`, request.url), 303);
  }

  try {
    await resumeRun(store, getBackend(), approval.run_id, {
      actor: actorFrom(request),
      decision,
      reason: reason || "approved",
      edits:
        decision === "edit_approve"
          ? {
              ...(glCode ? { gl_code: glCode } : {}),
              ...(payDate ? { pay_date: payDate } : {}),
            }
          : undefined,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 409 });
  }
  return NextResponse.redirect(
    new URL(`/runs/${approval.run_id}`, request.url),
    303,
  );
}
