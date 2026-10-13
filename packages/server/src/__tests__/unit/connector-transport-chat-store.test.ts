import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "../../db/client";
import { createPostgresAgentConnectionStore } from "../../lobu/stores/postgres-stores";

const stored = {
  id: "101",
  platform: "whatsapp.web",
  config: {},
  settings: {},
  metadata: {},
  status: "active" as const,
  createdAt: 0,
  updatedAt: 0,
};

let restoreDb: (() => void) | undefined;
afterEach(() => restoreDb?.());

describe("connector-transport chat store ownership", () => {
  test("save, update and delete refuse connector-owned rows before any write", async () => {
    const statements: string[] = [];
    const sql = Object.assign(async (parts: TemplateStringsArray) => {
      statements.push(parts.join("?"));
      return [];
    }, { begin: async (fn: (tx: unknown) => unknown) => fn(sql) });
    const getDb = spyOn(db, "getDb").mockReturnValue(sql as any);
    restoreDb = () => getDb.mockRestore();
    const store = createPostgresAgentConnectionStore({
      connectorTransportPlatforms: ["whatsapp.web"],
    });
    store.getConnection = async () => stored;

    await expect(store.saveConnection(stored)).rejects.toThrow("owned by their connector");
    await expect(store.updateConnection("101", { platform: "slack" }))
      .rejects.toThrow("owned by their connector");
    await expect(store.deleteConnection("101"))
      .rejects.toThrow("owned by their connector");
    expect(statements).toEqual([]);
  });
});
