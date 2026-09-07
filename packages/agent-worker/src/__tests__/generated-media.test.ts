import { afterEach, describe, expect, mock, test } from "bun:test";
import { generateAudio, generateImage } from "@lobu/plugin-media";

const originalFetch = globalThis.fetch;

function extractText(result: {
  content: Array<{ type: "text"; text: string }>;
}): string {
  return result.content[0]?.text || "";
}

/**
 * The upload body is a `FormData`, so the runtime — not the plugin — owns the
 * boundary and the `Content-Type`. Assert the PARTS rather than a serialised
 * string: it is what the gateway route actually reads
 * (`formData.get("file")`), and it is the same shape on both lanes.
 */
function uploadParts(body: BodyInit | null | undefined): {
  file: File;
  filename: string;
  comment: string;
} {
  if (!(body instanceof FormData)) {
    throw new Error(`expected a FormData upload body, got ${typeof body}`);
  }
  const file = body.get("file");
  if (!(file instanceof File)) throw new Error("the file part is not a file");
  return {
    file,
    filename: String(body.get("filename")),
    comment: String(body.get("comment")),
  };
}

describe("generated media upload flow", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("generate_image uploads the generated image to the gateway", async () => {
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/internal/images/capabilities")) {
          return Response.json({ available: true });
        }

        if (url.endsWith("/internal/images/generate")) {
          return new Response(Buffer.from("png-bytes"), {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "X-Image-Provider": "openai",
            },
          });
        }

        if (url.endsWith("/internal/files/upload")) {
          const headers = new Headers(init?.headers);
          const parts = uploadParts(init?.body);

          expect(init?.method).toBe("POST");
          expect(headers.get("Authorization")).toBe("Bearer worker-token");
          expect(headers.get("X-Channel-Id")).toBe("channel-1");
          expect(headers.get("X-Conversation-Id")).toBe("conversation-1");
          expect(headers.get("X-Voice-Message")).toBeNull();
          // The runtime derives the multipart Content-Type and its boundary
          // from the FormData body, so the plugin must NOT set one itself: a
          // hand-written header would carry the wrong boundary.
          expect(headers.get("Content-Type")).toBeNull();
          expect(parts.file.name).toBe("generated_image.png");
          expect(parts.file.type).toBe("image/png");
          // The provider's bytes, straight through — no temp file in between.
          expect(await parts.file.text()).toBe("png-bytes");
          expect(parts.filename).toBe("generated_image.png");
          expect(parts.comment).toBe("Generated content");

          return Response.json({ success: true, fileId: "file-1" });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateImage(
      {
        gatewayUrl: "http://gateway",
        workerToken: "worker-token",
        channelId: "channel-1",
        conversationId: "conversation-1",
        platform: "telegram",
      },
      { prompt: "A watercolor fox" }
    );

    expect(extractText(result as any)).toContain("Image sent successfully");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("generate_audio uploads synthesized speech as a voice message", async () => {
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/internal/audio/capabilities")) {
          return Response.json({
            available: true,
            providers: [{ provider: "openai", name: "OpenAI" }],
          });
        }

        if (url.endsWith("/internal/audio/synthesize")) {
          return new Response(Buffer.from("ogg-bytes"), {
            status: 200,
            headers: {
              "Content-Type": "audio/ogg",
              "X-Audio-Provider": "openai",
            },
          });
        }

        if (url.endsWith("/internal/files/upload")) {
          const headers = new Headers(init?.headers);
          const parts = uploadParts(init?.body);

          expect(init?.method).toBe("POST");
          expect(headers.get("Authorization")).toBe("Bearer worker-token");
          expect(headers.get("X-Channel-Id")).toBe("channel-1");
          expect(headers.get("X-Conversation-Id")).toBe("conversation-1");
          expect(headers.get("X-Voice-Message")).toBe("true");
          expect(headers.get("Content-Type")).toBeNull();
          expect(parts.file.name).toBe("voice_response.ogg");
          expect(parts.file.type).toBe("audio/ogg");
          expect(await parts.file.text()).toBe("ogg-bytes");
          expect(parts.filename).toBe("voice_response.ogg");
          expect(parts.comment).toBe("Generated content");

          return Response.json({ success: true, fileId: "file-2" });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateAudio(
      {
        gatewayUrl: "http://gateway",
        workerToken: "worker-token",
        channelId: "channel-1",
        conversationId: "conversation-1",
        platform: "telegram",
      },
      { text: "Hello there" }
    );

    expect(extractText(result as any)).toContain(
      "Voice message sent successfully"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
