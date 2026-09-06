import { defineLobuPlugin } from "@lobu/plugin-api";
import {
  defineGatewayTool,
  toolLogger,
  withErrorHandling,
  type GatewayParams,
} from "@lobu/plugin-toolkit";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  uploadPortedFile,
  type MediaFilePort,
  type UploadedFileNotification,
} from "./file-port";
import { generateAudio, generateImage } from "./generation";

/**
 * The media tools, over an INJECTED filesystem.
 *
 * This module is the whole plugin minus the question of what a file is, which
 * is what makes it loadable in an isolate: nothing it imports reaches a Node
 * builtin. Both entry points compose it — the package root with the Node port
 * (`upload.ts`), the isolate lane with a port over its in-memory workspace —
 * so the tools, their schemas and every sentence the model reads are one
 * implementation rather than two.
 */
export interface MediaPluginParams extends GatewayParams {
  workspaceDir: string;
  onFileUploaded: (data: Record<string, unknown>) => Promise<void> | void;
  /** Where `upload_file` reads a file. Required: there is no default lane. */
  filePort: MediaFilePort;
}

export function createMediaTools(params: MediaPluginParams): ToolDefinition[] {
  const gateway: GatewayParams = params;
  return [
    defineGatewayTool({
      name: "upload_file",
      parameters: Type.Object({
        file_path: Type.String({
          description:
            "Path to the file to show (absolute or relative to workspace)",
        }),
        description: Type.Optional(
          Type.String({ description: "Description of the file" })
        ),
      }),
      // `withErrorHandling` turns a throw from the port or the gateway into
      // the "Error: ..." text result the model reads, rather than a rejected
      // tool call the turn has to interpret.
      run: (args) =>
        withErrorHandling("Show file tool", () =>
          uploadPortedFile(gateway, params.filePort, args, {
            logger: toolLogger,
            onUploaded: (data: UploadedFileNotification) =>
              params.onFileUploaded(data as unknown as Record<string, unknown>),
          })
        ),
    }),
    defineGatewayTool({
      name: "generate_image",
      parameters: Type.Object({
        prompt: Type.String({ description: "Image-generation prompt" }),
        size: Type.Optional(
          Type.Union([
            Type.Literal("1024x1024"),
            Type.Literal("1024x1536"),
            Type.Literal("1536x1024"),
            Type.Literal("auto"),
          ])
        ),
        quality: Type.Optional(
          Type.Union([
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("auto"),
          ])
        ),
        background: Type.Optional(
          Type.Union([
            Type.Literal("transparent"),
            Type.Literal("opaque"),
            Type.Literal("auto"),
          ])
        ),
        format: Type.Optional(
          Type.Union([
            Type.Literal("png"),
            Type.Literal("jpeg"),
            Type.Literal("webp"),
          ])
        ),
      }),
      run: (args) => generateImage(gateway, args),
    }),
    defineGatewayTool({
      name: "generate_audio",
      parameters: Type.Object({
        text: Type.String({ description: "Text to convert to speech" }),
        voice: Type.Optional(Type.String({ description: "Provider voice id" })),
        speed: Type.Optional(Type.Number({ description: "Speech speed" })),
      }),
      run: (args) => generateAudio(gateway, args),
    }),
  ];
}

export function createMediaPlugin(params: MediaPluginParams) {
  return defineLobuPlugin<ToolDefinition>({
    manifest: {
      name: "lobu-media",
      version: "1.0.0",
      apiVersion: 1,
      description:
        "File delivery, image generation, and audio generation tools",
    },
    tools: () => createMediaTools(params),
  });
}
