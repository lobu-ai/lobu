import { describe, expect, it } from "bun:test";
import type { ActionContext } from "@lobu/connector-sdk";
import ElevenLabsConnector from "../elevenlabs.connector.ts";

const config = { ELEVENLABS_API_KEY: "synthetic-key" };
const audio = {
  base64: Buffer.from("synthetic audio bytes").toString("base64"),
  filename: "take.m4a",
  content_type: "audio/mp4",
};

/** Fake ElevenLabs API: answers only requests carrying the synthetic key. */
function fakeApi() {
  const forms: Record<string, FormData> = {};
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (headers.get("xi-api-key") !== config.ELEVENLABS_API_KEY) {
      return Response.json({ detail: "invalid_api_key" }, { status: 401 });
    }
    if (init?.body instanceof FormData) forms[url.pathname] = init.body;
    if (url.pathname === "/v1/speech-to-text") {
      return Response.json({
        text: "Hi, I'm Ada.",
        language_code: "eng",
        words: [
          { text: "Hi,", start: 0.1, end: 0.4, type: "word" },
          { text: " ", start: 0.4, end: 0.45, type: "spacing" },
          { text: "I'm", start: 0.45, end: 0.6, type: "word" },
          {
            text: "Ada.",
            start: 0.62,
            end: 1.0,
            type: "word",
            characters: [],
          },
        ],
      });
    }
    if (url.pathname.startsWith("/v1/text-to-speech/")) {
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
        headers: { "content-type": "audio/mpeg" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { forms, fetchImpl };
}

function connector(fetchImpl: ElevenLabsConnector["fetchImpl"]) {
  const instance = new ElevenLabsConnector();
  instance.fetchImpl = fetchImpl;
  return instance;
}

function run(
  instance: ElevenLabsConnector,
  actionKey: string,
  input: Record<string, unknown>,
  actionConfig: Record<string, unknown> = config
) {
  return instance.execute({
    actionKey,
    input,
    config: actionConfig,
  } as unknown as ActionContext);
}

describe("ElevenLabs connector", () => {
  it("transcribes an uploaded file into timed words", async () => {
    const api = fakeApi();
    const result = await run(connector(api.fetchImpl), "transcribe", {
      audio,
      keyterms: ["Lobu", "Ada"],
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      text: "Hi, I'm Ada.",
      word_count: 3,
      words: [
        { text: "Hi,", start: 0.1, end: 0.4 },
        { text: "I'm", start: 0.45, end: 0.6 },
        { text: "Ada.", start: 0.62, end: 1.0 },
      ],
    });
    const form = api.forms["/v1/speech-to-text"];
    const file = form?.get("file") as File;
    expect(file.name).toBe("take.m4a");
    expect(await file.text()).toBe("synthetic audio bytes");
    expect(form?.get("timestamps_granularity")).toBe("word");
    expect(form?.getAll("keyterms")).toEqual(["Lobu", "Ada"]);
  });

  it("returns generated speech as an attachment, never inline", async () => {
    const result = await run(connector(fakeApi().fetchImpl), "speak", {
      voice_id: "voice-1",
      text: "Build your company brain.",
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.content).toBeUndefined();
    expect(output.attachments).toEqual([
      {
        filename: "build-your-company-brain.mp3",
        mime_type: "audio/mpeg",
        data: Buffer.from([0x49, 0x44, 0x33, 0x04]).toString("base64"),
        size_bytes: 4,
      },
    ]);
  });

  it("reports a rejected key without echoing it", async () => {
    const result = await run(
      connector(fakeApi().fetchImpl),
      "list_voices",
      {},
      { ELEVENLABS_API_KEY: "wrong-key" }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 401");
    expect(result.error).not.toContain("wrong-key");
  });
});
