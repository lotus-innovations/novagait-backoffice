import { defineConfig, devices } from "@playwright/test";
import {
  BASE_URL,
  E2E_ADMIN_KEY,
  E2E_CRON_SECRET,
  E2E_PORT,
} from "./e2e/constants";

// e2e + axe gate (LOT-108, spec 12 §4). Key-free by construction: the suite
// drives the PRODUCTION build (`next build` + `next start`) with the mock
// agent lane forced on and no ANTHROPIC_API_KEY in the server environment.
//
// Containment (packages/agent/src/containment.ts) is NOT weakened: the suite
// runs far more than SESSION_RUN_CAP (5) runs from a single localhost IP, so
// it uses the env overrides the containment module already exposes for
// exactly this lane, and resets demo state per spec file through
// /api/maintenance/reset with a test CRON_SECRET.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../test-results",
  // Shared server + shared in-memory store: specs reset state in beforeAll,
  // so they must not interleave.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "../../playwright-report", open: "never" }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: process.env.E2E_SKIP_BUILD
      ? "npm run start"
      : "npm run build && npm run start",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(E2E_PORT),
      // Mock lane, explicitly. isMockMode() is
      // `MOCK_AGENT === "1" || !ANTHROPIC_API_KEY`; both halves hold here.
      MOCK_AGENT: "1",
      ANTHROPIC_API_KEY: "",
      // In-memory store (no UPSTASH_* -> createStore() picks the memory
      // driver), so state is process-local and the reset route is enough.
      ADMIN_KEY: E2E_ADMIN_KEY,
      CRON_SECRET: E2E_CRON_SECRET,
      // Containment overrides the module already provides for this lane.
      SESSION_RUN_CAP: "500",
      RATE_LIMIT_PER_HOUR: "500",
      RATE_LIMIT_PER_DAY: "2000",
    },
  },
});
