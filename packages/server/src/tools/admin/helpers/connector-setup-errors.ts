import type {
	ConnectorAuthAppInstallation,
	ConnectorAuthOAuth,
} from "@lobu/connector-sdk";
import { buildSlackSelfInstallDeepLink } from "./slack-self-install";

export type ConnectorSetupError = {
	error: string;
	error_code: "connector_setup_required";
	connector_key: string;
	provider: string;
	provider_instance?: string;
	install_type: "app_installation" | "oauth_app_profile";
	next_action: "install_app" | "configure_oauth_app" | "open_setup";
	setup_url?: string;
	install_url?: string;
	self_install_url?: string;
	install_shape?: "oauth-code-exchange" | "github-app";
	setup_instructions?: string;
};

function hostedInstallPath(
	method: ConnectorAuthAppInstallation,
): string | undefined {
	const provider = encodeURIComponent(method.provider);
	if (method.installShape === "oauth-code-exchange")
		return `/${provider}/install`;
	if (method.installShape === "github-app") return `/${provider}/app/install`;
	return undefined;
}

function joinUrl(
	baseUrl: string | undefined,
	path: string | undefined,
): string | undefined {
	if (!baseUrl || !path) return undefined;
	return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export function buildAppInstallationSetupError(params: {
	connectorKey: string;
	method: ConnectorAuthAppInstallation;
	gatewayBaseUrl?: string;
	setupUrl?: string;
	/**
	 * Whether the connector also declares a BYO (`none`) auth method, i.e. it can
	 * be connected with a self-created app whose credentials are pasted in. Only
	 * then is the self-install deep link relevant.
	 */
	hasByoMethod?: boolean;
}): ConnectorSetupError {
	// The hosted "Add to <provider>" install needs the provider's OAuth client
	// env configured on the gateway. When it's absent (self-hosted gateways,
	// no hosted Lobu app), the hosted install URL is dead — suppress it and
	// lead with the self-install deep link instead.
	const hostedConfigured =
		!params.method.clientIdKey || !!process.env[params.method.clientIdKey];
	const installUrl = hostedConfigured
		? joinUrl(params.gatewayBaseUrl, hostedInstallPath(params.method))
		: undefined;

	// A malformed configured gateway URL must not turn setup guidance into a
	// tool failure (getGatewayBaseUrl passes raw unparsable values through) —
	// derive the MCP origin defensively and fall back to a deep link without it.
	let gatewayOrigin: string | undefined;
	if (params.gatewayBaseUrl) {
		try {
			gatewayOrigin = new URL(params.gatewayBaseUrl).origin;
		} catch {
			gatewayOrigin = undefined;
		}
	}

	const selfInstallUrl =
		params.hasByoMethod && params.method.provider === "slack"
			? buildSlackSelfInstallDeepLink({
					method: params.method,
					gatewayOrigin,
				})
			: undefined;

	let error: string;
	if (installUrl && params.method.provider === "slack") {
		error = params.setupUrl
			? `Connector '${params.connectorKey}' connects by installing its Slack app into your workspace. Open setup_url to start from this Lobu organization's connectors page. After the app is installed, a Slack workspace admin/owner must choose the destination Lobu organization on the confirmation page to finish connecting it.`
			: `Connector '${params.connectorKey}' connects by installing its Slack app into your workspace. Open install_url to install it. A Slack workspace admin/owner must then choose the destination Lobu organization on the confirmation page to finish connecting it.`;
	} else if (installUrl) {
		error = `Connector '${params.connectorKey}' connects by installing its ${params.method.provider} app. Open install_url to complete the installation. The provider callback creates the connection automatically when it succeeds.`;
	} else if (selfInstallUrl) {
		error = `Connector '${params.connectorKey}' has no hosted ${params.method.provider} app configured on this gateway. Create your own app from self_install_url, install it into your workspace, then retry connect with the app's bot token and signing secret.`;
	} else {
		error = `Connector '${params.connectorKey}' requires a ${params.method.provider} app installation. Open setup_url to configure the installation, then retry.`;
	}

	return {
		error,
		error_code: "connector_setup_required",
		connector_key: params.connectorKey,
		provider: params.method.provider,
		install_type: "app_installation",
		next_action: installUrl || selfInstallUrl ? "install_app" : "open_setup",
		...(params.method.providerInstance
			? { provider_instance: params.method.providerInstance }
			: {}),
		...(params.setupUrl ? { setup_url: params.setupUrl } : {}),
		...(installUrl ? { install_url: installUrl } : {}),
		...(selfInstallUrl ? { self_install_url: selfInstallUrl } : {}),
		...(params.method.installShape
			? { install_shape: params.method.installShape }
			: {}),
	};
}

export function buildOAuthAppProfileSetupError(params: {
	connectorKey: string;
	method: Pick<ConnectorAuthOAuth, "provider" | "setupInstructions">;
	setupUrl?: string;
}): ConnectorSetupError {
	let setupUrl: URL | undefined;
	try {
		setupUrl = params.setupUrl ? new URL(params.setupUrl) : undefined;
	} catch {
		// Invalid gateway configuration must not turn setup guidance into a crash.
	}
	if (setupUrl) {
		setupUrl.searchParams.set("setup", "oauth_app");
		setupUrl.hash = "connector-oauth-apps";
	}
	return {
		error: `An administrator must configure the OAuth app for '${params.method.provider}'. Open the exact setup_url, copy the callback URL into the provider's app settings, enter the client configuration in Lobu, and set the workspace default. Keep secrets in that browser form. Then resume the returned SDK call to connect the user's account.`,
		error_code: "connector_setup_required",
		connector_key: params.connectorKey,
		provider: params.method.provider,
		install_type: "oauth_app_profile",
		next_action: "configure_oauth_app",
		...(setupUrl ? { setup_url: setupUrl.toString() } : {}),
		...(params.method.setupInstructions
			? { setup_instructions: params.method.setupInstructions }
			: {}),
	};
}
