import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RegistryProvider {
  id: string;
  name: string;
  description: string;
  hidden?: boolean;
  providers: Array<{
    displayName: string;
    envVarName: string;
    upstreamBaseUrl: string;
    apiKeyInstructions?: string;
    modelsEndpoint?: string;
  }>;
}

let _cache: RegistryProvider[] | null = null;

export function loadProviderRegistry(): RegistryProvider[] {
  if (_cache) return _cache;

  try {
    const raw = readFileSync(
      join(__dirname, "..", "..", "..", "..", "..", "config", "providers.json"),
      "utf-8"
    );
    const data = JSON.parse(raw) as { providers: RegistryProvider[] };
    _cache = data.providers;
    return _cache;
  } catch {
    try {
      const raw = readFileSync(
        join(__dirname, "..", "..", "providers.json"),
        "utf-8"
      );
      const data = JSON.parse(raw) as { providers: RegistryProvider[] };
      _cache = data.providers;
      return _cache;
    } catch {
      return [];
    }
  }
}

export function getProviderById(id: string): RegistryProvider | undefined {
  return loadProviderRegistry().find((provider) => provider.id === id);
}
