/** Portable connector file input. The gateway resolves references after approval. */
export interface FileReference {
  $file: string;
  filename?: string;
  content_type?: string;
  size_bytes?: number;
  sha256?: string;
}

/** The bytes presented to connector code, outside the agent's script bridge. */
export interface ConnectorFile {
  base64: string;
  filename: string;
  content_type: string;
}

export interface FileInputOptions {
  maxBytes: number;
  contentTypes?: string[];
}

/** Base64 expands this to the isolate's existing 16 MiB string-message cap. */
export const MAX_CONNECTOR_FILE_BYTES = 12 * 1024 * 1024;

/**
 * Declare a file-valued action field. Clients may pass a Lobu file reference
 * or existing inline bytes. Connector code always receives ConnectorFile.
 * This is a Lobu connector contract, not a declaration of draft MCP support.
 */
export function fileInputSchema(options: FileInputOptions): Record<string, unknown> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || options.maxBytes > MAX_CONNECTOR_FILE_BYTES) {
    throw new Error(`fileInputSchema maxBytes must be between 1 and ${MAX_CONNECTOR_FILE_BYTES}`);
  }
  const metadata = {
    filename: { type: 'string', minLength: 1, maxLength: 255 },
    content_type: { type: 'string', minLength: 1, maxLength: 100 },
  };
  return {
    'x-lobu-file': options,
    description: 'Pass a file from run_sdk ctx.files or an authenticated Lobu file upload. Do not copy file bytes through the model or use a local pathname.',
    anyOf: [
      {
        type: 'object',
        properties: {
          $file: { type: 'string', pattern: '^lobu://file/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
          ...metadata,
          size_bytes: { type: 'integer', minimum: 1 },
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
        required: ['$file'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          base64: { type: 'string', minLength: 4, maxLength: 4 * Math.ceil(options.maxBytes / 3) },
          ...metadata,
        },
        required: ['base64', 'filename', 'content_type'],
        additionalProperties: false,
      },
    ],
  };
}
