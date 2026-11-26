import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../inference/circuit-breaker.js";

describe("CircuitBreaker", () => {
  test("is closed by default", () => {
    const breaker = new CircuitBreaker(3, 1000);
    expect(breaker.canProceed("key-a")).toBe(true);
    expect(breaker.isOpen("key-a")).toBe(false);
  });

  test("stays closed below the failure threshold", () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.onFailure("p");
    breaker.onFailure("p");
    expect(breaker.canProceed("p")).toBe(true);
  });

  test("trips after reaching the failure threshold", () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.onFailure("p");
    breaker.onFailure("p");
    breaker.onFailure("p");
    expect(breaker.isOpen("p")).toBe(true);
    expect(breaker.canProceed("p")).toBe(false);
  });

  test("onSuccess closes the breaker", () => {
    const breaker = new CircuitBreaker(2, 1000);
    breaker.onFailure("p");
    breaker.onFailure("p");
    expect(breaker.isOpen("p")).toBe(true);
    breaker.onSuccess("p");
    expect(breaker.isOpen("p")).toBe(false);
  });

  test("isolates failures per key", () => {
    const breaker = new CircuitBreaker(2, 1000);
    breaker.onFailure("p1");
    breaker.onFailure("p1");
    expect(breaker.canProceed("p1")).toBe(false);
    expect(breaker.canProceed("p2")).toBe(true);
  });

  test("half-opens after the cooldown and closes on a successful probe", async () => {
    const breaker = new CircuitBreaker(1, 15);
    breaker.onFailure("p");
    expect(breaker.canProceed("p")).toBe(false);
    await new Promise((r) => setTimeout(r, 25));
    // First probe is allowed through.
    expect(breaker.canProceed("p")).toBe(true);
    // A second concurrent probe is blocked.
    expect(breaker.canProceed("p")).toBe(false);
    breaker.onSuccess("p");
    expect(breaker.canProceed("p")).toBe(true);
  });

  test("a success resets the failure count", () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.onFailure("p");
    breaker.onFailure("p");
    breaker.onSuccess("p");
    breaker.onFailure("p");
    breaker.onFailure("p");
    expect(breaker.isOpen("p")).toBe(false);
  });

  test("half-opens after cooldown and reopens on a failed probe", async () => {
    const breaker = new CircuitBreaker(1, 15);
    breaker.onFailure("p");
    await new Promise((r) => setTimeout(r, 25));
    expect(breaker.canProceed("p")).toBe(true); // probe allowed
    breaker.onFailure("p");
    expect(breaker.canProceed("p")).toBe(false);
  });
});
