#!/usr/bin/env bun

import { OpenAPIHono } from "@hono/zod-openapi";
import { type AgentMetadata, createLogger } from "@lobu/core";
import { apiReference } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { isAllowedCorsOrigin } from "../../utils/cors-origin.js";
import { getConfiguredPublicOrigin } from "../../utils/public-origin.js";
import {
  pairAdminGrant,
  type PendingToolClaimant,
  takePendingTool,
} from "../auth/mcp/pending-tool-store.js";
import { setEnvResolver } from "../auth/mcp/string-substitution.js";
import { createAuthProfileLabel } from "../auth/settings/auth-profiles-manager.js";
import { SystemEnvStore } from "../auth/system-env-store.js";
import {
  type BundledIntegrationConnector,
  resolveAppInstallCredentials,
} from "../installation/app-install-credentials.js";
import { getMetricsText } from "../metrics/prometheus.js";
import { getModelProviderModules } from "../modules/module-system.js";
import { createAudioRoutes } from "../routes/internal/audio.js";
import { createConversationsRoutes } from "../routes/internal/conversations.js";
import { createFileRoutes } from "../routes/internal/files.js";
import { createImageRoutes } from "../routes/internal/images.js";
import { createInteractionRoutes } from "../routes/internal/interactions.js";
import { createRuntimeRoutes } from "../routes/internal/runtime.js";
import { registerAutoOpenApiRoutes } from "../routes/openapi-auto.js";
import {
  OPENAPI_DOC_PATH,
  OPENAPI_REFERENCE_PATH,
  gatewayMountPrefix,
  serverUrlForMountPrefix,
  withPathServers,
} from "./openapi-servers.js";
import {
  buildRoutePaths,
  mergeOpenApiPaths,
} from "../routes/shared/define-route.js";
import { createAgentApi } from "../routes/public/agent.js";
import { createAgentConfigRoutes } from "../routes/public/agent-config.js";
import { createAgentHistoryRoutes } from "../routes/public/agent-history.js";
import { completeSlackPendingInstall } from "../connections/slack-connection-coordinator.js";
import { createAgentRoutes } from "../routes/public/agents.js";
import {
  createInstallRoutes,
} from "../routes/public/app-install.js";
import {
  type AppWebhookProvider,
  createAppWebhookRoutes,
  createChatWebhookDelivery,
  createDataWebhookDelivery,
  createDeclaredAppWebhookProvider,
  createDefaultAppWebhookSecretResolver,
} from "../routes/public/app-webhooks.js";
import { createConnectAuthRoutes } from "../routes/public/connect-auth.js";
import {
  createConnectionCrudRoutes,
  createConnectionWebhookRoutes,
} from "../routes/public/connections.js";
import { createPublicFileRoutes } from "../routes/public/files.js";
import {
  resolveInstallOrgId,
  verifyInstallOrgAdminAccess,
  verifyInstallOrgAccess,
} from "../routes/public/install-org.js";
import { createLandingRoutes } from "../routes/public/landing.js";
import {
  type AuthProvider,
  setAuthProvider,
  verifySettingsSessionOrToken,
} from "../routes/public/settings-auth.js";

const logger = createLogger("gateway-startup");

/**
 * Provider → pending-install completion registry. The generic install engine's
 * chat callback dispatches through this map instead of a `provider === "slack"`
 * branch, so adding a new chat provider's claim completion is one map entry, not
 * a core-route edit. Unknown provider → no completion (the callback rejects).
 */
const chatPendingInstallCompletions: Record<
  string,
  (
    request: Request,
    redirectUri: string,
    credsOrgHint: string | null,
  ) => Promise<{ externalRef: string; subjectName: string | null } | null>
> = {
  slack: completeSlackPendingInstall,
};

interface CreateGatewayAppOptions {
  secretProxy: any;
  workerGateway: any;
  mcpProxy: any;
  interactionService?: any;
  platformRegistry?: any;
  coreServices?: any;
  chatInstanceManager?:
    | import("../connections/chat-instance-manager.js").ChatInstanceManager
    | null;
  /** Custom auth provider for embedded mode. When set, gateway delegates auth to this function instead of using cookie-based sessions. */
  authProvider?: AuthProvider;
  /**
   * Bundled connectors that receive app-level webhook deliveries
   * (`delivery: 'app_installation'`), discovered + primed at boot. The gateway
   * registers ONE generic app-webhook provider per entry — no hardcoded
   * provider list. Empty/undefined → no app-webhook providers registered.
   */
  bundledIntegrationConnectors?: BundledIntegrationConnector[];
}

