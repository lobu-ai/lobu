/**
 * Gateway API response types shared between the server and UI consumers.
 */

import type { ConnectionSettings } from "./agent-store";

export interface CatalogProvider {
  id: string;
  name: string;
  iconUrl: string;
  authType: "oauth" | "device-code" | "api-key";
  supportedAuthTypes: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions: string;
  apiKeyPlaceholder: string;
  capabilities: (
    | "text"
    | "image-generation"
    | "speech-to-text"
    | "text-to-speech"
  )[];
}

export interface ModelOption {
  label: string;
  value: string;
}

export interface Skill {
  repo: string;
  name: string;
  description: string;
  enabled: boolean;
  system?: boolean;
  content?: string;
  permissions?: string[];
}

export interface McpConfig {
  enabled?: boolean;
  url?: string;
  command?: string;
  args?: string[];
  type?: string;
  description?: string;
}

export interface PrefillSkill {
  repo: string;
  name?: string;
  description?: string;
}

export interface PrefillMcp {
  id: string;
  name?: string;
  url?: string;
  type?: string;
  command?: string;
  args?: string[];
  envVars?: string[];
}

export interface Connection {
  id: string;
  platform: string;
  agentId?: string;
  config: Record<string, unknown>;
  settings: ConnectionSettings;
  metadata: Record<string, unknown>;
  status: "active" | "stopped" | "error";
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}
