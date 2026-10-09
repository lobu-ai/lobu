import { describe, expect, it, vi } from "vitest";
import { raceAbort } from "../race-abort";

describe("raceAbort", () => {
  it("observes rejection when handed an already aborted signal", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(raceAbort(Promise.reject(new Error("late upstream rejection")), controller.signal)).rejects.toBe(reason);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("removes the abort listener immediately even if upstream never settles", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = raceAbort(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
