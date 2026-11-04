/** Real-browser contract check of the shipped view runtime + native artifacts.
 * Runs in frontend CI where Owletto is built; backend-only shards have no UI artifacts. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { assertPortableArtifact } from "./artifact-portability.mjs";
import { createServer } from "node:http";
import { chromium } from "playwright-vanilla";
import {
  compileView,
  renderViewShell,
  viewRuntimeScript,
} from "../packages/server/src/views/views";
import { readMcpAppAsset } from "../packages/server/src/utils/mcp-app-bundle";

const source = `import { useState } from "react";
import { defineView, sql, tool, useHost, useQuery } from "@lobu/views";
import { Button, Badge, DataTable, EntityAvatar, EntityListPage, EntityRecordPage, AutomationReference, AgentReference, ConnectorReference, AutomationDefinition, AgentDefinition, ConnectorDefinition, JsonDiff, Tabs, TabsList, TabsTrigger, TabsContent } from "@lobu/views/components";
export const view = defineView({ key: "native-proof", attach: [{ workspace: true }] });
const connectorCurrent = {name:"Example feed",version:"1.0.0",batch_size:50,enabled:false,actions_schema:{inspect:{name:"Inspect item",description:"Read one item"}},feeds_schema:{}};
const connectorProposed = {...connectorCurrent,version:"1.1.0",batch_size:100,actions_schema:{...connectorCurrent.actions_schema,search:{name:"Search items",description:"Find matching records"}}};
function DefinitionPreview({Body,current,proposed}) {
  return <section data-testid="definition-preview"><Badge>Proposal preview</Badge><p>Nothing has been applied.</p>
    <Tabs defaultValue="proposed"><TabsList label="Definition version"><TabsTrigger value="current">Current</TabsTrigger><TabsTrigger value="proposed">Proposed</TabsTrigger></TabsList>
      <TabsContent value="current"><Body value={current} /></TabsContent><TabsContent value="proposed"><Body value={proposed} /></TabsContent>
    </Tabs><details><summary>Technical diff</summary><JsonDiff before={current} after={proposed} /></details>
  </section>;
}
export default function Proof() {
  const host = useHost();
  const [search, setSearch] = useState("data");
  const [page, setPage] = useState(0);
  const [sorting, setSorting] = useState([]);
  const [mode, setMode] = useState("");
  const result = useQuery(tool("manage_entity", { action: "list", entity_type: "fixture", search, limit: 2, offset: page * 2, sort_by: sorting[0]?.id, sort_order: sorting[0]?.desc ? "desc" : "asc" }));
  const custom = useQuery<Array<{amount:number}>>(sql\`SELECT 2 AS amount\`);
  const customRows = (custom.data ?? []).map(row => ({key:"sql",label:"SQL + TypeScript row",amount:row.amount * 2}));
  customRows.push({key:"local",label:"TypeScript-only row",amount:0});
  return <main>
    <section aria-label="Native resources">
      <AutomationReference mode="live" workspace="fixture-workspace" automationId="42" />
      <AutomationReference mode="live" workspace="fixture-workspace" automationId="43" appearance="inline" />
      <AgentReference mode="live" workspace="fixture-workspace" agentId="fixture-agent" />
      <ConnectorReference mode="live" workspace="fixture-workspace" connectorKey="fixture.feed" />
      <ConnectorReference mode="live" workspace="fixture-workspace" connectorKey="fixture.feed" connectionId={7} />
      <div data-testid="refused-reference"><AgentReference mode="live" workspace="fixture-workspace" agentId="refused-agent" /></div>
      <div data-testid="wrong-workspace"><AgentReference mode="live" workspace="other-workspace" agentId="never-read" /></div>
      <div data-testid="invalid-reference"><AutomationReference mode="live" workspace="fixture-workspace" automationId="invalid" /></div>
      <Tabs defaultValue="connector-definition">
        <TabsList label="Definition examples"><TabsTrigger value="connector-definition">Connector</TabsTrigger><TabsTrigger value="agent-definition">Agent</TabsTrigger><TabsTrigger value="automation-definition">Automation</TabsTrigger></TabsList>
        <TabsContent value="connector-definition">
          <h2>Proposed connector definition</h2>
          <DefinitionPreview Body={ConnectorDefinition} current={connectorCurrent} proposed={connectorProposed} />
        </TabsContent>
        <TabsContent value="agent-definition">
          <h2>Proposed agent settings</h2>
          <DefinitionPreview Body={AgentDefinition} current={{name:"Example researcher",identity_md:"Read workspace records",settings:{showToolCalls:true,models:["fixture/model"]}}} proposed={{name:"Example researcher",identity_md:"Summarize workspace records with linked evidence",settings:{showToolCalls:false,models:[],skills:["fixture-skill"]}}} />
        </TabsContent>
        <TabsContent value="automation-definition">
          <h2>Proposed Automation settings</h2>
          <DefinitionPreview Body={AutomationDefinition} current={{name:"Example digest",prompt:"Summarize updates",sources:[],triggers:[],outputs:[]}} proposed={{name:"Example digest",prompt:"Summarize updates with source links",sources:[{name:"Recent items",query:"SELECT 1 AS amount"}],triggers:[],outputs:[],reaction_script:"const amount = 0;"}} />
        </TabsContent>
      </Tabs>
      <div data-testid="snapshot"><JsonDiff before={null} after={{name:"Proposed agent",enabled:false,count:0}} /></div>
    </section>
    <p data-testid="state">{result.loading ? "loading" : result.error ? "error:" + result.error : result.data?.entities.length ? "data" : "empty"}</p>
    <p data-testid="theme">{host.theme}</p>
    <p data-testid="mode">{mode}</p>
    <Badge data-testid="badge">Native badge</Badge>
    <EntityAvatar name="Example" metadata={{ email: "fixture@example.invalid" }} metadataSchema={{ properties: { email: { "x-email": true } } }} initialsFallback />
    <EntityRecordPage entity={{id:1,entity_type:"fixture",slug:"record",name:"Native record",metadata:{count:0,enabled:false,website:"https://fixture.example.invalid/record"}}} owner="fixture-workspace" schema={{properties:{count:{type:"number","x-table-column":true},enabled:{type:"boolean"},website:{type:"string",format:"uri"}}}}>
      <Tabs defaultValue="details"><TabsList><TabsTrigger value="details">Details</TabsTrigger><TabsTrigger value="other">Other</TabsTrigger></TabsList>
        <TabsContent value="details">Record activity slot</TabsContent>
        <TabsContent value="other">Other tab works</TabsContent>
      </Tabs>
    </EntityRecordPage>
    <EntityListPage title="Native collection"
      actions={<Button onClick={() => host.openRecord({ entity_id: 1 }).then(result => setMode(result.mode))}>Peek record</Button>}
      controls={<><input aria-label="Search" value={search} onChange={e => {setSearch(e.target.value);setPage(0);}} /><p>Collection controls</p></>}
      loading={result.loading} error={result.error} onRetry={result.refetch}
      empty={<p>No matching records</p>}
      table={result.data?.entities.length ? {entities:result.data.entities,owner:"fixture-workspace",isDerived:false,hasAnyParents:false,linkedEntityLookups:{},measureColumns:[],sorting,onSortingChange:setSorting,page,pageSize:2,totalCount:4,hasMore:result.data.metadata.has_more,pageTitle:"Records",onPrevPage:()=>setPage(p=>p-1),onNextPage:()=>setPage(p=>p+1)} : undefined} />
    <EntityListPage title="Custom data" controls={<p>Custom query results</p>}>
      <DataTable caption="Computed query results" rows={customRows} columns={[{key:"label",header:"Source"},{key:"amount",header:"Amount"}]} keyOf={row=>row.key} />
    </EntityListPage>
  </main>;
}`;
assertPortableArtifact(
  resolve("packages/owletto/dist-mcp-apps/view-native"),
  process.cwd()
);
const compiled = await compileView({
  entrypoint: "index.tsx",
  files: { "index.tsx": source },
});
const runtime = await viewRuntimeScript();
const errors: string[] = [];
const calls: Record<string, unknown>[] = [];
let origin: string;
let shell: string;
let hostHtml: string;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url!, "http://localhost").pathname;
    if (pathname.startsWith("/mcp-apps/view-native/assets/")) {
      const name = pathname.split("/").at(-1)!;
      const asset = await readMcpAppAsset("view-native", `assets/${name}`);
      assert(asset, `Missing native artifact ${name}`);
      response.setHeader(
        "Content-Type",
        name.endsWith("css") ? "text/css" : "text/javascript"
      );
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.end(asset.bytes);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    hostHtml = `<!doctype html><html><body><iframe sandbox="allow-scripts" style="width:900px;height:700px"></iframe><script>
      const frame = document.querySelector('iframe');
      let failedOnce = false;
      const send = message => frame.contentWindow.postMessage({jsonrpc:'2.0',...message},'*');
      window.sendContext = ctx => send({method:'ui/notifications/host-context-changed',params:ctx});
      window.addEventListener('message', async event => {
        if(event.source !== frame.contentWindow || event.data.jsonrpc !== '2.0') return;
        const {id,method,params} = event.data;
        if(id === undefined || !method) return;
        let result = {};
        if(method === 'ui/initialize') {
          result = {hostContext:{theme:'light',styles:{variables:{'--color-text-primary':'rgb(11, 22, 33)','--color-text-secondary':'rgb(91, 101, 111)','--color-background-primary':'rgb(255, 255, 255)','--color-background-secondary':'rgb(248, 249, 250)','--color-border-primary':'rgb(213, 218, 224)','--color-background-tertiary':'rgb(232, 236, 240)','--color-text-inverse':'rgb(255, 255, 255)','--color-text-info':'rgb(30, 50, 70)'}}}};
          send({id,result});
          send({method:'ui/notifications/tool-input',params:{arguments:{organization:'fixture-workspace',params:{},scope:{}}}});
          return;
        }
        if(method === 'lobu/open-record') result = {mode:'peek'};
        if(method === 'ui/open-link') window.openedLink = params.url;
        if(method === 'tools/call') {
          if (await window.reportCall?.(params)) window.sorted = true;
          const input = params.arguments;
          if(params.name === 'manage_automations') {
            const archived = input.automation_id === '43';
            result = {structuredContent:{automations:archived && input.status === 'active' ? [] : [{automation_id:input.automation_id,name:archived?'Archived example':'Saved automation',status:archived?'archived':'active',triggers:[]}]}};
            send({id,result}); return;
          }
          if(params.name === 'manage_agents') {
            result = (input.agent_id === 'refused-agent' || window.refuseReference) ? {isError:true,structuredContent:{error:{code:'FORBIDDEN'}},content:[{type:'text',text:'Access refused'}]} : {structuredContent:{agent:{id:input.agent_id,name:'Saved agent',description:'Shared product agent row'}}};
            send({id,result}); return;
          }
          if(params.name === 'manage_catalog') {
            send({id,result:{structuredContent:{installed:{connectors:{items:[{id:'fixture.feed',name:'Saved connector',detail:{description:'Shared product connector row'}}]}}}}}); return;
          }
          if(params.name === 'manage_connections') {
            send({id,result:{structuredContent:{connections:[{id:7,connector_key:'fixture.feed',display_name:'Example connection'}]}}}); return;
          }
          if(params.name === 'query_sql') {
            send({id,result:{structuredContent:{rows:[{amount:2}],truncated:false}}});
            return;
          }
          if(input.search === 'loading') return;
          if(input.search === 'error' && !failedOnce) { failedOnce = true; result={isError:true,structuredContent:{error:{code:'UPSTREAM_TIMEOUT'}},content:[{type:'text',text:'Upstream unavailable'}]}; }
          else result={structuredContent:{action:'list',entities:input.search==='empty'?[]:[{id:1,entity_type:'fixture',name:'Native row '+(input.offset+1),slug:'row',metadata:{},created_at:'2026-01-01'}],metadata:{page_size:2,has_more:input.offset===0}}};
        }
        send({id,result});
      });
      frame.srcdoc = ${JSON.stringify(shell).replaceAll("<", "\\u003c")};
    </script></body></html>`;
    response.end(hostHtml);
  } catch (error) {
    response.statusCode = 500;
    console.error("Native view smoke server failed", error);
    response.end("Native view smoke server failed");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
shell = renderViewShell(
  {
    key: "native-proof",
    name: "Native proof",
    description: "",
    source_code: source,
    compiled_code: compiled,
    content_hash: "synthetic",
    source_files: null,
    dependencies: null,
    source_complete: true,
    compile_config_hash: null,
    attach: [],
    params: {},
    actions: {},
    last_writer: "fixture",
    updated_at: "2026-01-01",
  },
  `${origin}/fixture-workspace/`,
  runtime
);
assert(
  shell.includes("/mcp-apps/view-native/assets/app.js"),
  "Build native view artifacts before running this smoke"
);
const executablePath = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
].find(existsSync);
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage();
try {
  await page.exposeFunction(
    "reportCall",
    (call: { arguments: Record<string, unknown> }) => {
      calls.push(call.arguments);
      return call.arguments.sort_by === "name";
    }
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  const frame = page.frameLocator("iframe");
  await Promise.race([
    frame.getByText("Native row 1", { exact: true }).waitFor(),
    frame
      .locator("[data-lobu-render-error]")
      .waitFor()
      .then(async () => {
        throw new Error(
          (await frame.locator("[data-lobu-render-error]").textContent()) ??
            "Native view failed to render"
        );
      }),
  ]);
  await frame
    .getByRole("link", { name: "Saved automation", exact: false })
    .waitFor();
  await frame
    .getByRole("link", { name: "Archived example", exact: false })
    .waitFor();
  assert.equal(
    await frame
      .getByRole("link", { name: "Archived example", exact: false })
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(232, 236, 240)"
  );
  assert.equal(
    await frame
      .getByText("Computed query results", { exact: true })
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(91, 101, 111)"
  );
  await frame
    .getByRole("link", { name: "Saved agent", exact: false })
    .waitFor();
  await frame
    .getByRole("link", { name: "Saved connector", exact: false })
    .first()
    .waitFor();
  for (const id of [
    "refused-reference",
    "wrong-workspace",
    "invalid-reference",
  ]) {
    assert.equal(
      await frame.getByTestId(id).innerText(),
      "Reference unavailable."
    );
  }
  assert(
    !calls.some(
      (input) =>
        input.agent_id === "never-read" || input.automation_id === "invalid"
    )
  );
  const agentLink = frame.getByRole("link", {
    name: "Saved agent",
    exact: false,
  });
  assert.equal(
    await agentLink.getAttribute("href"),
    `${origin}/fixture-workspace/agents/fixture-agent/settings`
  );
  await agentLink.click();
  await page.waitForFunction(() =>
    (window as unknown as { openedLink?: string }).openedLink?.endsWith(
      "/fixture-workspace/agents/fixture-agent/settings"
    )
  );
  await page.evaluate(() => {
    (window as unknown as { refuseReference: boolean }).refuseReference = true;
  });
  await frame
    .locator("body")
    .evaluate(() => window.dispatchEvent(new Event("focus")));
  await frame
    .getByRole("link", { name: "Saved agent", exact: false })
    .waitFor({ state: "detached" });
  await page.evaluate(() => {
    (window as unknown as { refuseReference: boolean }).refuseReference = false;
  });
  await frame
    .locator("body")
    .evaluate(() => window.dispatchEvent(new Event("focus")));
  await frame
    .getByRole("link", { name: "Saved agent", exact: false })
    .waitFor();
  const preview = frame.getByTestId("definition-preview");
  assert.equal(
    await preview
      .getByRole("textbox", { name: "Version", exact: true })
      .inputValue(),
    "1.1.0"
  );
  await preview.getByRole("tab", { name: "Current", exact: true }).click();
  assert.equal(
    await preview
      .getByRole("textbox", { name: "Version", exact: true })
      .inputValue(),
    "1.0.0"
  );
  await preview.getByRole("tab", { name: "Proposed", exact: true }).click();
  assert.equal(await preview.locator("details").getAttribute("open"), null);
  await preview.getByText("Technical diff", { exact: true }).click();
  await preview.getByRole("button", { name: "Show diff", exact: true }).click();
  const diffText = await preview.locator(".cm-editor").innerText();
  assert(diffText.includes("50") && diffText.includes("100"));
  assert.equal(
    await preview.locator(".cm-content").getAttribute("contenteditable"),
    "false"
  );
  await frame
    .getByTestId("snapshot")
    .getByRole("button", { name: "Show details", exact: true })
    .click();
  assert(
    (await frame.getByTestId("snapshot").innerText()).includes(
      '"enabled": false'
    )
  );
  assert(
    (await frame.getByTestId("snapshot").innerText()).includes('"count": 0')
  );
  await frame.getByRole("tab", { name: "Agent", exact: true }).click();
  assert.equal(
    await preview
      .getByRole("textbox", { name: "Identity", exact: true })
      .inputValue(),
    "Summarize workspace records with linked evidence"
  );
  assert.equal(await preview.getByRole("checkbox").isChecked(), false);
  await preview.getByRole("tab", { name: "Current", exact: true }).click();
  assert.equal(
    await preview
      .getByRole("textbox", { name: "Identity", exact: true })
      .inputValue(),
    "Read workspace records"
  );
  assert.equal(await preview.getByRole("checkbox").isChecked(), true);
  await frame.getByRole("tab", { name: "Automation", exact: true }).click();
  assert.equal(
    await preview
      .getByRole("textbox", { name: "Instructions", exact: true })
      .inputValue(),
    "Summarize updates with source links"
  );
  assert.equal(
    await preview.locator(".cm-content").getAttribute("contenteditable"),
    "false"
  );
  await preview.getByRole("tab", { name: "Current", exact: true }).click();
  assert.equal(
    await preview
      .getByRole("textbox", { name: "Instructions", exact: true })
      .inputValue(),
    "Summarize updates"
  );
  await frame.getByRole("tab", { name: "Connector", exact: true }).click();
  await preview.getByText("Technical diff", { exact: true }).click();
  await preview.getByRole("button", { name: "Show diff", exact: true }).click();
  assert.equal(await frame.getByTestId("state").textContent(), "data");
  await frame
    .getByRole("heading", { name: "Native collection", exact: true })
    .waitFor();
  await frame
    .getByRole("heading", { name: "Native record", exact: true })
    .waitFor();
  const sqlRow = frame
    .getByRole("row")
    .filter({ hasText: "SQL + TypeScript row" });
  await sqlRow.getByRole("cell", { name: "4", exact: true }).waitFor();
  await frame
    .getByRole("row")
    .filter({ hasText: "TypeScript-only row" })
    .getByRole("cell", { name: "0", exact: true })
    .waitFor();
  await page.locator("iframe").evaluate((frame) => {
    frame.style.width = "440px";
  });
  await frame.getByTestId("record-details").waitFor();
  assert.equal(await frame.getByTestId("record-summary").textContent(), "0");
  await page.locator("iframe").evaluate((frame) => {
    frame.style.width = "900px";
  });
  await frame.locator("aside").waitFor();
  assert.equal(await frame.locator("aside dd").nth(0).textContent(), "0");
  assert.match(
    (await frame.locator("aside dd").nth(1).textContent()) ?? "",
    /false|no/i
  );
  await frame.getByRole("link", { name: /fixture.example.invalid/ }).click();
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(
      () => (window as unknown as { openedLink?: string }).openedLink
    ),
    "https://fixture.example.invalid/record"
  );
  await frame.getByRole("tab", { name: "Other", exact: true }).click();
  await frame.getByText("Other tab works", { exact: true }).waitFor();
  await frame.getByRole("tab", { name: "Details", exact: true }).click();
  await frame.getByRole("button", { name: "Peek record" }).click();
  await frame.getByTestId("mode").filter({ hasText: "peek" }).waitFor();
  await frame.getByRole("button", { name: "Next", exact: true }).click();
  await frame.getByText("Native row 3", { exact: true }).waitFor();
  assert(calls.some((call) => call.offset === 2));
  await frame.getByRole("button", { name: /Name/ }).click();
  await page.waitForFunction(
    () => (window as unknown as { sorted: boolean }).sorted === true
  );
  await frame.getByTestId("state").filter({ hasText: "data" }).waitFor();
  await page.evaluate(() =>
    (window as unknown as { sendContext: (ctx: unknown) => void }).sendContext({
      theme: "dark",
      styles: {
        variables: {
          "--color-text-primary": "rgb(210, 220, 230)",
          "--color-text-info": "rgb(155, 193, 255)",
          "--color-text-inverse": "rgb(15, 14, 12)",
        },
      },
    })
  );
  await frame.getByTestId("theme").filter({ hasText: "dark" }).waitFor();
  assert.equal(
    await frame
      .locator(".cm-content span")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(210, 220, 230)"
  );
  assert.equal(
    await frame.locator("main").evaluate((el) => getComputedStyle(el).color),
    "rgb(210, 220, 230)"
  );
  assert.equal(
    await frame
      .getByRole("link", { name: /fixture.example.invalid/ })
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(155, 193, 255)"
  );
  const buttonPalette = await frame
    .getByRole("button", { name: "Peek record" })
    .evaluate((button) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-text-inverse)";
      button.append(probe);
      const inverse = getComputedStyle(probe).color;
      probe.style.color = "var(--primary-foreground)";
      const primaryForeground = getComputedStyle(probe).color;
      probe.remove();
      const channels = (color: string) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data);
      };
      return {
        text: channels(getComputedStyle(button).color),
        background: channels(getComputedStyle(button).backgroundColor),
        inverse: channels(inverse),
        primaryForeground: channels(primaryForeground),
      };
    });
  assert.deepEqual(buttonPalette.text, buttonPalette.primaryForeground);
  const luminance = (rgba: number[]) =>
    rgba.slice(0, 3).reduce((sum, value, index) => {
      const channel = value / 255;
      return (
        sum +
        (channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][index]!
      );
    }, 0);
  const textLight = luminance(buttonPalette.text);
  const backgroundLight = luminance(buttonPalette.background);
  assert(
    (Math.max(textLight, backgroundLight) + 0.05) /
      (Math.min(textLight, backgroundLight) + 0.05) >=
      4.5,
    "Native primary controls must remain readable when host info text is pale"
  );
  assert.notDeepEqual(
    buttonPalette.text,
    buttonPalette.inverse,
    "Dark primary controls must retain the product's readable foreground"
  );
  for (const state of ["empty", "error", "loading"]) {
    await frame.getByRole("textbox", { name: "Search" }).fill(state);
    await frame.getByTestId("state").filter({ hasText: state }).waitFor();
    if (state === "empty")
      await frame.getByText("No matching records", { exact: true }).waitFor();
    if (state === "error")
      await frame
        .getByRole("alert")
        .filter({ hasText: "Upstream unavailable" })
        .waitFor();
    if (state === "loading")
      await frame.getByRole("status", { name: "Loading entities" }).waitFor();
    assert.equal(
      await frame
        .getByRole("textbox", { name: "Search" })
        .evaluate((input) => document.activeElement === input),
      true
    );
    if (state === "error") {
      await frame.getByRole("button", { name: "Retry", exact: true }).click();
      await frame.getByTestId("state").filter({ hasText: "data" }).waitFor();
    }
  }
  await frame.getByRole("textbox", { name: "Search" }).fill("data");
  await frame.getByText("Native row 1", { exact: true }).waitFor();
  assert.equal(
    await frame.getByRole("textbox", { name: "Search" }).inputValue(),
    "data"
  );
  assert.deepEqual(errors, []);
  // Optional review artifact: the exact compiled fixture and native runtime,
  // fully inlined with synthetic host replies. No service or workspace needed.
  const exampleArg = process.argv.indexOf("--example-dir");
  if (exampleArg >= 0) {
    const exampleDir = process.argv[exampleArg + 1];
    assert(exampleDir, "--example-dir requires an output directory");
    const [js, css] = await Promise.all([
      readMcpAppAsset("view-native", "assets/app.js"),
      readMcpAppAsset("view-native", "assets/app.css"),
    ]);
    assert(js && css);
    const embedded = shell
      .replace(
        `<link rel="stylesheet" href="${origin}/mcp-apps/view-native/assets/app.css?v=${css.version}">`,
        () => `<style>${css.bytes.toString()}</style>`
      )
      .replace(
        `<script src="${origin}/mcp-apps/view-native/assets/app.js?v=${js.version}"></script>`,
        () =>
          `<script>${js.bytes.toString().replaceAll("</script", "<\\/script")}</script>`
      );
    assert(!embedded.includes(`${origin}/mcp-apps/view-native/assets/`));
    let example = hostHtml!
      .replace(JSON.stringify(shell).replaceAll("<", "\\u003c"), () =>
        JSON.stringify(embedded).replaceAll("<", "\\u003c")
      )
      .replace(
        'style="width:900px;height:700px"',
        'style="width:100%;max-width:900px;height:1100px;border:0"'
      )
      .replace(
        "<html><body>",
        `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native component examples</title><style>body{margin:0;font:14px/1.5 var(--font-sans,system-ui);color:var(--foreground,#202328);background:transparent}h1{font-size:23px;margin:0 0 8px}p{margin:0 0 14px;max-width:70ch}button{font:inherit;padding:6px 11px;border:1px solid var(--border,#ddd);border-radius:6px;color:inherit;background:transparent;cursor:pointer}button:focus-visible{outline:2px solid var(--ring,#2563eb)}nav{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}iframe{display:block;background:var(--card,#fff);border-radius:8px}.note{color:var(--muted-foreground,#666);font-size:12px}pre{overflow:auto;font-size:12px;padding:16px;background:var(--muted,#f5f5f5);border-radius:8px}details{margin:16px 0}summary{cursor:pointer}</style></head><body><h1>The same product components inside a view</h1><p>Actual compiled components with fictional data. Switch Current / Proposed, inspect native definitions, switch tabs, search and page through rows. These examples make no workspace changes.</p><nav aria-label="Demo controls"><button id="demo-light">Light</button><button id="demo-dark">Dark</button><button id="demo-narrow">Narrow</button><button id="demo-wide">Wide</button></nav><p class="note">Resource links are handled by this simulated host. No live workspace is connected.</p>`
      );
    example = example.replace(
      "</body></html>",
      `<details><summary>How a view shows a proposed change</summary><pre>import { ConnectorDefinition } from "@lobu/views/components";

&lt;ConnectorDefinition value={proposedDefinition} /&gt;

// AgentDefinition and AutomationDefinition take the same value prop.
// Use Tabs for Current / Proposed; JsonDiff is optional technical detail.
// Rendering it does not save or apply anything.</pre></details><script>
const palette = dark => ({theme:dark?'dark':'light',styles:{variables:{'--color-background-primary':dark?'#14171c':'#fff','--color-background-secondary':dark?'#1c2027':'#f8f9fa','--color-background-tertiary':dark?'#282e37':'#eef0f3','--color-text-primary':dark?'#f1f3f5':'#202328','--color-text-secondary':dark?'#afb8c4':'#59616d','--color-text-info':dark?'#9bc1ff':'#244d84','--color-border-primary':dark?'#454c57':'#d5dae0'}}});
for(const dark of [false,true])document.getElementById(dark?'demo-dark':'demo-light').onclick=()=>{document.querySelector('iframe').style.background=dark?'#14171c':'#fff';window.sendContext(palette(dark));};
document.getElementById('demo-narrow').onclick=()=>document.querySelector('iframe').style.maxWidth='380px';
document.getElementById('demo-wide').onclick=()=>document.querySelector('iframe').style.maxWidth='900px';
</script></body></html>`
    );
    await mkdir(exampleDir, { recursive: true });
    const file = resolve(exampleDir, "index.html");
    await writeFile(file, example);
    await page.goto(pathToFileURL(file).href);
    await frame
      .getByRole("link", { name: "Saved agent", exact: false })
      .waitFor();
    await frame
      .getByTestId("definition-preview")
      .getByRole("textbox", { name: "Version", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await frame.getByTestId("theme").filter({ hasText: "dark" }).waitFor();
    await page.getByRole("button", { name: "Narrow", exact: true }).click();
    await frame.getByTestId("record-details").waitFor();
    assert.deepEqual(errors, []);
  }
  console.log(
    "PASS: shared resource references, read-only definition diffs and snapshots, list/record pages, SQL and TypeScript rows, responsive details, tabs, peek, pagination, query states and live theme in an opaque browser sandbox"
  );
} catch (error) {
  console.error({
    errors,
    calls,
    frames: await Promise.all(
      page.frames().map((frame) =>
        frame
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      )
    ),
  });
  throw error;
} finally {
  await browser.close();
  server.close();
}
