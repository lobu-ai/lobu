import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  assertRunHistoryLayout,
  runAutomationNavigationProof,
} from "./automation-navigation-ui-proof.mjs";

// Called only by the existing opt-in preview proof, through its loopback
// port-forward and local synthetic session. No tenant fixture or credentials.
export async function runNativeReferenceProof({
  page,
  browserPost,
  baseUrl,
  outputDir,
  assert,
}) {
  assert(
    new URL(baseUrl).hostname === "127.0.0.1",
    "Native report seeding requires the preview's loopback port-forward"
  );
  await page.goto(new URL("/api/health", baseUrl).toString());
  // A proof rerun must not reset or overwrite a previous reviewer's saved edits.
  // Keep each fixture private and publish its actual paths in results.json.
  // The preview namespace (including its PVC) is removed when the PR closes.
  const workspace = `native-ui-proof-${randomUUID().slice(0, 8)}`;
  const organization = await browserPost(
    page,
    "/api/auth/organization/create",
    {
      name: "Synthetic native component review",
      slug: workspace,
    }
  );
  assert(organization?.id, "Synthetic workspace was not created");
  const membershipResponse = await page.request.get(
    new URL("/api/organizations", baseUrl).toString()
  );
  const memberships = await membershipResponse.json();
  assert(
    membershipResponse.ok() &&
      memberships.organizations?.some(
        (item) => item.id === organization.id && item.visibility === "private"
      ),
    "Synthetic workspace must remain private"
  );
  const call = (tool, input) =>
    browserPost(page, `/api/${workspace}/${tool}`, input);

  const agentName = "Synthetic preview agent";
  const agent = await call("manage_agents", {
    action: "create",
    agent_id: "native-preview-agent",
    name: agentName,
    description:
      "Synthetic identity only; no channel or task is configured or executed.",
  });
  assert(
    agent.created === true,
    "Synthetic agent must apply, not await approval"
  );
  const automationName = "Synthetic manual Automation";
  const automationInstructions = [
    "Preview exercise: review a synthetic weekly delivery summary.",
    "1. Read the sample changes and explain what changed in plain language.",
    "2. Group completed work, open questions, and next steps into short sections.",
    "3. Keep every example fictional. Do not contact anyone, connect an account, or run an action.",
    "This definition is for editing and navigation review only: no triggers, executor, or run is configured.",
  ].join("\n\n");
  const automation = await call("manage_automations", {
    action: "create",
    slug: "native-preview-manual",
    name: automationName,
    prompt: automationInstructions,
    description: "Synthetic description to clear in the editor.",
    tags: ["synthetic-preview"],
    reactions_guidance:
      "Synthetic guidance to clear; never execute this fixture.",
    triggers: [],
  });
  assert(
    automation.automation_id,
    "Synthetic manual Automation was not created"
  );
  // No trigger, schedule, executor, external source, reaction or run invocation is added.
  const catalog = await call("manage_catalog", {
    action: "list_installed",
    kinds: ["connectors"],
    include_catalog: true,
  });
  const connector = catalog.installed?.connectors?.items?.find(
    (item) => item.id === "rss" && typeof item.name === "string"
  );
  assert(connector, "Preview has no built-in credential-free RSS connector");
  // RSS has auth type none and no implicit feeds. This creates only a private,
  // credential-free identity, then pauses it. No feed URL, auth or test action.
  const createdConnection = await call("manage_connections", {
    action: "create",
    connector_key: connector.id,
    display_name: "Synthetic dormant RSS connection",
    slug: "synthetic-dormant-rss",
    auth_profile_slug: null,
    app_auth_profile_slug: null,
    config: {},
    device_worker_id: null,
  });
  const connectionId = Number(createdConnection.connection?.id);
  assert(
    Number.isSafeInteger(connectionId) && connectionId > 0,
    "Dormant synthetic connection was not created"
  );
  const paused = await call("manage_connections", {
    action: "update",
    connection_id: connectionId,
    status: "paused",
  });
  assert(
    !paused.error &&
      !paused.approval_queued &&
      paused.status !== "pending_approval",
    "Synthetic connection pause did not apply"
  );
  const connectionReadback = await call("manage_connections", {
    action: "get",
    connection_id: connectionId,
  });
  const savedConnection = connectionReadback.connection;
  assert(
    savedConnection?.status === "paused" &&
      !savedConnection.auth_profile_id &&
      !savedConnection.app_auth_profile_id &&
      !savedConnection.device_worker_id,
    "Synthetic connection has credentials, a worker, or is not paused"
  );
  const feeds = await call("manage_feeds", {
    action: "list_feeds",
    connection_id: connectionId,
  });
  const connectionRuns = await call("manage_operations", {
    action: "list_runs",
    connection_ids: [connectionId],
    limit: 30,
  });
  assert(
    Array.isArray(feeds.feeds) &&
      feeds.feeds.length === 0 &&
      Number(feeds.total) === 0,
    "Synthetic connection unexpectedly has a feed"
  );
  assert(
    Array.isArray(connectionRuns.runs) && connectionRuns.runs.length === 0,
    "Synthetic connection unexpectedly has a run"
  );

  const text = (content) => ({ type: "text", content });
  const node = (type, props, children) => ({
    type,
    props,
    ...(children && { children }),
  });
  const live = { mode: "live", workspace: "{{workspace}}" };
  const views = [
    ["current", "Current definitions"],
    ["changes", "Changes"],
    ["proposal", "Proposal"],
    ["unavailable", "Unavailable"],
  ];
  const root = node("div", { className: "space-y-5" }, [
    node("p", {}, [
      text("Synthetic native component report — no production data"),
    ]),
    node("p", {}, [
      text(
        "Saved native event. Definition fixtures, dormant Agent and catalog metadata; no external account is connected or operation executed."
      ),
    ]),
    node("tabs", { defaultValue: "current" }, [
      node(
        "tabs-list",
        { label: "Native report views" },
        views.map(([value, label]) =>
          node("tabs-trigger", { value }, [text(label)])
        )
      ),
      node("tabs-content", { value: "current" }, [
        node("automation-ref", { ...live, automationId: "{{automationId}}" }),
        node("agent-ref", { ...live, agentId: "{{agentId}}" }),
        node("connector-ref", { ...live, connectorKey: "{{connectorKey}}" }),
      ]),
      node("tabs-content", { value: "changes" }, [
        text("Read-only example changes; these do not update the Automation."),
        node("json-diff", { before: "{{before}}", after: "{{after}}" }),
      ]),
      node("tabs-content", { value: "proposal" }, [
        node("card", {}, [
          node("badge", { variant: "outline" }, [
            node("span", {}, [text("Snapshot / proposal")]),
          ]),
          node("p", {}, [text("Proposed weekly review")]),
          node("p", {}, [
            text("A static proposal, not a registered Automation or action."),
          ]),
        ]),
      ]),
      node("tabs-content", { value: "unavailable" }, [
        node("automation-ref", { ...live, automationId: "invalid-selector" }),
      ]),
    ]),
  ]);
  const schema = await call("manage_entity_schema", {
    schema_type: "entity_type",
    action: "create",
    slug: "native-preview-report",
    name: "Synthetic native reports",
    event_kinds: {
      native_preview_report: {
        description: "Synthetic preview verification",
        jsonTemplate: root,
      },
    },
  });
  assert(
    schema.status === "applied",
    "Synthetic schema must apply, not await approval"
  );
  const entity = await call("manage_entity", {
    action: "create",
    entity_type: "native-preview-report",
    name: "Synthetic native component report",
    slug: "native-component-report",
  });
  assert(
    entity.entity?.id && !entity.approval_queued,
    "Synthetic report entity was not created"
  );
  const data = {
    workspace,
    automationId: String(automation.automation_id),
    agentId: agent.agent_id,
    connectorKey: connector.id,
    before: { cadence: "Monday", version: 1 },
    after: { cadence: "Tuesday", version: 2 },
  };
  const saved = await call("save_memory", {
    entity_ids: [Number(entity.entity.id)],
    semantic_type: "native_preview_report",
    payload_type: "empty",
    title: "Synthetic native component report",
    idempotency_key: "native-component-preview-report-v1",
    payload_data: data,
  });
  const eventId = Number(saved.id);
  assert(
    Number.isSafeInteger(eventId) && eventId > 0,
    "Save returned no event ID"
  );
  const readback = await call("read_knowledge", { content_ids: [eventId] });
  const stored = readback.content?.find((item) => Number(item.id) === eventId);
  assert(
    stored?.payload_type === "json_template" &&
      isDeepStrictEqual(stored.payload_template?.root, root) &&
      isDeepStrictEqual(stored.payload_data, data),
    "Saved event did not preserve the native template and synthetic payload"
  );
  const path = `/${workspace}/events/${eventId}`;
  await page.goto(new URL(path, baseUrl).toString(), {
    waitUntil: "domcontentloaded",
  });
  const tabs = page.getByRole("tablist", { name: "Native report views" });
  const select = async (name) => {
    await tabs.getByRole("tab", { name, exact: true }).click();
    await page.getByRole("tabpanel").waitFor();
  };
  const identities = async (target = page) => {
    const panel = target.getByRole("tabpanel");
    await panel.getByRole("link").filter({ hasText: automationName }).waitFor();
    await panel.getByText(agentName, { exact: true }).waitFor();
    await panel.getByText(connector.name, { exact: true }).waitFor();
    assert(
      (await panel.getByText("Never run", { exact: true }).count()) > 0,
      "Fixture unexpectedly ran"
    );
  };
  await identities();
  await page.screenshot({
    path: join(outputDir, "native-report-current.png"),
    fullPage: true,
  });
  await select("Changes");
  await page.getByRole("button", { name: "Show diff", exact: true }).click();
  await page
    .locator(".cm-editor")
    .getByText("Tuesday", { exact: false })
    .waitFor();
  await page.screenshot({
    path: join(outputDir, "native-report-diff.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Hide diff", exact: true }).click();
  await page.getByRole("button", { name: "Show diff", exact: true }).waitFor();
  await select("Proposal");
  await page
    .getByRole("tabpanel")
    .getByText("Snapshot / proposal", { exact: true })
    .waitFor();
  assert(
    (await page.getByRole("tabpanel").locator("a,button").count()) === 0,
    "Proposal gained live controls"
  );
  await select("Unavailable");
  await page
    .getByRole("tabpanel")
    .getByText("Reference unavailable.", { exact: true })
    .waitFor();
  await select("Current definitions");
  await select("Current definitions");
  await identities();
  const navigation = await runAutomationNavigationProof({
    page,
    baseUrl,
    outputDir,
    workspace,
    automationId: String(automation.automation_id),
    automationName,
    automationInstructions,
    connectorKey: connector.id,
    connectorName: connector.name,
    connectionId,
    call,
    assert,
  });
  await page.goto(new URL(path, baseUrl).toString());
  await tabs.waitFor();
  await identities();
  await page.reload();
  await identities();
  // A fresh context receives no fixture cookies or tokens. Exercise the
  // preview's existing single-user SPA sign-in, then wait for real rows at
  // the narrow viewport (resizing a mounted page can race responsive remounts).
  const freshPage = await page
    .context()
    .browser()
    .newPage({
      viewport: { width: 420, height: 900 },
      colorScheme: "light",
      deviceScaleFactor: 1,
    });
  // Keep the real anonymous denial in flight until an authenticated resolve
  // succeeds. This exercises the first-load sign-in race without fabricating
  // auth responses, identities or workspace data.
  let releaseLocalInit;
  let releaseAnonymousResolve;
  const anonymousResponseReady = new Promise((resolve) => {
    releaseLocalInit = resolve;
  });
  const authenticatedResponseReady = new Promise((resolve) => {
    releaseAnonymousResolve = resolve;
  });
  const firstLoadAuthentication = {};
  await freshPage.route("**/api/local-init", async (route) => {
    await anonymousResponseReady;
    await route.continue();
  });
  await freshPage.route(`**/api/${workspace}/resolve_path`, async (route) => {
    const response = await route.fetch();
    const status = response.status();
    if (
      firstLoadAuthentication.anonymous_status === undefined &&
      (status === 401 || status === 403)
    ) {
      firstLoadAuthentication.anonymous_status = status;
      releaseLocalInit();
      await authenticatedResponseReady;
    } else if (status === 200) {
      firstLoadAuthentication.authenticated_status = status;
      releaseAnonymousResolve();
    }
    await route.fulfill({ response });
  });
  try {
    await freshPage.goto(new URL(path, baseUrl).toString(), {
      waitUntil: "domcontentloaded",
    });
    await identities(freshPage);
    assert(
      [401, 403].includes(firstLoadAuthentication.anonymous_status) &&
        firstLoadAuthentication.authenticated_status === 200,
      "Fresh private deep link did not recover from its pending anonymous denial"
    );
    await freshPage.unrouteAll({ behavior: "wait" });
    await freshPage.screenshot({
      path: join(outputDir, "native-report-narrow.png"),
      fullPage: true,
    });
    await freshPage.goto(
      new URL(`/${workspace}/automations`, baseUrl).toString()
    );
    const activity = freshPage.getByRole("link", {
      name: "View activity",
      exact: true,
    });
    await activity.waitFor();
    await freshPage.screenshot({
      path: join(outputDir, "automation-list-narrow.png"),
      fullPage: true,
    });
    await activity.click();
    await freshPage
      .getByRole("dialog")
      .getByText("No runs match these filters.", { exact: true })
      .waitFor();
    await assertRunHistoryLayout(freshPage, assert);
    await freshPage.screenshot({
      path: join(outputDir, "automation-activity-narrow.png"),
      fullPage: true,
    });
    await freshPage
      .getByRole("button", { name: "Close preview", exact: true })
      .click();
    await freshPage.getByRole("dialog").waitFor({ state: "hidden" });
    assert(
      (await freshPage.getByRole("dialog").count()) === 0,
      "Narrow activity sheet remained after Close"
    );
    assert(
      navigation.combined_peek_path,
      "No verified combined-filter peek URL recorded"
    );
    await freshPage.goto(
      new URL(navigation.combined_peek_path, baseUrl).toString()
    );
    await freshPage
      .getByRole("region", { name: "Runs history", exact: true })
      .getByText("No runs match these filters.", { exact: true })
      .waitFor();
    await assertRunHistoryLayout(freshPage, assert);
    await freshPage.screenshot({
      path: join(outputDir, "automation-combined-activity-narrow.png"),
      fullPage: true,
    });
    await freshPage
      .getByRole("button", { name: "Close preview", exact: true })
      .click();
    await freshPage.getByRole("dialog").waitFor({ state: "hidden" });
  } finally {
    releaseLocalInit();
    releaseAnonymousResolve();
    await freshPage.unrouteAll({ behavior: "wait" });
    await freshPage.close();
  }
  // New authoring uses one module. Keep this code-only fixture inert while
  // exercising a real editor save: no triggers and no run invocation.
  const codeModuleSource = "export default async () => ({ total: 42 });";
  const codeModule = await call("manage_automations", {
    action: "create",
    slug: "native-preview-code-module",
    name: "Synthetic code module Automation",
    managed_agent_id: agent.agent_id,
    reaction_script: codeModuleSource,
    triggers: [],
  });
  assert(
    codeModule.automation_id,
    "Code module editor fixture was not created"
  );
  const codeModulePath = `/${workspace}/automations/${codeModule.automation_id}?view=definition`;
  await page.goto(new URL(codeModulePath, baseUrl).toString());
  await page.locator("#scratch-name").waitFor();
  await page.screenshot({
    path: join(outputDir, "code-module-editor.png"),
    fullPage: true,
  });
  await page
    .locator("#scratch-description")
    .fill("Synthetic unrelated description edit.");
  const codeModuleSaved = Promise.all(
    ["create_version", "update"].map((action) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/${workspace}/manage_automations` &&
          response.request().postDataJSON()?.action === action
      )
    )
  );
  await page
    .getByRole("button", { name: "Save Automation", exact: true })
    .click();
  for (const response of await codeModuleSaved) {
    const result = await response.json();
    assert(
      response.ok() &&
        !result.error &&
        !result.approval_queued &&
        result.status !== "pending_approval",
      "Code module editor save did not apply"
    );
  }
  const codeModuleDetails = await call("get_automation", {
    automation_id: String(codeModule.automation_id),
    page_size: 1,
  });
  const codeModuleReadback = codeModuleDetails.automation;
  assert(
    codeModuleReadback?.description ===
      "Synthetic unrelated description edit." &&
      codeModuleReadback.managed_agent_id === agent.agent_id &&
      !codeModuleReadback.execution_config?.executor &&
      codeModuleReadback.reaction_script === codeModuleSource &&
      codeModuleReadback.triggers.length === 0 &&
      !codeModuleReadback.device_worker_id,
    "Unrelated save changed the code module, owning agent, or trigger state"
  );
  const codeModuleRuns = await call("manage_operations", {
    action: "list_runs",
    automation_ids: [Number(codeModule.automation_id)],
    limit: 1,
  });
  assert(
    codeModuleRuns.runs?.length === 0,
    "Inert code module editor fixture unexpectedly ran"
  );
  await page.reload();
  await page.locator("#scratch-name").waitFor();
  assert(
    (await page.locator("#scratch-description").inputValue()) ===
      codeModuleReadback.description,
    "Code module editor reload lost the saved description"
  );
  await page.screenshot({
    path: join(outputDir, "code-module-editor-saved.png"),
    fullPage: true,
  });
  // The private fixture has no Slack connection and cannot receive a message.
  // Reply chat turns create no Automation-window run, so neither completion
  // stamp on the Automation records their activity.
  const replyName = "Synthetic event reply Automation";
  const reply = await call("manage_automations", {
    action: "create",
    slug: "native-preview-reply",
    name: replyName,
    managed_agent_id: agent.agent_id,
    triggers: [
      {
        kind: "event",
        source: "connector",
        connector_key: "slack",
        event_types: ["message.created"],
        execution: "turn",
        output: "reply_to_source",
        active_run: "queue",
      },
    ],
  });
  assert(
    reply.automation_id && !reply.approval_queued,
    "Reply fixture did not apply"
  );
  const replyReport = await call("save_memory", {
    entity_ids: [Number(entity.entity.id)],
    semantic_type: "native_preview_report",
    payload_type: "empty",
    title: "Synthetic reply activity review",
    payload_data: { ...data, automationId: String(reply.automation_id) },
    idempotency_key: "native-preview-reply-report-v1",
  });
  assert(replyReport.id, "Reply report did not apply");
  const replyPath = `/${workspace}/events/${replyReport.id}`;
  const assertReplyIdentity = async () => {
    const row = page.getByRole("link").filter({ hasText: replyName });
    await row
      .getByText("Replies to incoming messages", { exact: true })
      .waitFor();
    assert(
      (await row.getByText("Never run", { exact: true }).count()) === 0,
      "Reply identity claimed that its untracked chat history never ran"
    );
  };
  await page.goto(new URL(replyPath, baseUrl).toString());
  await assertReplyIdentity();
  await page.screenshot({
    path: join(outputDir, "reply-native-reference.png"),
    fullPage: true,
  });
  await page.goto(new URL(`/${workspace}/automations`, baseUrl).toString());
  await assertReplyIdentity();
  await page.screenshot({
    path: join(outputDir, "reply-automation-list.png"),
    fullPage: true,
  });
  const replyRuns = await call("manage_operations", {
    action: "list_runs",
    automation_ids: [Number(reply.automation_id)],
    limit: 10,
  });
  assert(
    replyRuns.runs.length === 0,
    "Synthetic reply fixture unexpectedly ran"
  );

  return {
    reply_activity: {
      path: replyPath,
      automation_id: reply.automation_id,
      runs: replyRuns.runs.length,
    },
    code_module_editor: {
      path: codeModulePath,
      automation_id: codeModule.automation_id,
      version: codeModuleReadback.version,
      owning_agent: codeModuleReadback.managed_agent_id,
      runs: codeModuleRuns.runs.length,
    },
    first_load_authentication: firstLoadAuthentication,
    path,
    event_id: eventId,
    workspace,
    automation_id: String(automation.automation_id),
    editor_path: `/${workspace}/automations/${automation.automation_id}?view=definition`,
    automation_list_path: `/${workspace}/automations`,
    activity_path: `/${workspace}?tab=runs&automation_ids=${automation.automation_id}`,
    connector_path: `/${workspace}/connectors/${encodeURIComponent(connector.id)}`,
    agent_id: agent.agent_id,
    connector_key: connector.id,
    connection_id: connectionId,
    connection_path: `/${workspace}/connectors/${encodeURIComponent(connector.id)}/${connectionId}`,
    connection_feeds: feeds.feeds.length,
    connection_runs: connectionRuns.runs.length,
    navigation,
    checked: [
      "saved event",
      "native identities",
      "Tabs",
      "JsonDiff expand/collapse",
      "inert proposal",
      "invalid selector refusal",
      "repeat selection",
      "reload",
      "fresh browser access via existing single-user preview sign-in",
      "narrow viewport identities loaded",
      "code module editor save preserves the module and owning agent",
      "reply identities describe the reply setup without inventing run history",
    ],
    screenshots: [
      "native-report-current.png",
      "native-report-diff.png",
      "native-report-narrow.png",
      "automation-list-narrow.png",
      "automation-activity-narrow.png",
      "automation-combined-activity-narrow.png",
      "code-module-editor.png",
      "code-module-editor-saved.png",
      "reply-native-reference.png",
      "reply-automation-list.png",
      ...navigation.screenshots,
    ],
  };
}
