import { describe, it, expect } from "vitest";
import { KNOWSTONE_VERSION, banner } from "../src/index.js";

describe("smoke", () => {
  it("exposes a version", () => {
    expect(KNOWSTONE_VERSION).toBe("0.1.0");
  });

  it("builds a banner", () => {
    expect(banner()).toContain("knowstone");
  });
});
