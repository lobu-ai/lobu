/** Internal protocol shared by the API and the isolated browser runner.
 * No credentials, org data, executable server callbacks, or author API changes. */
import { createHash } from 'node:crypto';

export const VALIDATION_MAX_BYTES = 8 * 1024 * 1024;
export const VALIDATION_TIMEOUT_MS = 20_000;
export interface ValidationArtifact {
  html: string;
  runtime: string;
  assets: Record<string, { body: string; contentType: string }>;
}
export interface ValidationScenario {
  theme: 'light' | 'dark';
  displayMode: 'inline' | 'fullscreen';
  queryState: 'empty' | 'error' | 'loading';
  scope: Record<string, string | number>;
  params: Record<string, string | number | boolean>;
}
export interface ValidationRequest {
  artifact: ValidationArtifact;
  scenarios: ValidationScenario[];
  /** Origins the view declared for images. The runner aborts those image
   * requests without a diagnostic; every other request still fails. */
  resources: string[];
}
export interface ValidationResult {
  passed: boolean;
  artifactHash: string;
  runtimeHash: string;
  diagnostics: string[];
}
export function validationIdentity(artifact: ValidationArtifact): Pick<ValidationResult, 'artifactHash' | 'runtimeHash'> {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const assets = Object.entries(artifact.assets).sort(([a], [b]) => a.localeCompare(b));
  return {
    artifactHash: digest(JSON.stringify([artifact.html, assets])),
    runtimeHash: digest(JSON.stringify([artifact.runtime, assets])),
  };
}
