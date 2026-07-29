import { describe, it, expect } from "vitest";
import { verdictToAction } from "../src/guard/types";
describe("guard types", () => {
  it("works", () => {
    expect(verdictToAction("benign")).toBe("allow");
  });
});
