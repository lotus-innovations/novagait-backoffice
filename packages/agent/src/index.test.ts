import { describe, expect, it } from "vitest";
import { AGENT_PACKAGE } from "./index";

describe("workspace wiring", () => {
  it("exposes the package marker", () => {
    expect(AGENT_PACKAGE).toBe("@novagait/agent");
  });
});
