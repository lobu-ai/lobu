import { expect, test } from "bun:test";
import { syntheticImage } from "../../../../scripts/__tests__/fixtures/synthetic-image";
import {
  MAX_TOOL_IMAGE_BYTES,
  MAX_TOOL_IMAGES,
  mcpToolResult,
} from "../mcp-content";

const image = () => ({
  type: "image",
  mimeType: "image/png",
  data: syntheticImage().bytes.toString("base64"),
});
const images = (content: unknown) =>
  mcpToolResult(content, "empty").content.filter(
    (part) => part.type === "image"
  );

test("keeps text order and embedded resource pixels", () => {
  const shot = image();
  expect(
    mcpToolResult(
      [
        { type: "text", text: "before" },
        {
          type: "resource",
          resource: {
            uri: "lobu://run/42/attachment/0",
            mimeType: shot.mimeType,
            blob: shot.data,
          },
        },
        { type: "text", text: "after" },
      ],
      "empty"
    ).content
  ).toEqual([
    { type: "text", text: "before" },
    shot,
    { type: "text", text: "after" },
  ]);
});

test.each([
  null,
  {},
  "bad",
  "",
  "====",
  "not/base64!",
  Buffer.from("not a PNG").toString("base64"),
])("rejects invalid image data %j visibly", (data) => {
  const result = mcpToolResult([{ ...image(), data }], "empty");
  expect(result.content.some((part) => part.type === "image")).toBe(false);
  expect(JSON.stringify(result)).toContain("Image not delivered");
});

test("rejects MIME mismatch and unsupported images", () => {
  expect(images([{ ...image(), mimeType: "image/jpeg" }])).toHaveLength(0);
  expect(images([{ ...image(), mimeType: "image/svg+xml" }])).toHaveLength(0);
});

test("does not fetch resource links or describe them as pixels", () => {
  const result = mcpToolResult(
    [
      {
        type: "resource_link",
        mimeType: "image/png",
        uri: "https://private.example.test/signed",
      },
    ],
    "empty"
  );
  expect(JSON.stringify(result)).toContain(
    "resource link alone is not a visual observation"
  );
  expect(result.content.some((part) => part.type === "image")).toBe(false);
});

test("reports a model without image support instead of silently dropping pixels", () => {
  const result = mcpToolResult([image()], "empty", false);
  expect(JSON.stringify(result)).toContain(
    "selected model does not declare image input support"
  );
  expect(result.content.some((part) => part.type === "image")).toBe(false);
});

test("bounds per-image bytes, total bytes and count", () => {
  const large = Buffer.alloc(MAX_TOOL_IMAGE_BYTES, 0);
  syntheticImage().bytes.copy(large);
  const full = { ...image(), data: large.toString("base64") };
  expect(images([full, full, full])).toHaveLength(2);
  expect(
    images([
      {
        ...full,
        data: Buffer.concat([large, Buffer.from([0])]).toString("base64"),
      },
    ])
  ).toHaveLength(0);
  expect(
    images(Array.from({ length: MAX_TOOL_IMAGES + 1 }, image))
  ).toHaveLength(MAX_TOOL_IMAGES);
});

test("falls back when the tool returned only empty text", () => {
  expect(
    mcpToolResult([{ type: "text", text: "" }], "observe completed.").content
  ).toEqual([{ type: "text", text: "observe completed." }]);
});

test("small observations are charged by bytes, not historical image count", () => {
  const budget = { bytes: 1024 };
  expect(
    mcpToolResult([image()], "empty", true, budget).content.some(
      (part) => part.type === "image"
    )
  ).toBe(true);
});
