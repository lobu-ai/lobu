import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDataChangeGate } from "../live-gate.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

let visibility: "visible" | "hidden";
let listeners: Set<() => void>;

beforeEach(() => {
  visibility = "visible";
  listeners = new Set();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get visibilityState() {
        return visibility;
      },
      addEventListener(type: string, listener: () => void) {
        if (type === "visibilitychange") listeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type === "visibilitychange") listeners.delete(listener);
      },
    },
  });
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

function setVisible(): void {
  visibility = "visible";
  for (const listener of [...listeners]) listener();
}

test("reads immediately when the window is idle", () => {
  let reads = 0;
  const gate = createDataChangeGate(() => reads++, 50);
  gate.start();
  gate.notify();
  expect(reads).toBe(1);
  gate.stop();
});

test("changes inside the window collapse into one trailing read", async () => {
  let reads = 0;
  const gate = createDataChangeGate(() => reads++, 40);
  gate.start();
  gate.notify();
  expect(reads).toBe(1);
  gate.notify();
  gate.notify();
  gate.notify();
  expect(reads).toBe(1);
  await sleep(70);
  expect(reads).toBe(2);
  gate.stop();
});

test("a hidden frame defers and reads once when visible", () => {
  let reads = 0;
  const gate = createDataChangeGate(() => reads++, 40);
  gate.start();
  visibility = "hidden";
  gate.notify();
  gate.notify();
  expect(reads).toBe(0);
  setVisible();
  expect(reads).toBe(1);
  gate.stop();
});

test("hiding cancels a scheduled trailing read", async () => {
  let reads = 0;
  const gate = createDataChangeGate(() => reads++, 40);
  gate.start();
  gate.notify();
  gate.notify();
  visibility = "hidden";
  gate.notify();
  await sleep(70);
  expect(reads).toBe(1);
  setVisible();
  expect(reads).toBe(2);
  gate.stop();
});

test("force reads immediately inside the window", () => {
  let reads = 0;
  const gate = createDataChangeGate(() => reads++, 60_000);
  gate.start();
  gate.notify();
  expect(reads).toBe(1);
  gate.force();
  expect(reads).toBe(2);
  gate.stop();
});

test("stop drops a pending trailing read and the listener", async () => {
  let reads = 0;
  const gate = createDataChangeGate(() => reads++, 30);
  gate.start();
  gate.notify();
  gate.notify();
  gate.stop();
  await sleep(60);
  expect(reads).toBe(1);
  visibility = "hidden";
  gate.notify();
  setVisible();
  expect(reads).toBe(1);
});
