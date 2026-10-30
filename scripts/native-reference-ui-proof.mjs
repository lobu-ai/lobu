import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
  const workspace = "native-ui-proof";
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
  const automation = await call("manage_automations", {
    action: "create",
    slug: "native-preview-manual",
    name: automationName,
    prompt: "Synthetic identity fixture. Do not run.",
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
    (item) => typeof item.id === "string" && typeof item.name === "string"
  );
  assert(connector, "Preview has no connector catalog identity to render");

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
        "Saved native event. Manual-only Automation, dormant Agent and catalog metadata; no external account is connected or operation executed."
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
        node("automation-ref", {
          mode: "snapshot",
          label: "Proposed weekly review",
          description:
            "A static proposal, not a registered Automation or action.",
        }),
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
  await page
    .getByRole("tabpanel")
    .getByRole("link")
    .filter({ hasText: automationName })
    .click();
  await page.waitForURL(
    (url) =>
      url.pathname === `/${workspace}/automations/${automation.automation_id}`
  );
  await page.goBack();
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
  try {
    await freshPage.goto(new URL(path, baseUrl).toString(), {
      waitUntil: "domcontentloaded",
    });
    await identities(freshPage);
    await freshPage.screenshot({
      path: join(outputDir, "native-report-narrow.png"),
      fullPage: true,
    });
  } finally {
    await freshPage.close();
  }
  return {
    synthetic: true,
    path,
    event_id: eventId,
    workspace,
    automation_id: String(automation.automation_id),
    automation_manual_only: true,
    agent_id: agent.agent_id,
    connector_key: connector.id,
    connector_account_connected: false,
    checked: [
      "saved event",
      "native identities",
      "Tabs",
      "JsonDiff expand/collapse",
      "inert proposal",
      "invalid selector refusal",
      "repeat selection",
      "Back",
      "reload",
      "fresh browser access via existing single-user preview sign-in",
      "narrow viewport identities loaded",
    ],
    screenshots: [
      "native-report-current.png",
      "native-report-diff.png",
      "native-report-narrow.png",
    ],
  };
}
