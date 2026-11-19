/**
 * Hosted install routes for a TENANT-scoped data connector: an
 * `oauth-code-exchange` app-installation method that declares a `tenant`
 * (e.g. a merchant's own store host) and `{{tenant}}` authorize/token URLs.
 *
 *   GET /{provider}/install?{tenant.param}=<tenant>
 *     Requires a signed-in Lobu user (the claim later binds to them). Asks for
 *     the tenant when absent, rejects anything that does not FULLY match the
 *     declared pattern, binds `{tenant, installer}` into a one-time Postgres
 *     state nonce, and redirects to the tenant-rendered authorize URL.
 *   GET /{provider}/oauth_callback
 *     Consumes the state, requires the callback's tenant to equal the bound
 *     one, exchanges the code at the tenant-rendered token URL (pinned
 *     public-DNS, no-redirect fetch) and parks the grant ENCRYPTED on an
 *     org-less pending `app_installations` row, then hands the installer to the
 *     generic claim page, where the org picker decides where it lands.
 *
 * No provider literal: the provider, tenant param/pattern, endpoints and the
 * credential env-var NAMES all come from the connector's declared method.
 * Stateless across replicas: state and the pending row live in Postgres.
 */

import { randomUUID } from "node:crypto";
import { createLogger, encrypt } from "@lobu/core";
import { fetchCredentialedPublicUrl } from "@lobu/connector-worker/egress";
import type { Context, Hono } from "hono";
import { getDb } from "../../../db/client.js";
import { escapeHtml } from "../../../utils/html.js";
import { getConfiguredPublicOrigin } from "../../../utils/public-origin.js";
import { OAuthStateStore } from "../../auth/oauth/state-store.js";
import {
	renderLobuPage,
	renderOAuthErrorPage,
} from "../../auth/oauth-templates.js";
import {
	registerTenantDataInstall,
	type TenantDataInstall,
} from "../../connections/tenant-install-claim.js";
import {
	compileTenantMatcher,
	renderTenantUrl,
	resolveAppInstallCredentials,
} from "../../installation/app-install-credentials.js";
import {
	requestTenantInstallToken,
	type TenantInstallTokenFetch,
} from "../../installation/refresh-token-installation-token-provider.js";

export type { TenantInstallTokenFetch };

const logger = createLogger("tenant-app-install-routes");

/**
 * Resolve the OAuth callback URL for an oauth-code-exchange provider. Must stay
 * in sync with the provider's registered redirect URIs:
 * `<gateway-base>/{provider}/oauth_callback`. Behind the prod TLS-terminating
 * ingress `c.req.url` is the internal pod URL, so prefer the configured public
 * base; fall back to deriving the mount prefix from the request path on
 * self-host (single-origin).
 */
export function resolveOAuthInstallCallbackUrl(
	gatewayBaseUrl: string | undefined,
	requestUrl: string,
	provider: string,
): string {
	if (gatewayBaseUrl) {
		return `${gatewayBaseUrl.replace(/\/+$/, "")}/${provider}/oauth_callback`;
	}
	const url = new URL(requestUrl);
	const prefix = url.pathname.replace(
		new RegExp(`/${provider}/install/?$`),
		"",
	);
	return `${url.origin}${prefix}/${provider}/oauth_callback`;
}

/** Capitalize a provider key for the success-page title ("slack" → "Slack"). */
export function providerDisplayName(provider: string): string {
	return provider.length > 0
		? provider[0].toUpperCase() + provider.slice(1)
		: provider;
}

function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") end--;
	return value.slice(0, end);
}

interface TenantInstallState {
	redirectUri: string;
	tenant: string;
	installerUserId: string;
}

