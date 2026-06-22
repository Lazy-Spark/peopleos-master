import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../src/lib/workflowEngine.js";

/**
 * Unit tests for the SAFE declarative branch comparator (the security-critical heart of
 * the BRANCH step). These are pure (no DB): they prove the comparator is a value
 * comparison only — never code execution — and that it fails closed on bad input.
 */
describe("evaluateCondition — safe branch comparator", () => {
  it("EQ matches strict equality across types", () => {
    expect(evaluateCondition({ stage: "offer" }, { field: "stage", op: "EQ", value: "offer" })).toBe(true);
    expect(evaluateCondition({ stage: "offer" }, { field: "stage", op: "EQ", value: "hire" })).toBe(false);
    expect(evaluateCondition({ n: 5 }, { field: "n", op: "EQ", value: 5 })).toBe(true);
    expect(evaluateCondition({ ok: true }, { field: "ok", op: "EQ", value: true })).toBe(true);
    // No loose coercion: "5" (string) !== 5 (number).
    expect(evaluateCondition({ n: 5 }, { field: "n", op: "EQ", value: "5" })).toBe(false);
  });

  it("NE is the negation of EQ", () => {
    expect(evaluateCondition({ stage: "offer" }, { field: "stage", op: "NE", value: "hire" })).toBe(true);
    expect(evaluateCondition({ stage: "offer" }, { field: "stage", op: "NE", value: "offer" })).toBe(false);
  });

  it("EXISTS is true only when the field is present and non-null", () => {
    expect(evaluateCondition({ a: 1 }, { field: "a", op: "EXISTS" })).toBe(true);
    expect(evaluateCondition({ a: 0 }, { field: "a", op: "EXISTS" })).toBe(true);
    expect(evaluateCondition({ a: false }, { field: "a", op: "EXISTS" })).toBe(true);
    expect(evaluateCondition({ a: null }, { field: "a", op: "EXISTS" })).toBe(false);
    expect(evaluateCondition({}, { field: "a", op: "EXISTS" })).toBe(false);
  });

  it("GT / LT compare numerically (and coerce numeric strings)", () => {
    expect(evaluateCondition({ amount: 100 }, { field: "amount", op: "GT", value: 50 })).toBe(true);
    expect(evaluateCondition({ amount: 100 }, { field: "amount", op: "GT", value: 150 })).toBe(false);
    expect(evaluateCondition({ amount: 100 }, { field: "amount", op: "LT", value: 150 })).toBe(true);
    expect(evaluateCondition({ amount: "100" }, { field: "amount", op: "GT", value: 50 })).toBe(true);
    // Non-numeric value → no match (fails closed, never throws).
    expect(evaluateCondition({ amount: "high" }, { field: "amount", op: "GT", value: 50 })).toBe(false);
  });

  it("supports dot-path lookups on nested context", () => {
    const ctx = { approve: { outcome: "REJECTED" } };
    expect(evaluateCondition(ctx, { field: "approve.outcome", op: "EQ", value: "REJECTED" })).toBe(true);
    expect(evaluateCondition(ctx, { field: "approve.outcome", op: "EQ", value: "APPROVED" })).toBe(false);
    // A missing nested segment → undefined → EXISTS false.
    expect(evaluateCondition(ctx, { field: "approve.missing.deep", op: "EXISTS" })).toBe(false);
  });

  it("never traverses the prototype chain (no __proto__ / constructor leakage)", () => {
    const ctx: Record<string, unknown> = { real: 1 };
    // toString lives on Object.prototype, NOT as an own property — must be invisible.
    expect(evaluateCondition(ctx, { field: "toString", op: "EXISTS" })).toBe(false);
    expect(evaluateCondition(ctx, { field: "__proto__", op: "EXISTS" })).toBe(false);
    expect(evaluateCondition(ctx, { field: "constructor", op: "EXISTS" })).toBe(false);
  });

  it("treats a value as data, never code (no injection)", () => {
    // The 'value' is compared as a literal; there is no eval/Function path. A field that
    // looks like an expression is just a missing key → EXISTS false.
    expect(evaluateCondition({}, { field: "1)||true", op: "EXISTS" })).toBe(false);
    expect(
      evaluateCondition({ x: "process.exit(1)" }, { field: "x", op: "EQ", value: "process.exit(1)" }),
    ).toBe(true); // compared as a plain string — not executed.
  });
});
