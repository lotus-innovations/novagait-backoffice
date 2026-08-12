// Route-handler tests (milestone review: the handlers own auth, containment
// ordering, cookie issuance, and the approval-id hop; none of it was
// covered). Handlers are plain (Request) => Response, and the runtime
// singletons hang off globalThis, so each test resets them.

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAILY_BUDGET_MICRO_USD,
  InMemoryStore,
  budgetKey,
  getApprovalForRun,
} from "@novagait/agent";
import { POST as intakePost } from "./intake/route";
import { POST as devRunPost } from "./dev/run/route";
import { POST as approvalPost } from "./approvals/[id]/route";
import {
  GET as toggleGet,
  POST as togglePost,
} from "./admin/failure-toggle/route";
import { GET as resetGet } from "./maintenance/reset/route";
import { GET as adminGet, POST as adminPost } from "../admin/route";
import { getStore } from "@/lib/runtime";

const BASE = "http://backoffice.test";

interface RuntimeGlobals {
  __novagaitStore?: unknown;
  __novagaitBackend?: unknown;
  __novagaitSeeded?: boolean;
}

function resetRuntime() {
  const globals = globalThis as RuntimeGlobals;
  // Explicit fresh store: createStore() memoizes a process-wide in-memory
  // singleton, so clearing the globalThis ref alone would NOT isolate tests.
  globals.__novagaitStore = new InMemoryStore();
  globals.__novagaitBackend = undefined;
  globals.__novagaitSeeded = undefined;
}

function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