export function mountTenantAppInstallRoutes(
	router: Hono,
	params: {
		connectorKey: string;
		provider: string;
		method: TenantDataInstall["method"];
		resolveInstallUserId(c: Context): string | null;
		getPublicGatewayUrl?(): string | undefined;
		fetchTokenEndpoint?: TenantInstallTokenFetch;
	},
): void {
	const { connectorKey, provider, method } = params;
	const { param, pattern } = method.tenant;
	const authorizeUrl = method.authorizeUrl;
	const tokenUrl = method.tokenUrl;
	if (!authorizeUrl || !tokenUrl) {
		logger.warn(
			{ provider },
			"Skipping tenant install routes: connector declares no authorizeUrl/tokenUrl",
		);
		return;
	}
	const display = providerDisplayName(provider);
	const tenantMatches = compileTenantMatcher(pattern);
	const fetchToken = params.fetchTokenEndpoint ?? fetchCredentialedPublicUrl;
	const stateStore = new OAuthStateStore<TenantInstallState>(
		`${provider}:tenant-install:state`,
		`${provider}-tenant-install-state`,
	);
	registerTenantDataInstall({ connectorKey, provider, displayName: display, method });

	const notConfigured = (c: Context) =>
		c.html(
			renderOAuthErrorPage(
				`${provider}_not_configured`,
				`${display} installation is not available on this Lobu server. Ask the server administrator to configure the app.`,
				{ title: "Connection setup required", actionUrl: "/", actionLabel: "Return to Lobu" },
			),
			503,
		);
	const invalidTenant = (c: Context) =>
		c.html(
			renderOAuthErrorPage(
				"invalid_request",
				`That ${param} value is not a valid ${display} address.`,
			),
			400,
		);

	router.get(`/${provider}/install`, async (c) => {
		const creds = resolveAppInstallCredentials(method);
		if (!creds.clientId || !creds.clientSecret) return notConfigured(c);

		const tenant = (c.req.query(param) ?? "").trim();
		const userId = params.resolveInstallUserId(c);
		if (!userId) {
			// The claim binds to the installer, so they must be signed in first.
			const requestUrl = new URL(c.req.url);
			const gatewayBase = params.getPublicGatewayUrl?.();
			const basePath = gatewayBase
				? trimTrailingSlashes(new URL(gatewayBase).pathname)
				: requestUrl.pathname.slice(0, -`/${provider}/install`.length);
			const returnTo = `${basePath}/${provider}/install${requestUrl.search}`;
			const origin = trimTrailingSlashes(getConfiguredPublicOrigin() ?? "");
			return c.redirect(
				`${origin}/auth/login?${new URLSearchParams({ callbackUrl: returnTo })}`,
				302,
			);
		}

		if (!tenant) {
			const field = escapeHtml(param);
			return c.html(
				renderLobuPage({
					title: `Connect ${display}`,
					body: `<p>Enter the ${field} address to connect.</p>
<form method="get"><input name="${field}" required autofocus>
<button class="btn" type="submit">Continue</button></form>`,
				}),
			);
		}
		if (!tenantMatches(tenant)) return invalidTenant(c);

		const redirectUri = resolveOAuthInstallCallbackUrl(
			params.getPublicGatewayUrl?.(),
			c.req.url,
			provider,
		);
		const state = await stateStore.create({
			redirectUri,
			tenant,
			installerUserId: userId,
		});
		const target = new URL(renderTenantUrl(authorizeUrl, tenant));
		target.searchParams.set("client_id", creds.clientId);
		target.searchParams.set("scope", (method.permissions ?? []).join(","));
		target.searchParams.set("redirect_uri", redirectUri);
		target.searchParams.set("state", state);
		return c.redirect(target.toString(), 302);
	});

	router.get(`/${provider}/oauth_callback`, async (c) => {
		const code = c.req.query("code");
		const rawState = c.req.query("state");
		if (!code || !rawState) {
			return c.html(
				renderOAuthErrorPage(
					"invalid_request",
					`The ${display} callback is missing its code or state.`,
				),
				400,
			);
		}
		// One-time: a replayed or forged callback finds no state and writes nothing.
		const state = await stateStore.consume(rawState);
		if (!state) {
			return c.html(
				renderOAuthErrorPage(
					"invalid_state",
					`This ${display} install link is invalid or has expired.`,
				),
				400,
			);
		}
		if (c.req.query(param) !== state.tenant || !tenantMatches(state.tenant)) {
			return invalidTenant(c);
		}
		const creds = resolveAppInstallCredentials(method);
		if (!creds.clientId || !creds.clientSecret) return notConfigured(c);

		const result = await requestTenantInstallToken(
			fetchToken,
			renderTenantUrl(tokenUrl, state.tenant),
			{
				client_id: creds.clientId,
				client_secret: creds.clientSecret,
				code,
				expiring: "1",
			},
		).catch((error: unknown) => {
			logger.warn({ provider, error: String(error) }, "Tenant install code exchange failed");
			return { status: 502 };
		});
		if ("status" in result) {
			return c.html(
				renderOAuthErrorPage(
					`${provider}_install_failed`,
					`${display} did not accept the install (HTTP ${result.status}). Start the install again.`,
				),
				502,
			);
		}

		const externalRef = randomUUID();
		const sql = getDb();
		await sql.begin(async (tx) => {
			// One parked install per (tenant, installer): a re-run replaces it.
			await tx`
				DELETE FROM app_installations
				WHERE provider = ${provider}
					AND provider_instance = ${method.providerInstance ?? "cloud"}
					AND provider_app_id = ${creds.clientId as string}
					AND external_tenant_id = ${state.tenant}
					AND organization_id IS NULL
					AND status = 'pending'
					AND metadata->>'installer_user_id' = ${state.installerUserId}
			`;
			await tx`
				INSERT INTO app_installations (
					organization_id, provider, provider_instance, provider_app_id,
					external_tenant_id, status, metadata, updated_at
				) VALUES (
					NULL, ${provider}, ${method.providerInstance ?? "cloud"},
					${creds.clientId as string}, ${state.tenant}, 'pending',
					${tx.json({
						external_id: externalRef,
						installer_user_id: state.installerUserId,
						connector_key: connectorKey,
						tokens_enc: encrypt(JSON.stringify(result.grant)),
					})},
					now()
				)
			`;
		});

		const claimPath = `/connector/${encodeURIComponent(provider)}/connection?ref=${encodeURIComponent(externalRef)}`;
		const origin = trimTrailingSlashes(getConfiguredPublicOrigin() ?? "");
		return c.redirect(`${origin}${claimPath}`, 302);
	});
}
