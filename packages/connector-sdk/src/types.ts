/**
 * Consolidated environment bindings used across the platform.
 * This is the single source of truth for environment variable types
 * read by the gateway, worker, and connector code.
 */
export interface Env {
  // Environment
  ENVIRONMENT: string;
  MAX_CONSECUTIVE_FAILURES?: string;
  DATABASE_URL?: string;
  PUBLIC_LOGO_URL?: string;
  PUBLIC_LEGAL_URL?: string;

  // Space- or comma-separated list of origins allowed to iframe the SPA.
  // Applied as `Content-Security-Policy: frame-ancestors 'self' <list>` on
  // HTML responses. Defaults to `https://lobu.ai https://*.lobu.ai` when unset.
  FRAME_ANCESTORS?: string;

  // Single-user-mode toggle ("1" enables). When on, blocks /api/auth/sign-up/*
  // so the bootstrap user can't be forked into a second account. `lobu run`
  // defaults this on; multi-user deployments leave it unset.
  LOBU_SINGLE_USER?: string;

  // DB-connector egress policy delivered into the connector run.
  // "block-private" (injected under cloud mode) makes a DB connector reject
  // internal/metadata hosts; anything else ⇒ trusted "allow-private".
  LOBU_DB_EGRESS_POLICY?: string;
  // Operator-configured exact hosts exempt from the private-address block.
  // Delivered by the gateway; tenant connection config cannot override it.
  LOBU_DB_EGRESS_ALLOW_HOSTS?: string;

  // Sync intervals
  DEFAULT_SYNC_INTERVAL_MS?: string;
  DEFAULT_SYNC_INTERVAL_HOURS?: string;
  DEFAULT_SYNC_INTERVAL_X_MS?: string;
  DEFAULT_SYNC_INTERVAL_REDDIT_MS?: string;
  DEFAULT_SYNC_INTERVAL_GITHUB_MS?: string;

  // API Credentials
  GITHUB_TOKEN?: string; // GitHub API token for connectors
  GOOGLE_MAPS_API_KEY?: string; // Google Maps API key
  REDDIT_CLIENT_ID?: string; // Reddit API client ID
  REDDIT_CLIENT_SECRET?: string; // Reddit API client secret
  REDDIT_USER_AGENT?: string; // Reddit API user agent
  JWT_SECRET?: string; // JWT secret for signing window tokens
  WORKER_API_TOKEN?: string; // Optional shared token for internal worker endpoints
  ANTHROPIC_API_KEY?: string; // Anthropic API key

  // Embeddings
  EMBEDDINGS_SERVICE_URL?: string; // Embeddings service base URL
  EMBEDDINGS_SERVICE_TOKEN?: string; // Optional auth token for embeddings service
  EMBEDDINGS_MODEL?: string; // Embeddings model name
  EMBEDDINGS_DIMENSIONS?: string; // Embeddings vector dimensions
  EMBEDDINGS_TIMEOUT_MS?: string; // Optional timeout for embeddings requests

  // Classifier service (engine: 'service' classifiers)
  CLASSIFIER_SERVICE_URL?: string; // Base URL of a POST /v1/classify server (classifier.dev, local model, …)
  CLASSIFIER_SERVICE_TOKEN?: string; // Optional bearer token for the classifier service
  CLASSIFIER_SERVICE_TIMEOUT_MS?: string; // Optional timeout for classifier service requests

  // Better-Auth Configuration
  BETTER_AUTH_SECRET?: string; // Session signing secret
  GITHUB_CLIENT_ID?: string; // GitHub OAuth client ID
  GITHUB_CLIENT_SECRET?: string; // GitHub OAuth client secret
  GOOGLE_CLIENT_ID?: string; // Google OAuth client ID
  GOOGLE_CLIENT_SECRET?: string; // Google OAuth client secret
  APPLE_CLIENT_ID?: string; // Apple OAuth client ID
  APPLE_CLIENT_SECRET?: string; // Apple OAuth client secret

  // Transactional email (Resend)
  RESEND_API_KEY?: string; // Resend API key
  EMAIL_FROM_AUTH?: string; // From address for auth emails (magic link, password reset). e.g. "Lobu <auth@lobu.ai>"
  EMAIL_FROM_INVITES?: string; // From address for org invitations. e.g. "Lobu <invites@lobu.ai>"
  EMAIL_REPLY_TO?: string; // Reply-To address, e.g. "support@lobu.ai"
  EMAIL_UNSUBSCRIBE?: string; // List-Unsubscribe header value, e.g. "mailto:unsubscribe@lobu.ai"

  // WhatsApp OTP (Twilio)
  TWILIO_SID?: string; // Twilio account SID
  TWILIO_TOKEN?: string; // Twilio auth token
  TWILIO_WHATSAPP_NUMBER?: string; // Twilio WhatsApp number

  // Allow any other env vars accessed via c.env[key]
  [key: string]: string | undefined;
}
