import { describe, expect, it } from "vitest";
import { inviteRequiredFrom } from "../inviteRequired";

describe("inviteRequiredFrom (STRIDE_REQUIRE_INVITE_CODE)", () => {
  it("defaults to true when unset, preserving the current always-show behavior", () => {
    expect(inviteRequiredFrom(undefined)).toBe(true);
    expect(inviteRequiredFrom("")).toBe(true);
  });

  it("is true for the truthy spellings", () => {
    expect(inviteRequiredFrom("true")).toBe(true);
    expect(inviteRequiredFrom("1")).toBe(true);
  });

  it("is false only for an explicit off value", () => {
    expect(inviteRequiredFrom("false")).toBe(false);
    expect(inviteRequiredFrom("0")).toBe(false);
  });
});
