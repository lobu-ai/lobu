/**
 * ElevenLabs Connector (lobu-team project-owned) — speech and audio.
 *
 *   - `transcribe({ audio })` → Scribe speech-to-text with word timestamps.
 *   - `align({ audio, text })` → forced alignment of a known script to audio.
 *   - `list_voices({ search })` → voices the account can speak with (free).
 *   - `speak({ voice_id, text })` → text-to-speech; the audio comes back as an
 *     attachment with a download_url.
 *   - `compose_music({ prompt })` → a music track, also as an attachment.
 *
 * Audio inputs are Lobu file inputs (`fileInputSchema`), so bytes travel from
 * the artifact store to the connector and never through the model. Generated
 * audio leaves through `fileDownloadOutput`, which the gateway publishes as an
 * artifact.
 *
 * Auth is `env_keys` ELEVENLABS_API_KEY, sent as the `xi-api-key` header.
 * It arrives via ctx.config; nothing secret is logged or returned.
 *
 * Every action except `list_voices` spends ElevenLabs credits, and a retry
 * spends them again, so none of them claim `idempotentHint`.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorFile,
  ConnectorRuntime,
  downloadSizeError,
  fileDownloadOutput,
  fileInputSchema,
  MAX_CONNECTOR_FILE_BYTES,
  type RuntimeConnectorDefinition,
} from "@lobu/connector-sdk";

const API_BASE = "https://api.elevenlabs.io";
const DEFAULT_STT_MODEL = "scribe_v2";
const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";
const DEFAULT_MUSIC_MODEL = "music_v1";
const MAX_TTS_CHARS = 5000;
const MAX_ALIGN_TEXT_CHARS = 20_000;
// mp3 at 128 kbps is ~1 MB a minute; 5 minutes keeps a track well under the
// gateway's 8 MiB attachment cap. The API itself allows up to 10 minutes.
const MIN_MUSIC_MS = 3000;
const MAX_MUSIC_MS = 300_000;
const MAX_VOICES_PAGE = 100;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function readApiKey(config: Record<string, unknown>): string {
  const key = (config.ELEVENLABS_API_KEY as string | undefined)?.trim();
  if (!key) {
    throw new Error(
      "ElevenLabs API key is missing. Set ELEVENLABS_API_KEY on the connection's auth profile."
    );
  }
  return key;
}

/** Classify an ElevenLabs HTTP response by status code; returns only when ok. */
async function assertHttpOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  const detail = text.slice(0, 300);
  if (response.status === 401) {
    throw new Error(
      `ElevenLabs rejected the API key (HTTP 401). Check ELEVENLABS_API_KEY and its permissions: ${detail}`
    );
  }
  if (response.status === 402) {
    throw new Error(
      `ElevenLabs ${label} needs more credits or a higher plan (HTTP 402): ${detail}`
    );
  }
  if (response.status === 429) {
    throw new Error(
      `ElevenLabs ${label} is rate limited or over its concurrency limit (HTTP 429): ${detail}`
    );
  }
  throw new Error(
    `ElevenLabs ${label} failed (HTTP ${response.status}): ${detail}`
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The resolved file input as a multipart Blob part. */
function audioPart(
  value: unknown,
  field: string
): { blob: Blob; filename: string } {
  const file = asRecord(value) as Partial<ConnectorFile> | null;
  if (
    typeof file?.base64 !== "string" ||
    typeof file.filename !== "string" ||
    typeof file.content_type !== "string"
  ) {
    throw new Error(`${field} must be a file input`);
  }
  return {
    blob: new Blob([Buffer.from(file.base64, "base64")], {
      type: file.content_type,
    }),
    filename: file.filename,
  };
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required`);
  if (text.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return text;
}

interface TimedWord {
  text: string;
  start: number;
  end: number;
  type?: string;
  speaker_id?: string;
}

/** Keep the timing fields of a word list; drop per-character detail. Pure. */
export function parseWords(value: unknown): TimedWord[] {
  const rows = Array.isArray(value) ? value : [];
  const out: TimedWord[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    const text = asString(row?.text);
    const start = asNumber(row?.start);
    const end = asNumber(row?.end);
    if (!row || text === undefined || start === undefined || end === undefined)
      continue;
    const word: TimedWord = { text, start, end };
    const type = asString(row.type);
    if (type) word.type = type;
    const speaker = asString(row.speaker_id);
    if (speaker) word.speaker_id = speaker;
    out.push(word);
  }
  return out;
}

/** "Ada's voice!" → "ada-s-voice" for generated filenames. Pure. */
function fileStem(text: string, fallback: string): string {
  const stem = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return stem || fallback;
}

const audioInput = fileInputSchema({ maxBytes: MAX_CONNECTOR_FILE_BYTES });

const transcribeInputSchema = {
  type: "object",
  required: ["audio"],
  properties: {
    audio: {
      ...audioInput,
      description: `Audio or video file to transcribe (at most ${MAX_CONNECTOR_FILE_BYTES / 1024 / 1024} MiB). ${audioInput.description}`,
    },
    language_code: {
      type: "string",
      description:
        "ISO-639-1 or ISO-639-3 language code. Omit to detect the language.",
    },
    diarize: {
      type: "boolean",
      description: "Label which speaker says each word. Defaults to false.",
    },
    num_speakers: {
      type: "integer",
      minimum: 1,
      maximum: 32,
      description: "Maximum number of speakers, when known.",
    },
    tag_audio_events: {
      type: "boolean",
      description:
        "Tag events such as (laughter) in the transcript. Defaults to false.",
    },
    keyterms: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 50 },
      description:
        "Words to bias recognition towards, such as product and people names.",
    },
    model_id: {
      type: "string",
      description: `Scribe model. Defaults to ${DEFAULT_STT_MODEL}.`,
    },
  },
};

const alignInputSchema = {
  type: "object",
  required: ["audio", "text"],
  properties: {
    audio: {
      ...audioInput,
      description: `Audio file to align (at most ${MAX_CONNECTOR_FILE_BYTES / 1024 / 1024} MiB). ${audioInput.description}`,
    },
    text: {
      type: "string",
      minLength: 1,
      maxLength: MAX_ALIGN_TEXT_CHARS,
      description: "The exact script spoken in the audio.",
    },
  },
};

const listVoicesInputSchema = {
  type: "object",
  properties: {
    search: {
      type: "string",
      description: "Match voice name, description, labels or category.",
    },
    category: {
      type: "string",
      enum: ["premade", "cloned", "generated", "professional"],
      description: "Only voices of this category.",
    },
    page_size: {
      type: "integer",
      minimum: 1,
      maximum: MAX_VOICES_PAGE,
      description: "Voices per page. Defaults to 30.",
    },
    next_page_token: {
      type: "string",
      description: "Token from the previous page's output.",
    },
  },
};

const speakInputSchema = {
  type: "object",
  required: ["voice_id", "text"],
  properties: {
    voice_id: {
      type: "string",
      minLength: 1,
      description: "Voice to speak with. Find it with list_voices.",
    },
    text: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TTS_CHARS,
      description: `Text to speak (at most ${MAX_TTS_CHARS} characters).`,
    },
    model_id: {
      type: "string",
      description: `Text-to-speech model. Defaults to ${DEFAULT_TTS_MODEL}.`,
    },
    language_code: {
      type: "string",
      description: "ISO-639-1 code to force a language.",
    },
    output_format: {
      type: "string",
      description:
        "codec_samplerate_bitrate, such as mp3_44100_128 (the default). Higher formats need a higher plan.",
    },
    voice_settings: {
      type: "object",
      description:
        "Overrides for this request: stability, similarity_boost, style (0 to 1), speed, use_speaker_boost.",
      properties: {
        stability: { type: "number", minimum: 0, maximum: 1 },
        similarity_boost: { type: "number", minimum: 0, maximum: 1 },
        style: { type: "number", minimum: 0, maximum: 1 },
        speed: { type: "number", minimum: 0.7, maximum: 1.2 },
        use_speaker_boost: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
};

const composeMusicInputSchema = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: 4100,
      description: "What the track should sound like.",
    },
    music_length_ms: {
      type: "integer",
      minimum: MIN_MUSIC_MS,
      maximum: MAX_MUSIC_MS,
      description: `Track length in milliseconds (${MIN_MUSIC_MS} to ${MAX_MUSIC_MS}). Omit to let the model choose.`,
    },
    force_instrumental: {
      type: "boolean",
      description: "Guarantee no vocals. Defaults to false.",
    },
    model_id: {
      type: "string",
      description: `Music model. Defaults to ${DEFAULT_MUSIC_MODEL}.`,
    },
  },
};

export default class ElevenLabsConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "elevenlabs",
    name: "ElevenLabs",
    description:
      "Speech-to-text with word timings, forced alignment, text-to-speech and music through the ElevenLabs API. Generated audio comes back as a downloadable attachment.",
    version: "1.0.0",
    faviconDomain: "elevenlabs.io",
    authSchema: {
      methods: [
        {
          type: "env_keys",
          required: true,
          scope: "connection",
          description:
            "An API key from elevenlabs.io/app/settings/api-keys with access to speech-to-text, text-to-speech, forced alignment, music and voices (read).",
          fields: [
            {
              key: "ELEVENLABS_API_KEY",
              label: "API key",
              secret: true,
              required: true,
            },
          ],
        },
      ],
    },
    actions: {
      transcribe: {
        key: "transcribe",
        name: "Transcribe audio",
        kind: "read",
        description:
          "Transcribe an audio or video file with ElevenLabs Scribe. Returns the text, the detected language and every word with start/end seconds (and speaker when diarize is on). Spends credits.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: transcribeInputSchema,
      },
      align: {
        key: "align",
        name: "Align script to audio",
        kind: "read",
        description:
          "Time a known script against its recording. Returns every word with start/end seconds and an alignment loss (lower is better). Spends credits.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: alignInputSchema,
      },
      list_voices: {
        key: "list_voices",
        name: "List voices",
        kind: "read",
        description:
          "List voices the account can use with speak: voice_id, name, category, labels and description. Free.",
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: listVoicesInputSchema,
      },
      speak: {
        key: "speak",
        name: "Text to speech",
        kind: "write",
        description:
          "Speak text in an ElevenLabs voice. Returns the audio as an attachment with a download_url. Spends credits.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
        inputSchema: speakInputSchema,
      },
      compose_music: {
        key: "compose_music",
        name: "Compose music",
        kind: "write",
        description:
          "Generate a music track from a prompt. Returns the audio as an attachment with a download_url. Spends credits.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
        inputSchema: composeMusicInputSchema,
      },
    },
  };

  fetchImpl: FetchLike = fetch;

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      const apiKey = readApiKey(ctx.config);
      const input = asRecord(ctx.input) ?? {};
      switch (ctx.actionKey) {
        case "transcribe":
          return await this.transcribe(apiKey, input);
        case "align":
          return await this.align(apiKey, input);
        case "list_voices":
          return await this.listVoices(apiKey, input);
        case "speak":
          return await this.speak(apiKey, input);
        case "compose_music":
          return await this.composeMusic(apiKey, input);
        default:
          return { success: false, error: `Unknown action '${ctx.actionKey}'` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async transcribe(
    apiKey: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const { blob, filename } = audioPart(input.audio, "audio");
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model_id", asString(input.model_id) ?? DEFAULT_STT_MODEL);
    form.append("timestamps_granularity", "word");
    form.append("tag_audio_events", String(input.tag_audio_events === true));
    form.append("diarize", String(input.diarize === true));
    const language = asString(input.language_code)?.trim();
    if (language) form.append("language_code", language);
    const speakers = asNumber(input.num_speakers);
    if (speakers !== undefined) form.append("num_speakers", String(speakers));
    if (Array.isArray(input.keyterms)) {
      for (const term of input.keyterms) {
        if (typeof term === "string" && term.trim())
          form.append("keyterms", term.trim());
      }
    }

    const response = await this.fetchImpl(`${API_BASE}/v1/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
    await assertHttpOk(response, "transcription");
    const body = asRecord(await response.json()) ?? {};
    const words = parseWords(body.words);
    return {
      success: true,
      output: {
        text: asString(body.text) ?? "",
        language_code: asString(body.language_code),
        language_probability: asNumber(body.language_probability),
        audio_duration_secs: asNumber(body.audio_duration_secs),
        transcription_id: asString(body.transcription_id),
        word_count: words.filter((word) => word.type !== "spacing").length,
        // Spacing tokens carry timing between words; keep only real words and
        // tagged audio events so the list is what a caller would cut on.
        words: words.filter((word) => word.type !== "spacing"),
      },
    };
  }

  private async align(
    apiKey: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const { blob, filename } = audioPart(input.audio, "audio");
    const text = requiredText(input.text, "text", MAX_ALIGN_TEXT_CHARS);
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("text", text);

    const response = await this.fetchImpl(`${API_BASE}/v1/forced-alignment`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
    await assertHttpOk(response, "alignment");
    const body = asRecord(await response.json()) ?? {};
    const words = parseWords(body.words);
    return {
      success: true,
      output: { loss: asNumber(body.loss), word_count: words.length, words },
    };
  }

  private async listVoices(
    apiKey: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const url = new URL(`${API_BASE}/v2/voices`);
    const pageSize = Math.min(asNumber(input.page_size) ?? 30, MAX_VOICES_PAGE);
    url.searchParams.set("page_size", String(pageSize));
    const search = asString(input.search)?.trim();
    if (search) url.searchParams.set("search", search);
    const category = asString(input.category);
    if (category) url.searchParams.set("category", category);
    const token = asString(input.next_page_token);
    if (token) url.searchParams.set("next_page_token", token);

    const response = await this.fetchImpl(url.toString(), {
      headers: { "xi-api-key": apiKey },
    });
    await assertHttpOk(response, "voice list");
    const body = asRecord(await response.json()) ?? {};
    const voices = (Array.isArray(body.voices) ? body.voices : [])
      .map(asRecord)
      .filter((voice): voice is Record<string, unknown> => voice !== null)
      .map((voice) => ({
        voice_id: asString(voice.voice_id),
        name: asString(voice.name),
        category: asString(voice.category),
        description: asString(voice.description),
        labels: asRecord(voice.labels) ?? undefined,
      }))
      .filter((voice) => voice.voice_id);
    return {
      success: true,
      output: {
        voices,
        total_count: asNumber(body.total_count),
        has_more: body.has_more === true,
        next_page_token: asString(body.next_page_token),
      },
    };
  }

  private async speak(
    apiKey: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const voiceId = requiredText(input.voice_id, "voice_id", 100);
    const text = requiredText(input.text, "text", MAX_TTS_CHARS);
    const format = asString(input.output_format) ?? "mp3_44100_128";
    const url = new URL(
      `${API_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}`
    );
    url.searchParams.set("output_format", format);
    const body: Record<string, unknown> = {
      text,
      model_id: asString(input.model_id) ?? DEFAULT_TTS_MODEL,
    };
    const language = asString(input.language_code)?.trim();
    if (language) body.language_code = language;
    const settings = asRecord(input.voice_settings);
    if (settings) body.voice_settings = settings;

    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/*",
      },
      body: JSON.stringify(body),
    });
    await assertHttpOk(response, "text-to-speech");
    return this.audioOutput(response, fileStem(text, "speech"), format, {
      voice_id: voiceId,
      characters: text.length,
      request_id: response.headers.get("request-id") ?? undefined,
    });
  }

  private async composeMusic(
    apiKey: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const prompt = requiredText(input.prompt, "prompt", 4100);
    const body: Record<string, unknown> = {
      prompt,
      model_id: asString(input.model_id) ?? DEFAULT_MUSIC_MODEL,
    };
    const length = asNumber(input.music_length_ms);
    if (length !== undefined) {
      if (length < MIN_MUSIC_MS || length > MAX_MUSIC_MS) {
        throw new Error(
          `music_length_ms must be between ${MIN_MUSIC_MS} and ${MAX_MUSIC_MS}`
        );
      }
      body.music_length_ms = Math.round(length);
    }
    if (input.force_instrumental === true) body.force_instrumental = true;

    const format = "mp3_44100_128";
    const response = await this.fetchImpl(
      `${API_BASE}/v1/music?output_format=${format}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/*",
        },
        body: JSON.stringify(body),
      }
    );
    await assertHttpOk(response, "music generation");
    return this.audioOutput(response, fileStem(prompt, "music"), format, {
      music_length_ms: body.music_length_ms,
    });
  }

  /** Publish a generated audio body as an attachment, refusing oversize. */
  private async audioOutput(
    response: Response,
    stem: string,
    format: string,
    extra: Record<string, unknown>
  ): Promise<ActionResult> {
    const declared = Number(response.headers.get("content-length") ?? "");
    const declaredError = downloadSizeError(
      Number.isFinite(declared) && declared > 0 ? declared : undefined,
      stem
    );
    if (declaredError) throw new Error(declaredError);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sizeError = downloadSizeError(bytes.length, stem);
    if (sizeError) throw new Error(sizeError);
    const codec = format.split("_")[0] || "mp3";
    const mimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      (codec === "mp3" ? "audio/mpeg" : `audio/${codec}`);
    const extension =
      codec === "pcm" ? "pcm" : codec === "ulaw" ? "ulaw" : codec;
    return {
      success: true,
      output: {
        ...extra,
        output_format: format,
        ...fileDownloadOutput({
          bytes,
          filename: `${stem}.${extension}`,
          mimeType,
          inlineMaxBytes: 0,
        }),
      },
    };
  }
}
