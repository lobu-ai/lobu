import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// This exercises persisted synthetic Automation navigation first. Historical
// runs below are explicitly browser-only READ fixtures: the hosted preview has
// no supported test-DB seed connection, and no run is submitted or executed.
export async function runAutomationNavigationProof({
  page,
  baseUrl,
  outputDir,
  workspace,
  automationId,
  automationName,
  automationInstructions,
  connectorKey,
  connectorName,
  connectionId,
  storedEvent,
  call,
  assert,
}) {
  const detailPath = `/${workspace}/automations/${automationId}`;
  const listPath = `/${workspace}/automations`;
  const name = page.locator("#scratch-name");
  const activity = () =>
    page.getByRole("link", { name: "View activity", exact: true });
  const close = () =>
    page.getByRole("button", { name: "Close preview", exact: true }).click();
  const emptyActivity = () =>
    page.getByText("No runs match these filters.", { exact: true }).waitFor();
  const legacyEmptyActivity = () =>
    page
      .getByText("This Automation hasn't written anything yet.", {
        exact: false,
      })
      .waitFor();
  const assertActivityDestination = async (expected) => {
    await page
      .getByRole("region", { name: "Runs history", exact: true })
      .waitFor();
    await assertRunHistoryLayout(page, assert);
    const href = await page
      .getByRole("link", { name: "Open in Activity", exact: true })
      .getAttribute("href");
    const destination = new URL(href, baseUrl);
    assert(
      destination.pathname === `/${workspace}` &&
        destination.searchParams.get("tab") === "runs",
      "Peek did not target the shared Activity page"
    );
    const encoded = new URL(page.url()).searchParams.get("peek_runs");
    const persisted = new URLSearchParams(encoded);
    for (const [key, value] of Object.entries(expected)) {
      assert(
        destination.searchParams.get(key) === String(value),
        `Activity destination lost ${key}`
      );
      assert(persisted.get(key) === String(value), `Peek URL lost ${key}`);
    }
    return destination;
  };
  const goto = (path) =>
    page.goto(new URL(path, baseUrl).toString(), {
      waitUntil: "domcontentloaded",
    });
  const screenshot = (file) =>
    page.screenshot({ path: join(outputDir, file), fullPage: true });
  const checkpoint = async (stage) => {
    const current = new URL(page.url());
    await writeFile(
      join(outputDir, "automation-navigation-progress.json"),
      JSON.stringify(
        {
          synthetic: true,
          stage,
          path: `${current.pathname}${current.search}`,
        },
        null,
        2
      )
    );
  };
  const assertName = async (value) => {
    await name.waitFor();
    assert(
      (await name.inputValue()) === value,
      "Automation draft changed unexpectedly"
    );
  };
  const assertHost = (path) =>
    assert(
      new URL(page.url()).pathname === path,
      "Peek navigated the host page"
    );
  const assertRunDestination = async (runId) => {
    const href = await page
      .getByRole("link", { name: "Open full page", exact: true })
      .getAttribute("href");
    const destination = new URL(href, baseUrl);
    assert(
      destination.pathname === `/${workspace}/events` &&
        destination.searchParams.get("run_ids") === String(runId),
      "Run full-page link was confused with a proposal review"
    );
    assert(
      new URL(page.url()).searchParams.get("peek_view") === "activity",
      "Run peek lost its explicit activity mode"
    );
  };

  await page
    .getByRole("tabpanel")
    .getByRole("link")
    .filter({ hasText: automationName })
    .click();
  await assertName(automationName);
  const instructions = page.locator(".ProseMirror");
  await instructions.filter({ hasText: "Preview exercise:" }).waitFor();
  assert(
    (await instructions.innerText()).includes(
      "no triggers, executor, or run is configured"
    ),
    "Actual editor did not show readable synthetic instructions"
  );
  await screenshot("automation-editor-instructions.png");
  // Persist safe routes as soon as this real page is verified, so a later
  // interrupted interaction cannot hide the useful editor review entry point.
  const editorUrl = new URL(page.url());
  await writeFile(
    join(outputDir, "automation-editor-proof.json"),
    JSON.stringify(
      {
        synthetic: true,
        browser_verified: true,
        editor_path: `${editorUrl.pathname}${editorUrl.search}`,
        automation_list_path: listPath,
        activity_path: `/${workspace}?tab=runs&automation_ids=${automationId}`,
        connection_path: `/${workspace}/connectors/${encodeURIComponent(connectorKey)}/${connectionId}`,
        connector_path: `/${workspace}/connectors/${encodeURIComponent(connectorKey)}`,
        instructions_visible: true,
        run_executed: false,
        screenshot: "automation-editor-instructions.png",
      },
      null,
      2
    )
  );
  const review = page.getByRole("region", {
    name: "Review changes",
    exact: true,
  });
  assert(
    (await review.count()) === 0,
    "Pristine editor showed a duplicate comparison control"
  );
  const renderedInstructions = await instructions.innerText();
  const draftAddition =
    " Draft-only addition: highlight unresolved questions first.";
  await instructions.click();
  await instructions.press("ControlOrMeta+End");
  await page.keyboard.insertText(draftAddition);
  assert(
    (await instructions.innerText()) === renderedInstructions + draftAddition,
    "Editing collapsed existing instruction paragraphs"
  );
  await review.waitFor();
  await review.getByRole("button", { name: "Show diff", exact: true }).click();
  await review
    .locator(".cm-editor")
    .getByText("Draft-only addition:", { exact: false })
    .waitFor();
  await screenshot("automation-instruction-changes.png");
  await instructions.press("ControlOrMeta+z");
  await review.waitFor({ state: "hidden" });
  assert(
    (await instructions.innerText()) === renderedInstructions,
    "Undo did not restore original instruction paragraphs"
  );
  assertHost(detailPath);
  assert(
    new URL(page.url()).searchParams.get("view") === "definition",
    "Native row did not target the definition"
  );
  const draft = `${automationName} — unsaved preview draft`;
  await name.fill(draft);
  await activity().click();
  await emptyActivity();
  await assertActivityDestination({ automation_ids: automationId });
  assertHost(detailPath);
  await assertName(draft);
  await screenshot("automation-edit-activity.png");
  await close();
  await assertName(draft);
  await activity().click();
  await emptyActivity();
  await close();
  await assertName(draft);

  // Save only the existing inert definition and an explicit synthetic note.
  await name.fill(automationName);
  const advanced = page.getByRole("button", {
    name: "Advanced settings",
    exact: true,
  });
  if ((await advanced.getAttribute("aria-expanded")) !== "true")
    await advanced.click();
  for (const id of [
    "scratch-description",
    "scratch-tags",
    "scratch-reactions-guidance",
  ]) {
    const field = page.locator(`#${id}`);
    assert(
      (await field.inputValue()).length > 0,
      `Missing saved clear-field fixture: ${id}`
    );
    await field.fill("");
  }
  await review.getByRole("button", { name: "Show diff", exact: true }).click();
  for (const field of ["Description", "Tags", "Reactions guidance"]) {
    await review
      .locator(".cm-editor")
      .getByText(field, { exact: false })
      .waitFor();
  }
  await screenshot("automation-cleared-fields-review.png");
  await page
    .locator("#scratch-change-notes")
    .fill("Synthetic preview form verification; no execution.");
  const saved = Promise.all(
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
  const responses = await saved;
  for (const response of responses) {
    const result = await response.json();
    assert(
      response.ok() &&
        !result.error &&
        !result.approval_queued &&
        result.status !== "pending_approval",
      "Synthetic definition save did not apply"
    );
    if (response.request().postDataJSON().action === "create_version")
      assert(result.version_id, "Synthetic save returned no new version");
  }
  await page
    .getByRole("button", { name: "Save Automation", exact: true })
    .waitFor();
  await assertName(automationName);
  assertHost(detailPath);
  assert(
    new URL(page.url()).searchParams.get("view") !== "activity",
    "Save bounced into full-page activity"
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForURL((url) => url.pathname === listPath);
  await activity().click();
  await emptyActivity();
  assertHost(listPath);
  const fullActivity = await assertActivityDestination({
    automation_ids: automationId,
  });
  await page
    .getByRole("link", { name: "Open in Activity", exact: true })
    .click();
  await page.waitForURL(fullActivity.toString());
  await emptyActivity();
  await page.goBack();
  await page.waitForURL((url) => url.pathname === listPath);
  await activity().waitFor();
  assert(
    (await page
      .getByRole("button", { name: "Close preview", exact: true })
      .count()) === 0,
    "Back restored a dismissed peek"
  );
  await page.getByRole("link").filter({ hasText: automationName }).click();
  await assertName(automationName);
  await goto(`${detailPath}?view=activity`);
  await legacyEmptyActivity();
  assert(
    (await name.count()) === 0,
    "Explicit legacy activity link opened the editor"
  );

  await goto(`/${workspace}`);
  await page
    .getByRole("navigation", { name: "Activity views" })
    .getByRole("link", { name: "Runs", exact: true })
    .click();
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  const filters = page.getByRole("search", { name: "Run filters" });
  await filters.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("option", { name: "Automation", exact: true }).click();
  await page.getByRole("option", { name: automationName, exact: true }).click();
  await page.keyboard.press("Escape");
  await page.waitForURL(
    (url) => url.searchParams.get("automation_ids") === String(automationId)
  );
  await page
    .getByText("No runs match these filters.", { exact: true })
    .waitFor();
  const automationFilteredUrl = page.url();
  assert(
    new URL(automationFilteredUrl).searchParams.get("automation_ids") ===
      String(automationId),
    "Automation filter was not URL-persisted"
  );
  await filters.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("option", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Completed", exact: true }).click();
  await page.waitForURL(
    (url) => url.searchParams.get("run_status") === "completed"
  );
  const filteredUrl = page.url();
  await page.goBack();
  await page.waitForURL(automationFilteredUrl);
  await page.goForward();
  await page.waitForURL(filteredUrl);
  await page.reload();
  await page
    .getByText("No runs match these filters.", { exact: true })
    .waitFor();
  assert(
    new URL(page.url()).searchParams.get("automation_ids") ===
      String(automationId),
    "Reload lost the Automation filter"
  );
  await screenshot("automation-runs-empty.png");

  // The resource links and Activity page must expose the very same history and
  // filter contract, not separate per-resource lists or new backend APIs.
  let combinedPeekPath;
  const verifySourceActivity = async (
    sourcePath,
    expected,
    file,
    combineSources = false
  ) => {
    await goto(sourcePath);
    await activity().click();
    await emptyActivity();
    assertHost(sourcePath);
    await assertActivityDestination(expected);
    const scopedFilters = page.getByRole("search", { name: "Run filters" });
    assert(
      (await scopedFilters.count()) === 1,
      "Resource rendered a duplicate history list"
    );
    await scopedFilters
      .getByRole("button", { name: "Filter", exact: true })
      .click();
    await page.getByRole("option", { name: "Status", exact: true }).click();
    await page.getByRole("option", { name: "Completed", exact: true }).click();
    await page.waitForURL(
      (url) =>
        new URLSearchParams(url.searchParams.get("peek_runs")).get(
          "run_status"
        ) === "completed"
    );
    const selected = { ...expected, run_status: "completed" };
    if (combineSources) {
      for (const [field, value] of [
        ["Connection", "Synthetic dormant RSS connection"],
        ["Connector", connectorName],
      ]) {
        await scopedFilters
          .getByRole("button", { name: "Filter", exact: true })
          .click();
        await page.getByRole("option", { name: field, exact: true }).click();
        await page.getByRole("option", { name: value, exact: true }).click();
        if (field === "Connection") await page.keyboard.press("Escape");
      }
      selected.connection_ids = connectionId;
      selected.connector_key = connectorKey;
      await page.waitForURL(
        (url) =>
          new URLSearchParams(url.searchParams.get("peek_runs")).get(
            "connector_key"
          ) === connectorKey
      );
    }
    const destination = await assertActivityDestination(selected);
    if (combineSources) {
      const current = new URL(page.url());
      combinedPeekPath = `${current.pathname}${current.search}`;
    }
    await emptyActivity();
    await screenshot(file);
    await page
      .getByRole("link", { name: "Open in Activity", exact: true })
      .click();
    await page.waitForURL(destination.toString());
    await emptyActivity();
    await page.reload();
    await emptyActivity();
    for (const [key, value] of Object.entries(selected))
      assert(
        new URL(page.url()).searchParams.get(key) === String(value),
        `Reload lost ${key}`
      );
    await page.goBack();
    await page.waitForURL(
      (url) => url.pathname.replace(/\/$/, "") === sourcePath.replace(/\/$/, "")
    );
    await activity().waitFor();
    assert(
      (await page
        .getByRole("button", { name: "Close preview", exact: true })
        .count()) === 0,
      "Back restored a dismissed source peek"
    );
    await activity().click();
    await assertActivityDestination(expected);
    await close();
  };
  await verifySourceActivity(
    detailPath,
    { automation_ids: automationId },
    "automation-combined-activity.png",
    true
  );
  await verifySourceActivity(
    `/${workspace}/connectors/${encodeURIComponent(connectorKey)}`,
    { connector_key: connectorKey },
    "connector-shared-activity.png"
  );
  await verifySourceActivity(
    `/${workspace}/connectors/${encodeURIComponent(connectorKey)}/${connectionId}`,
    { connection_ids: connectionId },
    "connection-shared-activity.png"
  );

  const fixture = installReadFixture({
    page,
    baseUrl,
    workspace,
    automationId,
    storedEvent,
  });
  await fixture.install();
  await checkpoint("browser-only run fixture installed");
  try {
    await goto(detailPath);
    await assertName(automationName);
    await name.fill(draft);
    await activity().click();
    const run = () =>
      page.getByRole("link", { name: `Run #${fixture.runId}`, exact: true });
    await run().click();
    await page.getByRole("region", { name: "Run outcome" }).waitFor();
    await assertRunDestination(fixture.runId);
    await screenshot("browser-only-automation-run-peek.png");
    await checkpoint("nested run peek verified");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await run().waitFor();
    await close();
    await assertName(draft);
    await activity().click();
    await run().waitFor();
    await page.reload();
    await run().waitFor();
    assertHost(detailPath);
    await close();

    await goto(filteredUrl);
    const firstRun = page.getByRole("link", {
      name: `Run #${fixture.runId}`,
      exact: true,
    });
    await firstRun.waitFor();
    const secondRun = page.getByRole("link", {
      name: `Run #${fixture.runId - 1}`,
      exact: true,
    });
    const more = page.getByRole("button", {
      name: "Load more runs",
      exact: true,
    });
    if (await more.isVisible()) {
      try {
        await more.click({ timeout: 5000 });
      } catch (error) {
        // The scroll sentinel may finish the same page before the button click.
        if (!(await secondRun.isVisible())) throw error;
      }
    }
    await secondRun.waitFor();
    assert(
      fixture.sawCursor(),
      "Global Runs did not request the existing pagination cursor"
    );
    await firstRun.click();
    await page.getByRole("region", { name: "Run outcome" }).waitFor();
    await assertRunDestination(fixture.runId);
    assertHost(`/${workspace}`);
    await screenshot("browser-only-global-runs-peek.png");
    await checkpoint("paginated global run peek verified; testing reload");
    await page.reload();
    await page.getByRole("region", { name: "Run outcome" }).waitFor();
    await assertRunDestination(fixture.runId);
    assert(
      new URL(page.url()).searchParams.get("automation_ids") ===
        String(automationId),
      "Run peek reload lost filters"
    );
    await close();
    await checkpoint("run peek reload verified; testing read failure");
    fixture.failList(true);
    await page.reload();
    await page.getByText("Failed to load runs.", { exact: false }).waitFor();
    assert(
      (await page
        .getByText("No runs match these filters.", { exact: true })
        .count()) === 0,
      "Read failure appeared as an empty result"
    );
    await checkpoint("read failure visible; testing Retry");
    fixture.failList(false);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await firstRun.waitFor();
    await checkpoint("Retry recovered; draining browser-only fixture handlers");
  } finally {
    await fixture.remove();
  }
  await checkpoint(
    "browser-only fixture removed; checking persisted empty state"
  );
  await goto(filteredUrl);
  await page
    .getByText("No runs match these filters.", { exact: true })
    .waitFor();
  const real = await call("manage_operations", {
    action: "list_runs",
    automation_ids: [Number(automationId)],
    limit: 30,
  });
  assert(
    Array.isArray(real.runs) && real.runs.length === 0,
    "Browser fixture leaked into persisted run history"
  );
  const definitions = await call("manage_automations", {
    action: "list",
    automation_id: String(automationId),
    include_details: true,
    limit: 1,
  });
  const definition = definitions.automations?.find(
    (item) => String(item.automation_id) === String(automationId)
  );
  assert(
    definition &&
      definition.prompt === automationInstructions &&
      !definition.triggers?.length &&
      !definition.execution_config?.executor &&
      !definition.managed_agent_id &&
      !definition.device_worker_id &&
      !definition.reaction_script &&
      !definition.description &&
      !definition.reactions_guidance &&
      !definition.tags?.length,
    "Synthetic form save added an execution path"
  );
  return {
    persisted: [
      "native row and list open definition",
      "readable instructions in actual editor and persisted definition",
      "collapsed saved-vs-draft instruction diff and revert",
      "draft survives repeated activity peek",
      "Save stays in editor",
      "cleared description, tags and reactions guidance persist",
      "Done returns list",
      "explicit activity link",
      "Activity Runs navigation",
      "Automation/status URL filters",
      "browser Back/Forward",
      "filter reload",
      "real empty state",
      "connection and connector shared Activity peek",
      "combined Automation/connection/connector/status filters",
      "peek status filters and Open in Activity preserve scope",
      "source Activity reload and browser Back",
    ],
    browser_only: [
      "paginated historical run read models",
      "activity to run to internal Back to close",
      "peek reload",
      "filtered global run peek",
      "read failure and Retry",
    ],
    combined_peek_path: combinedPeekPath,
    historical_runs_persisted: false,
    run_executed: false,
    screenshots: [
      "automation-editor-instructions.png",
      "automation-instruction-changes.png",
      "automation-cleared-fields-review.png",
      "automation-edit-activity.png",
      "automation-runs-empty.png",
      "automation-combined-activity.png",
      "connector-shared-activity.png",
      "connection-shared-activity.png",
      "browser-only-automation-run-peek.png",
      "browser-only-global-runs-peek.png",
    ],
  };
}

// Assert the actual shared filter controls stay visible in both desktop pane
// and narrow sheet, without constraining the paginated table's own scroller.
export async function assertRunHistoryLayout(page, assert) {
  const region = page.getByRole("region", {
    name: "Runs history",
    exact: true,
  });
  const bounds = await region.boundingBox();
  assert(bounds && bounds.width > 0, "Runs history has no visible bounds");
  const controls = [
    region.getByRole("search", { name: "Run filters" }),
    ...(await region.locator("[data-filter-chip]").all()),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    assert(
      box &&
        box.x >= bounds.x - 1 &&
        box.x + box.width <= bounds.x + bounds.width + 1,
      "Run filter control overflows its shared activity pane"
    );
  }
}

function installReadFixture({
  page,
  baseUrl,
  workspace,
  automationId,
  storedEvent,
}) {
  const runId = 920001;
  const createdAt = "2026-10-01T12:00:00.000Z";
  const run = {
    id: runId,
    run_type: "automation",
    automation_id: Number(automationId),
    status: "completed",
    created_at: createdAt,
    completed_at: createdAt,
    items_collected: 1,
    error_message: null,
    checkpoint: null,
    connector_version: null,
    connection_id: null,
    feed_id: null,
    connector_key: null,
    operation_key: null,
    approval_status: "auto",
    feed_key: null,
    feed_display_name: null,
    connection_display_name: "Browser-only fixture — not persisted or executed",
    device_worker_id: null,
    initiator_kind: "system",
    initiator_ref: {},
    created_by_user_id: null,
  };
  const event = {
    ...storedEvent,
    run_id: runId,
    automation_id: Number(automationId),
    title:
      "Browser-only synthetic historical output — not persisted or executed",
    metadata: {
      ...storedEvent.metadata,
      source_run_id: runId,
      browser_only_fixture: true,
    },
  };
  let fail = false;
  let cursor = false;
  const urls = ["manage_operations", "read_knowledge"].map((tool) =>
    new URL(`/api/${workspace}/${tool}`, baseUrl).toString()
  );
  const handler = async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const input = request.postDataJSON();
    const operations = request.url() === urls[0];
    const matching = operations
      ? input.action === "list_runs" ||
        (input.action === "get_run" &&
          [runId, runId - 1].includes(Number(input.run_id)))
      : Number(input.produced_by_automation_id) === Number(automationId) ||
        input.run_ids?.map(Number).includes(runId);
    if (!matching) return route.continue();
    // First perform the real scoped READ. Never turn an auth refusal into a
    // fixture success; the synthetic context still needs normal app access.
    const actual = await route.fetch();
    if (!actual.ok()) return route.fulfill({ response: actual });
    const body = await actual.json();
    const missingFixtureRun =
      operations &&
      input.action === "get_run" &&
      body.error === "Run not found";
    if (body.error && !missingFixtureRun)
      return route.fulfill({ response: actual });
    if (!operations)
      return route.fulfill({
        json: {
          content: [event],
          total: 1,
          classification_stats: {},
          page: {
            limit: 50,
            offset: 0,
            has_more: false,
            has_older: false,
            has_newer: false,
          },
        },
      });
    if (input.action === "get_run")
      return route.fulfill({
        json: { action: "get_run", run: { ...run, id: Number(input.run_id) } },
      });
    if (fail)
      return route.fulfill({
        status: 503,
        json: { error: "Synthetic preview read failure" },
      });
    const matches =
      (!input.status || input.status === run.status) &&
      (!input.run_types?.length || input.run_types.includes(run.run_type)) &&
      (!input.automation_ids?.length ||
        input.automation_ids.map(Number).includes(Number(automationId)));
    const second = Number(input.before_id) === runId;
    cursor ||= second && input.before_created_at === createdAt;
    return route.fulfill({
      json: {
        action: "list_runs",
        runs: matches ? [{ ...run, id: second ? runId - 1 : runId }] : [],
        total: matches ? 2 : 0,
        limit: 30,
        offset: 0,
        has_more: matches && !second,
      },
    });
  };
  return {
    runId,
    failList: (value) => {
      fail = value;
    },
    sawCursor: () => cursor,
    install: async () => {
      for (const url of urls) await page.route(url, handler);
    },
    // This dedicated page has only these two test routes. Wait for in-flight
    // real reads before removing them; plain unroute can leave an async fulfill
    // racing teardown and mask the original proof failure with an uncaught error.
    remove: () => page.unrouteAll({ behavior: "wait" }),
  };
}
