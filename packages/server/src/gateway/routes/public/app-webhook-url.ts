/**
 * The public URL of a provider's shared app-webhook endpoint
 * (`/api/v1/app-webhooks/:provider`). It is also the JWT audience a
 * provider-signed delivery names, so the router and every runtime that
 * re-verifies a delivery derive it here and nowhere else. Import-free so chat
 * platform modules can use it without pulling in the router's graph.
 */
export function appWebhookUrl(publicGatewayUrl: string, provider: string): string {
	return `${publicGatewayUrl.replace(/\/+$/, "")}/api/v1/app-webhooks/${encodeURIComponent(provider)}`;
}