/**
 * Create the Hono app with all gateway routes.
 * Returns the app without starting an HTTP server — the caller mounts it on its
 * own server (embedded mode; see `src/server.ts` / `src/lobu/gateway.ts`).
 */
export function createGatewayApp(
	options: CreateGatewayAppOptions,
): OpenAPIHono {
  const {
    secretProxy,
    workerGateway,
    mcpProxy,
    interactionService,
    platformRegistry,
    coreServices,
    chatInstanceManager,
    authProvider,
    bundledIntegrationConnectors,
  } = options;

  if (authProvider) {
    setAuthProvider(authProvider);
  }

  const app = new OpenAPIHono();

  app.use(
    "*",
    secureHeaders({
      xFrameOptions: false,
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'self'", "*"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
      },
		}),
  );
  app.use(
    "*",
    cors({
      // Same browser-origin boundary as the main app (packages/server/src/index.ts)
      // so a workspace host like `acme.lobu.ai` can call the Agent API mounted at
      // /lobu, plus the operator's exact ALLOWED_ORIGINS for standalone clients.
      // Reads process.env, not c.env: standalone `lobu run` has no env-injecting
      // wrapper, so c.env only carries the Node adapter's fields there.
      origin: (origin, c) => {
        if (!origin) {
          return getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
        }
        return isAllowedCorsOrigin(origin, process.env, c.req.url, {
          allowConfiguredOrigins: true,
        })
          ? origin
          : undefined;
      },
      credentials: true,
		}),
  );

  app.get("/health", (c) => {
    const mode = process.env.LOBU_MODE || "cloud";

    return c.json({
      status: "ok",
      mode,
      version: process.env.npm_package_version || "2.3.0",
      timestamp: new Date().toISOString(),
      publicGatewayUrl:
        coreServices?.getPublicGatewayUrl?.() || process.env.PUBLIC_GATEWAY_URL,
      capabilities: {
        agents: ["claude"],
        streaming: true,
        toolApproval: true,
      },
      wsUrl: `ws://localhost:${process.env.PORT || process.env.GATEWAY_PORT || "8787"}/ws`,
      secretProxy: !!secretProxy,
    });
  });

  app.get("/ready", (c) => c.json({ ready: true }));

  // Metrics auth is optional so existing ServiceMonitor configs continue to scrape.
  app.get("/metrics", async (c) => {
    const metricsAuthToken = process.env.METRICS_AUTH_TOKEN;
    if (metricsAuthToken) {
      const authHeader = c.req.header("Authorization");
      if (authHeader !== `Bearer ${metricsAuthToken}`) {
        return c.text("Unauthorized", 401);
      }
    }
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.text(getMetricsText());
  });

  if (secretProxy) {
    app.route("/api/proxy", secretProxy.getApp());
    logger.debug("Secret proxy enabled at :8080/api/proxy");
  }

  if (coreServices) {
    const bedrockOpenAIService = coreServices.getBedrockOpenAIService?.();
    if (bedrockOpenAIService) {
      app.route("/api/bedrock", bedrockOpenAIService.getApp());
      logger.debug("Bedrock routes enabled at :8080/api/bedrock/*");
    }
  }

  if (workerGateway) {
    app.route("/worker", workerGateway.getApp());
    logger.debug("Worker gateway routes enabled at :8080/worker/*");
  }

  if (mcpProxy) {
    app.all("/", async (c, next) => {
      if (mcpProxy.isMcpRequest(c)) {
        return mcpProxy.getApp().fetch(c.req.raw);
      }
      return next();
    });
    app.route("/mcp", mcpProxy.getApp());
    logger.debug("MCP proxy routes enabled at :8080/mcp/*");
  }

  if (platformRegistry && coreServices) {
    const artifactStore = coreServices.getArtifactStore();
    const fileRouter = createFileRoutes(
      platformRegistry,
      artifactStore,
			coreServices.getPublicGatewayUrl(),
    );
    app.route("/internal/files", fileRouter);

    app.route("", createPublicFileRoutes(artifactStore));
    logger.debug(
			"File routes enabled at :8080/internal/files/* and /api/v1/files/*",
    );
  }


  {
    const conversationsRouter = createConversationsRoutes();
    app.route("/internal", conversationsRouter);
    logger.debug(
      "Conversation routes enabled at :8080/internal/conversations/*"
    );

    app.route("", createRuntimeRoutes());
    logger.debug("Runtime provider routes enabled");
  }

  if (coreServices) {
    const transcriptionService = coreServices.getTranscriptionService();
    if (transcriptionService) {
      const audioRouter = createAudioRoutes(transcriptionService);
      app.route("", audioRouter);
      logger.debug("Audio routes enabled at :8080/internal/audio/*");
    }
  }

  if (coreServices) {
    const imageGenerationService = coreServices.getImageGenerationService();
    if (imageGenerationService) {
      const imageRouter = createImageRoutes(imageGenerationService);
      app.route("", imageRouter);
      logger.debug("Image routes enabled at :8080/internal/images/*");
    }
  }

  if (interactionService) {
    const internalRouter = createInteractionRoutes(interactionService);
    app.route("", internalRouter);
    logger.debug("Internal interaction routes enabled");
  }

  if (coreServices) {
    const queueProducer = coreServices.getQueueProducer();
    const sessionMgr = coreServices.getSessionManager();
    const interactionSvc = coreServices.getInteractionService();
    const publicUrl = coreServices.getPublicGatewayUrl();

    if (queueProducer && sessionMgr && interactionSvc) {
      const approveGrantStore = coreServices.getGrantStore();
      const approveMcpProxy = coreServices.getMcpProxy();

      const agentApi = createAgentApi({
        queueProducer,
        sessionManager: sessionMgr,
        sseManager: coreServices.getSseManager(),
        publicGatewayUrl: publicUrl,
        artifactStore: coreServices.getArtifactStore(),
        externalAuthClient: coreServices.getExternalAuthClient(),
        agentSettingsStore: coreServices.getAgentSettingsStore(),
        agentConfigStore: coreServices.getConfigStore(),
        userAgentsStore: coreServices.getUserAgentsStore(),
        agentMetadataStore: coreServices.getAgentMetadataStore(),
        platformRegistry,
        approveToolCall: async (
          requestId: string,
          decision: string,
          claimant: PendingToolClaimant,
        ) => {
          const expiresMap = {
            "1h": Date.now() + 3_600_000,
            "24h": Date.now() + 86_400_000,
            always: null,
          } satisfies Record<string, number | null>;
          const isGrantDecision = (
            value: string,
          ): value is keyof typeof expiresMap => value in expiresMap;
          if (decision !== "deny" && !isGrantDecision(decision)) {
            return { success: false, error: "Invalid decision" };
          }

          // DELETE ... RETURNING atomically claims the pending invocation
          // so a retry of POST /api/v1/agents/approve (CLI re-tries,
          // double-clicks, Slack webhook retries) cannot double-execute the
          // tool. The Slack/Telegram interaction-bridge path uses the same
          // helper.
          const pending = await takePendingTool(requestId, claimant);
          if (!pending)
            return { success: false, error: "Request not found or expired" };
          if (!pending.organizationId) {
            return {
              success: false,
              error: "Tool approval missing organization context",
            };
          }
          const pattern = `/mcp/${pending.mcpId}/tools/${pending.toolName}`;
          if (decision === "deny") {
            await approveGrantStore?.grant(
              pending.agentId,
              pattern,
              null,
              true,
            );
            return { success: true };
          }
          await approveGrantStore?.grant(
            pending.agentId,
            pattern,
            expiresMap[decision],
          );
          if (approveMcpProxy) {
            const result = await approveMcpProxy.executeToolDirect(
              pending.agentId,
              pending.userId,
              pending.mcpId,
              pending.toolName,
              pending.args,
              {
                organizationId: pending.organizationId,
                conversationId: pending.conversationId,
                channelId: pending.channelId,
                teamId: pending.teamId,
                connectionId: pending.connectionId,
                platform: pending.platform,
                source: pending.source,
                ...pairAdminGrant(pending.adminTools, pending.adminActorUserId),
                deploymentName: pending.deploymentName,
              },
            );
            return { success: true, result } as any;
          }
          return { success: true };
        },
      });
      app.route("", agentApi);
      logger.debug(
				"Agent API enabled at :8080/api/v1/agents/* with docs at :8080/api/docs",
      );
    }
  }

  if (coreServices) {
    const authRouter = new OpenAPIHono();
    const registeredProviders: string[] = [];

    {
      const connectAuthRouter = createConnectAuthRoutes({
        externalAuthClient: coreServices.getExternalAuthClient(),
      });
      app.route("", connectAuthRouter);
    }

    const providerModules = getModelProviderModules();

    const authProfilesManager = coreServices.getAuthProfilesManager();
    if (authProfilesManager) {
      const agentMetadataStore = coreServices.getAgentMetadataStore();
      const userAgentsStore = coreServices.getUserAgentsStore();

      const verifyProviderAuth = async (
        c: any,
				agentId: string,
      ): Promise<{ userId: string; platform: string } | null> => {
        const payload = await verifySettingsSessionOrToken(c);
        if (!payload) return null;
        const principal = {
          userId: payload.userId,
          platform: payload.platform,
        };
        if (payload.isAdmin) return principal;

        if (payload.agentId)
          return payload.agentId === agentId ? principal : null;

        if (userAgentsStore) {
          const owns = await userAgentsStore.ownsAgent(
            payload.platform,
            payload.userId,
						agentId,
          );
          if (owns) return principal;
        }

        if (agentMetadataStore) {
          const metadata = await agentMetadataStore.getMetadata(agentId);
          const isOwner =
            metadata?.owner?.platform === payload.platform &&
            metadata?.owner?.userId === payload.userId;
          if (isOwner) {
            userAgentsStore
              ?.addAgent(payload.platform, payload.userId, agentId)
              .catch(() => {
                /* best-effort reconciliation */
              });
            return principal;
          }
        }

        return null;
      };

      // Each provider-auth handler does the same envelope work: resolve the
      // `:provider` module (404 if unknown), then a try/catch that logs and
      // returns a 500 with `errorLabel`. Factor that out so the bodies are
      // just the per-route logic.
      const withProviderAndAuth =
        (
          errorLabel: string,
          handler: (args: {
            c: any;
            mod: ReturnType<typeof getModelProviderModules>[number];
            providerId: string;
					}) => Promise<Response>,
        ) =>
        async (c: any): Promise<Response> => {
          try {
            const providerId = c.req.param("provider");
            const mod = getModelProviderModules().find(
							(m) => m.providerId === providerId,
            );
            if (!mod) return c.json({ error: "Unknown provider" }, 404);
            return await handler({ c, mod, providerId });
          } catch (error) {
            logger.error(errorLabel, { error });
            return c.json({ error: errorLabel }, 500);
          }
        };

      authRouter.post(
        "/:provider/save-key",
        withProviderAndAuth(
          "Failed to save API key",
          async ({ c, mod, providerId }) => {
            const body = await c.req.json().catch(() => null);
            if (!body || typeof body !== "object") {
              return c.json({ error: "Invalid JSON body" }, 400);
            }
            const { agentId, apiKey } = body as {
              agentId?: string;
              apiKey?: string;
            };
            if (!agentId || !apiKey) {
              return c.json({ error: "Missing agentId or apiKey" }, 400);
            }

            const principal = await verifyProviderAuth(c, agentId);
            if (!principal) {
              return c.json({ error: "Unauthorized" }, 401);
            }

            await authProfilesManager.upsertProfile({
              agentId,
              userId: principal.userId,
              provider: providerId,
              credential: apiKey,
              authType: "api-key",
              label: createAuthProfileLabel(mod.providerDisplayName, apiKey),
              makePrimary: true,
            });

            return c.json({ success: true });
					},
				),
      );

      authRouter.post(
        "/:provider/logout",
				withProviderAndAuth("Failed to logout", async ({ c, providerId }) => {
            const body = await c.req.json().catch(() => ({}));
            const agentId = body.agentId || c.req.query("agentId");
            if (!agentId) {
              return c.json({ error: "Missing agentId" }, 400);
            }

            const principal = await verifyProviderAuth(c, agentId);
            if (!principal) {
              return c.json({ error: "Unauthorized" }, 401);
            }

            await authProfilesManager.deleteProviderProfiles(
              agentId,
              providerId,
              {
                userId: principal.userId,
                ...(body.profileId ? { profileId: body.profileId } : {}),
						},
            );

            return c.json({ success: true });
				}),
      );
    }

    const agentSettingsStore = coreServices.getAgentSettingsStore();

    const providerStores: Record<
      string,
      { hasCredentials(agentId: string): Promise<boolean> }
    > = {};
    const providerConnectedOverrides: Record<string, boolean> = {};
    for (const mod of providerModules) {
      providerStores[mod.providerId] = mod;
      providerConnectedOverrides[mod.providerId] = mod.hasSystemKey();
      if (mod.getApp) {
        authRouter.route(`/${mod.providerId}`, mod.getApp());
        registeredProviders.push(mod.providerId);
      }
    }

    const providerRegistryService = coreServices.getProviderRegistryService();

    if (providerRegistryService) {
      const systemEnvStore = new SystemEnvStore(coreServices.getSecretStore());
      systemEnvStore.refreshCache().catch((e: any) => {
        logger.error("Failed to refresh system env cache", { error: e });
      });
      setEnvResolver((key: string) => systemEnvStore.resolve(key));
    }

    {
      const landingRouter = createLandingRoutes();
      app.route("", landingRouter);
      logger.debug("Landing page enabled at :8080/");
    }

    {
      const agentHistoryRouter = createAgentHistoryRoutes({
        agentConfigStore: coreServices.getConfigStore(),
        userAgentsStore: coreServices.getUserAgentsStore(),
        artifactStore: coreServices.getArtifactStore(),
        publicGatewayUrl: coreServices.getPublicGatewayUrl(),
      });
      app.route("/api/v1/agents/:agentId/history", agentHistoryRouter);
      logger.debug(
        "Agent history routes enabled at :8080/api/v1/agents/{agentId}/history/*",
      );
    }

    if (agentSettingsStore) {
      const agentConfigRouter = createAgentConfigRoutes({
        agentSettingsStore,
        agentConfigStore: coreServices.getConfigStore()!,
        userAgentsStore: coreServices.getUserAgentsStore(),
        queue: coreServices.getQueue(),
        providerStores:
          Object.keys(providerStores).length > 0 ? providerStores : undefined,
        providerConnectedOverrides,
        providerCatalogService: coreServices.getProviderCatalogService(),
        authProfilesManager: coreServices.getAuthProfilesManager(),
        grantStore: coreServices.getGrantStore(),
      });
      app.route("/api/v1/agents/:agentId/config", agentConfigRouter);
      logger.debug(
				"Agent config routes enabled at :8080/api/v1/agents/{id}/config",
      );
    }

    if (registeredProviders.length > 0) {
      app.route("/api/v1/auth", authRouter);
      logger.debug(
				`Auth routes enabled at :8080/api/v1/auth/* for: ${registeredProviders.join(", ")}`,
      );
    }

    // Agent routes still use the Automation-backed channel projection for recall
    // and channel-feed materialization. Subscription configuration itself is
    // owned by manage_automations.
    {
      const userAgentsStore = coreServices.getUserAgentsStore();
      const agentMetadataStore = coreServices.getAgentMetadataStore();
      const agentManagementRouter = createAgentRoutes({
        userAgentsStore,
        agentMetadataStore,
        agentSettingsStore,
      });
      app.route("/api/v1/agents", agentManagementRouter);
      logger.debug("Agent management routes enabled at :8080/api/v1/agents/*");
    }
  }

  if (chatInstanceManager) {
    app.route("", createConnectionWebhookRoutes(chatInstanceManager));

    // Shared multi-tenant app-webhook router (app-installation design §4.3): one
    // public endpoint per provider for an installed Lobu App. DATA-DRIVEN: we
    // iterate the bundled integration connectors discovered + primed at boot
    // (those declaring `webhook.delivery: 'app_installation'`) and register ONE
    // GENERIC provider per declaration — verify + tenant + registration carry no
    // provider name. The only per-KIND piece is the delivery hook (github's
    // poll-canonical trigger/store, slack's chat-adapter forward), keyed off the
    // connector, not branched on a provider literal in the engine. A provider is
    // registered only when its Lobu App id is configured (the declared env var is
    // set); otherwise the route reports the provider unknown (404).
    const appWebhookSecretStore = coreServices.getSecretStore();
    const appWebhookProviders: AppWebhookProvider[] = [];
    const declaredSecretEnvKeys: Record<string, string | undefined> = {};
    for (const integration of bundledIntegrationConnectors ?? []) {
      // Reference resolveAppInstallCredentials so the declared env-var contract
      // stays the single source of truth (validates the method's key names).
      if (integration.method) resolveAppInstallCredentials(integration.method);
      if (!integration.appId) continue;
      declaredSecretEnvKeys[integration.provider] = integration.webhookSecretKey;

      // Per-KIND delivery, dispatched off the DECLARED `deliveryKind` — never a
      // provider name. A `chat` connector forwards verified deliveries to the
      // chat adapter for its provider (Slack today); a `data` connector lands
      // them through the data path: its per-connector delivery hook when it
      // ships one (GitHub sync-now triggers, Jira → Rovo issue events), else the
      // raw event-ingest fallback (Linear, and Jira until a Rovo feed exists).
      // Both the chat-forward routing and the data hooks live outside this
      // wiring, keyed off the connector, so gateway core carries no provider
      // literal.
      const deliveryKind = integration.webhookSchema.deliveryKind ?? "data";
      const deliveryHooks: Pick<
        AppWebhookProvider,
        "onDelivery" | "handleDelivery"
      > = {};
      if (deliveryKind === "chat") {
        const provider = integration.provider;
        deliveryHooks.handleDelivery = createChatWebhookDelivery({
          handleChatAppWebhook: (req) =>
            chatInstanceManager.handleChatAppWebhook(provider, req),
        });
      } else {
        const onDelivery = createDataWebhookDelivery(integration.connectorKey);
        if (onDelivery) deliveryHooks.onDelivery = onDelivery;
      }

      appWebhookProviders.push(
        createDeclaredAppWebhookProvider({
          provider: integration.provider,
          appId: integration.appId,
          webhookSchema: integration.webhookSchema,
          providerInstance: integration.method?.providerInstance,
          ...deliveryHooks,
        }),
      );
    }
    app.route(
      "",
      createAppWebhookRoutes({
        installationStore: createPostgresAppInstallationStore(),
        secretStore: appWebhookSecretStore,
        providers: appWebhookProviders,
        resolveAppWebhookSecret: createDefaultAppWebhookSecretResolver(
          appWebhookSecretStore,
          declaredSecretEnvKeys,
        ),
      }),
    );

    // Hosted-app install router (app-installation design §4.4). DATA-DRIVEN: one
    // generic engine iterates the SAME bundled integration connectors and mounts
    // a start + callback per connector, dispatching the handshake on the declared
    // `installShape` — github-app (GitHub App: installation ids + ownership
    // verification + provisioning) vs oauth-code-exchange ("Add to <app>" OAuth,
    // e.g. Slack at /slack/install + /slack/oauth_callback). No per-provider
    // install router wiring, no "github"/"slack" branch: adding a new hosted
    // OAuth app is a connector declaration, not new core route code. The chat
    // completion is provider-dispatched (mirrors handleChatAppWebhook).
    app.route(
      "",
      createInstallRoutes({
        installationStore: createPostgresAppInstallationStore(),
        resolveInstallOrgId,
        verifyInstallOrgAccess,
        verifyInstallOrgAdminAccess,
        getPublicGatewayUrl: () => coreServices.getPublicGatewayUrl(),
        integrations: (bundledIntegrationConnectors ?? []).map((integration) => ({
          connectorKey: integration.connectorKey,
          provider: integration.provider,
          method: integration.method,
          deliveryKind: integration.webhookSchema.deliveryKind ?? "data",
        })),
        // EVERY oauth-code-exchange chat install (marketplace "Add to Slack" AND
        // logged-in installs) parks as pending, unclaimed — the claim flow's org
        // picker owns which tenant it binds to. `orgId` is the peeked state's org,
        // passed ONLY as a BYO per-org creds hint for the code exchange (self-host);
        // it never binds. Dispatched through the provider completion registry —
        // an unknown provider has no completion, so the callback rejects.
        completeChatPendingInstall: (provider, req, redirectUri, orgId) =>
          chatPendingInstallCompletions[provider]?.(req, redirectUri, orgId) ??
          Promise.resolve(null),
      }),
    );
    app.route("", createConnectionCrudRoutes(chatInstanceManager));
    logger.debug(
			"Slack and connection webhook routes enabled at :8080/slack/* and :8080/api/v1/webhooks/*",
    );
  }

  async function hasDevRouteAccess(c: any): Promise<boolean> {
    if (await verifySettingsSessionOrToken(c)) return true;
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return false;
    const token = authHeader.slice(7);
    const externalAuthClient = coreServices?.getExternalAuthClient?.();
    if (!externalAuthClient) return false;
    try {
      const userInfo = await externalAuthClient.fetchUserInfo(token);
      return Boolean(userInfo?.sub);
    } catch {
      return false;
    }
  }

  app.get("/internal/status", async (c) => {
    if (process.env.NODE_ENV === "production") {
      return c.json({ error: "Not found" }, 404);
    }
    if (!(await hasDevRouteAccess(c))) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const agentConfigStore = coreServices?.getConfigStore();

    const allAgents: AgentMetadata[] = agentConfigStore
      ? await agentConfigStore.listAgents()
      : [];

    const connections = chatInstanceManager
      ? await chatInstanceManager.listConnections()
      : [];

    const agentDetails = [];
    for (const a of allAgents) {
      // This debug endpoint lists agents across ALL orgs, so there is no
      // ambient orgContext. A shared agent id (e.g. "lobu-builder") exists once
      // per org, so scope each read to the row's own org — otherwise the
      // unscoped read returns an arbitrary org's model/providers and mislabels
      // the row. The raw store reads the ambient org, so install it per agent.
      const settings =
        agentConfigStore && a.organizationId
          ? await orgContext.run({ organizationId: a.organizationId }, () =>
              agentConfigStore.getSettings(a.agentId),
            )
          : null;
      const providers: string[] = [];
      for (const ref of settings?.models || []) {
        const slash = ref.indexOf("/");
        if (slash > 0 && !providers.includes(ref.slice(0, slash))) {
          providers.push(ref.slice(0, slash));
        }
      }
      agentDetails.push({
        agentId: a.agentId,
        name: a.name,
        providers,
        model: settings?.models?.[0] ?? null,
      });
    }

    return c.json({
      agents: agentDetails,
      connections: connections.map(
        (conn: {
          id: string;
          platform: string;
          agentId?: string;
          metadata?: Record<string, string>;
        }) => ({
          id: conn.id,
          platform: conn.platform,
          status: chatInstanceManager?.getInstance(conn.id)
            ? "connected"
            : "disconnected",
          agentId: conn.agentId || null,
          botUsername: conn.metadata?.botUsername || null,
				}),
      ),
    });
  });

  registerAutoOpenApiRoutes(app);

  const openApiDocConfig = {
    openapi: "3.1.0",
    info: {
      title: "Lobu API",
      version: "1.0.0",
      description: `
## Overview

The Lobu API allows you to create and interact with AI agents programmatically.

## Base URLs

This document describes two surfaces with two different bases, both relative to
wherever you fetched this document:

- The Agent API (\`/api/v1/…\`, \`/connect/claim\`) is served from the base in each
  operation's own \`servers\` entry — \`/lobu\` on the embedded server every Lobu
  deployment runs, the origin on a standalone \`lobu\` gateway.
- The org-scoped dispatch API (\`POST /api/{orgSlug}/{tool}\`) is served from the
  document-level \`servers\` entry: the origin, in both topologies.

Requesting an Agent API path at the origin of an embedded deployment does NOT
reach it — \`/api/v1/agents\` is parsed as workspace \`v1\` and answers
\`Organization 'v1' not found\`.

## Authentication

1. Authenticate the agent-creation request with a settings session or CLI access token
2. Create an agent with \`POST /api/v1/agents\` to get a worker token
3. Use the returned worker token as a Bearer token for subsequent agent requests

## Quick Start

\`\`\`bash
# The Agent API base — the \`servers\` entry on the operations below, resolved
# against this document's URL. \`lobu run\` serves it here by default:
export LOBU_API_BASE="http://localhost:8787/lobu"

# 1. Create an agent (authenticate with a CLI token)
curl -X POST "$LOBU_API_BASE/api/v1/agents" \\
  -H "Authorization: Bearer $LOBU_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "claude"}'

# 2. Send a message (use worker token from step 1)
curl -X POST "$LOBU_API_BASE/api/v1/agents/{agentId}/messages" \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "Hello!"}'
\`\`\`
      `,
    },
    tags: [
      {
        name: "Agents",
        description: "Create, list, update, and delete agents.",
      },
      {
        name: "Messages",
        description:
          "Send messages to agents and subscribe to real-time events (SSE).",
      },
      {
        name: "Configuration",
        description:
          "Agent configuration — LLM providers, Nix packages, domain grants.",
      },
      {
        name: "Channels",
        description:
          "Bind agents to messaging platform channels (Slack, Telegram, WhatsApp).",
      },
      {
        name: "Connections",
        description:
          "Manage Chat SDK-backed platform connections and their lifecycle.",
      },
      {
        name: "Schedules",
        description: "Scheduled wakeups and recurring reminders.",
      },
      {
        name: "History",
        description: "Session messages, stats, and connection status.",
      },
      {
        name: "Auth",
        description:
          "Provider authentication — API keys, OAuth, device code flows.",
      },
      {
        name: "Integrations",
        description: "Browse and install skills and MCP servers.",
      },
    ],
    // `servers` is deliberately absent here: this app answers the Agent API
    // from two bases (the origin when standalone, `/lobu` when embedded), so
    // the handler below fills both in per request. See openapi-servers.ts.
  };

  const ORIGIN_SERVER_DESCRIPTION =
    "This deployment's origin — serves the org-scoped dispatch API (POST /api/{orgSlug}/{tool}).";
  const AGENT_API_SERVER_DESCRIPTION =
    "This deployment's Agent API mount — the origin standalone, /lobu when embedded in the server.";

  // One merged OpenAPI document: the defineRoute registry (agent-session
  // orchestration, TypeBox), the openapi-auto walk of the remaining gateway
  // routes (`getOpenAPI31Document`), PLUS the full dispatch-tool surface
  // (`POST /api/{orgSlug}/{tool}` — entities, automations, feeds, metrics, …),
  // all sourced from the same TypeBox schemas the server validates against.
  // The first-party `@lobu/client` is generated from THIS single document, so
  // the CLI and UI get a typed client for BOTH surfaces instead of only agent
  // sessions.
  app.get(OPENAPI_DOC_PATH, async (c) => {
    // Dynamic import (rationale): a static `gateway → openapi-generator →
    // registry` edge closes a circular-init cycle with the tool registry's admin
    // deps, throwing a TDZ error during module load under some import orders.
    // This docs endpoint is cold and low-traffic, and by request time every
    // module is already loaded, so `import()` resolves from cache with no
    // measurable cost — while keeping the cycle out of the static graph.
    const { generateStrictToolPaths } = await import(
      "../../utils/openapi-generator.js"
    );
    // The Agent API base is read off THIS request, so the document is correct
    // whichever way the app is mounted and carries no hostname of its own. The
    // dispatch half is the origin in both topologies, hence a constant `/`.
    const agentApiServer = serverUrlForMountPrefix(
      gatewayMountPrefix(c.req.path, OPENAPI_DOC_PATH),
    );
    const base = app.getOpenAPI31Document({
      ...openApiDocConfig,
      servers: [{ url: "/", description: ORIGIN_SERVER_DESCRIPTION }],
    });
    const toolPaths = generateStrictToolPaths();
    // `defineRoute` routes (agent-session + config) carry richer TypeBox
    // request/response schemas than openapi-auto's generic stubs; they win —
    // but only per METHOD: a whole-path spread would drop sibling operations
    // (openapi-auto's GET /api/v1/agents, PATCH /api/v1/agents/{agentId}).
    const routePaths = buildRoutePaths();
    return c.json({
      ...base,
      // The dispatch-tool half lives in the main app at the origin and inherits
      // the document-level server; everything this app serves itself is under
      // the gateway mount and says so per path.
      paths: mergeOpenApiPaths(
        toolPaths,
        withPathServers(
          base.paths ?? {},
          agentApiServer,
          AGENT_API_SERVER_DESCRIPTION,
        ),
        withPathServers(
          routePaths,
          agentApiServer,
          AGENT_API_SERVER_DESCRIPTION,
        ),
      ),
    });
  });

  // The reference page fetches the document from the BROWSER, so its url has to
  // carry the mount prefix too — a bare `/api/docs/openapi.json` 404s on the
  // embedded server. Built per request (a cold docs page) for the same reason
  // the document's own servers are.
  app.get(OPENAPI_REFERENCE_PATH, (c, next) =>
    apiReference({
      url: `${gatewayMountPrefix(c.req.path, OPENAPI_REFERENCE_PATH)}${OPENAPI_DOC_PATH}`,
      theme: "kepler",
      layout: "modern",
      defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
    })(c, next),
  );
  logger.debug("API docs enabled at /api/docs");

  return app;
}