function intakeRequest(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}/api/intake`, {
    method: "POST",
    body: form(fields),
    headers,
  });
}

beforeEach(() => {
  resetRuntime();
  process.env.ADMIN_KEY = "test-admin-key";
  process.env.CRON_SECRET = "test-cron-secret";
  // Generous limits so intake tests don't trip them incidentally.
  process.env.RATE_LIMIT_PER_HOUR = "100";
  process.env.RATE_LIMIT_PER_DAY = "200";
});

afterEach(() => {
  delete process.env.ADMIN_KEY;
  delete process.env.CRON_SECRET;
  delete process.env.RATE_LIMIT_PER_HOUR;
  delete process.env.RATE_LIMIT_PER_DAY;
});

describe("POST /api/intake", () => {
  it("rejects cross-origin form posts", async () => {
    const response = await intakePost(
      intakeRequest(
        { item: "INB-001", mode: "autonomous" },
        { origin: "https://evil.example" },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("bounces invalid form input without consuming rate budget", async () => {
    const response = await intakePost(intakeRequest({}));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("error=invalid");
    // Containment order: validation failed BEFORE the IP counter, so a
    // valid submission still passes under a limit of 1.
    process.env.RATE_LIMIT_PER_HOUR = "1";
    const ok = await intakePost(
      intakeRequest({ item: "INB-001", mode: "shadow" }),
    );
    expect(ok.headers.get("location")).toContain("/runs/");
  });

  it("runs a document, sets the session cookie, redirects to the run", async () => {
    const response = await intakePost(
      intakeRequest({ item: "INB-001", mode: "autonomous" }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/\/runs\/[0-9A-Z]+$/);
    expect(response.headers.get("set-cookie")).toContain("ng_session=");
  });

  it("caps the note length", async () => {
    const response = await intakePost(
      intakeRequest({
        item: "INB-001",
        mode: "shadow",
        note: "x".repeat(300),
      }),
    );
    expect(response.headers.get("location")).toContain("error=note_too_long");
  });
});

describe("POST /api/approvals/[id]", () => {
  async function parkViaIntake(): Promise<{ runId: string; aprId: string }> {
    const response = await intakePost(
      intakeRequest({ item: "INB-001", mode: "assisted" }),
    );
    const location = response.headers.get("location")!;
    expect(location, "intake should park the run").toContain("/runs/");
    const runId = location.split("/").pop()!;
    const approval = await getApprovalForRun(getStore(), runId);
    expect(approval, `pending approval for ${runId}`).not.toBeNull();
    return { runId, aprId: approval!.approval_id };
  }

  function decideRequest(
    aprId: string,
    fields: Record<string, string>,
  ): Request {
    return new Request(`${BASE}/api/approvals/${aprId}`, {
      method: "POST",
      body: form(fields),
    });
  }

  it("404s unknown approvals and 400s unknown decisions", async () => {
    const missing = await approvalPost(
      decideRequest("APR-nope", { decision: "approve" }),
      { params: Promise.resolve({ id: "APR-nope" }) },
    );
    expect(missing.status).toBe(404);

    const { aprId } = await parkViaIntake();
    const bad = await approvalPost(
      decideRequest(aprId, { decision: "shred" }),
      { params: Promise.resolve({ id: aprId }) },
    );
    expect(bad.status).toBe(400);
  });

  it("requires a reason for reject and refuses malformed edits", async () => {
    const { aprId } = await parkViaIntake();
    const noReason = await approvalPost(
      decideRequest(aprId, { decision: "reject" }),
      { params: Promise.resolve({ id: aprId }) },
    );
    expect(noReason.headers.get("location")).toContain("error=reason_required");
    const badGl = await approvalPost(
      decideRequest(aprId, {
        decision: "edit_approve",
        reason: "recode",
        gl_code: "not-a-code",
      }),
      { params: Promise.resolve({ id: aprId }) },
    );
    expect(badGl.headers.get("location")).toContain("error=bad_gl_code");
  });

  it("approves through the seam and redirects to the run", async () => {
    const { runId, aprId } = await parkViaIntake();
    const response = await approvalPost(
      decideRequest(aprId, { decision: "approve", reason: "checked" }),
      { params: Promise.resolve({ id: aprId }) },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(`/runs/${runId}`);
  });

  it("redirects a superseded approval id to the current draft", async () => {
    const { runId, aprId } = await parkViaIntake();
    await approvalPost(
      decideRequest(aprId, { decision: "reject", reason: "wrong period" }),
      { params: Promise.resolve({ id: aprId }) },
    );
    // The revision parked a NEW approval; the stale id must not decide it.
    const stale = await approvalPost(
      decideRequest(aprId, { decision: "approve", reason: "stale tab" }),
      { params: Promise.resolve({ id: aprId }) },
    );
    expect(stale.headers.get("location")).toContain("error=superseded");
    const current = await getApprovalForRun(getStore(), runId);
    expect(current?.status).toBe("pending");
  });
});

describe("admin surfaces fail closed", () => {
  it("failure toggle: 503 when ADMIN_KEY is not configured, 401 on bad auth", async () => {
    delete process.env.ADMIN_KEY;
    const unconfigured = await toggleGet(
      new Request(`${BASE}/api/admin/failure-toggle`),
    );
    expect(unconfigured.status).toBe(503);

    process.env.ADMIN_KEY = "test-admin-key";
    const badAuth = await toggleGet(
      new Request(`${BASE}/api/admin/failure-toggle`, {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(badAuth.status).toBe(401);

    const armed = await togglePost(
      new Request(`${BASE}/api/admin/failure-toggle`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ armed: true }),
      }),
    );
    expect(armed.status).toBe(200);
    expect(await armed.json()).toEqual({ armed: true, fired: false });
  });

  it("/admin: 503 unconfigured, 401 unauthenticated, 403 cross-origin POST", async () => {
    delete process.env.ADMIN_KEY;
    const unconfigured = await adminGet(new NextRequest(`${BASE}/admin`));
    expect(unconfigured.status).toBe(503);

    process.env.ADMIN_KEY = "test-admin-key";
    const unauthed = await adminGet(new NextRequest(`${BASE}/admin`));
    expect(unauthed.status).toBe(401);
    expect(unauthed.headers.get("www-authenticate")).toContain("Basic");

    const crossOrigin = await adminPost(
      new NextRequest(`${BASE}/admin`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: form({ action: "reset" }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("maintenance reset: 503 without CRON_SECRET, 401 wrong bearer", async () => {
    delete process.env.CRON_SECRET;
    const unconfigured = await resetGet(
      new Request(`${BASE}/api/maintenance/reset`),
    );
    expect(unconfigured.status).toBe(503);

    process.env.CRON_SECRET = "test-cron-secret";
    const badAuth = await resetGet(
      new Request(`${BASE}/api/maintenance/reset`, {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(badAuth.status).toBe(401);
  });
});

describe("POST /api/dev/run lane gating", () => {
  const saved = {
    MOCK_AGENT: process.env.MOCK_AGENT,
    LIVE_AGENT: process.env.LIVE_AGENT,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };

  const devRequest = (body: Record<string, unknown>) =>
    new Request(`${BASE}/api/dev/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const restore = (key: keyof typeof saved) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  };

  afterEach(() => {
    (Object.keys(saved) as (keyof typeof saved)[]).forEach(restore);
  });

  it("runs the mock lane by default", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const response = await devRunPost(devRequest({ item: "INB-001" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcome: string };
    expect(body.outcome).toBe("executed");
  });

  it("403s the live lane when the opt-in flag is absent", async () => {
    delete process.env.LIVE_AGENT;
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-real";
    const response = await devRunPost(
      devRequest({ item: "INB-001", lane: "live" }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/LIVE_AGENT=1/);
  });

  it("403s the live lane when the flag is set but no key is configured", async () => {
    process.env.LIVE_AGENT = "1";
    delete process.env.ANTHROPIC_API_KEY;
    const response = await devRunPost(
      devRequest({ item: "INB-001", lane: "live" }),
    );
    expect(response.status).toBe(403);
  });

  it("403s the mock lane once a key makes the mock agent inactive", async () => {
    delete process.env.MOCK_AGENT;
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-real";
    const response = await devRunPost(devRequest({ item: "INB-001" }));
    expect(response.status).toBe(403);
  });

  it("refuses the live lane once the daily budget breaker has tripped", async () => {
    process.env.LIVE_AGENT = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-real";
    // Trip capacity mode on the shared store the route uses.
    await getStore().incrBy(budgetKey(), DAILY_BUDGET_MICRO_USD);
    const response = await devRunPost(
      devRequest({ item: "INB-001", lane: "live" }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/capacity mode/);
  });

  it("leaves the mock lane running in capacity mode", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await getStore().incrBy(budgetKey(), DAILY_BUDGET_MICRO_USD);
    const response = await devRunPost(devRequest({ item: "INB-001" }));
    expect(response.status).toBe(200);
  });
});
