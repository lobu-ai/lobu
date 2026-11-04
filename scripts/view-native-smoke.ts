/** Real-browser contract check of the shipped view runtime + native artifacts.
 * Runs in frontend CI where Owletto is built; backend-only shards have no UI artifacts. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
import { defineView, tool, useHost, useQuery } from "@lobu/views";
import { Button, Badge, EntityAvatar, EntityTableView, RecordSpecSheet, Tabs, TabsList, TabsTrigger, TabsContent } from "@lobu/views/components";
export const view = defineView({ key: "native-proof", attach: [{ workspace: true }] });
export default function Proof() {
  const host = useHost();
  const [search, setSearch] = useState("data");
  const [page, setPage] = useState(0);
  const [sorting, setSorting] = useState([]);
  const [mode, setMode] = useState("");
  const result = useQuery(tool("manage_entity", { action: "list", entity_type: "fixture", search, limit: 2, offset: page * 2, sort_by: sorting[0]?.id, sort_order: sorting[0]?.desc ? "desc" : "asc" }));
  return <main>
    <input aria-label="Search" value={search} onChange={e => {setSearch(e.target.value);setPage(0);}} />
    <p data-testid="state">{result.loading ? "loading" : result.error ? "error:" + result.error : result.data?.entities.length ? "data" : "empty"}</p>
    <p data-testid="theme">{host.theme}</p>
    <p data-testid="mode">{mode}</p>
    <Button onClick={() => host.openRecord({ entity_id: 1 }).then(result => setMode(result.mode))}>Peek record</Button>
    <Badge data-testid="badge">Native badge</Badge>
    <EntityAvatar name="Example" metadata={{ email: "fixture@example.invalid" }} metadataSchema={{ properties: { email: { "x-email": true } } }} initialsFallback />
    <Tabs defaultValue="details"><TabsList><TabsTrigger value="details">Details</TabsTrigger><TabsTrigger value="other">Other</TabsTrigger></TabsList>
      <TabsContent value="details"><RecordSpecSheet fields={[{key:"count",prop:{type:"number"}},{key:"enabled",prop:{type:"boolean"}},{key:"website",prop:{type:"string",format:"uri"}}]} values={{count:0,enabled:false,website:"https://fixture.example.invalid/record"}} context={{ownerSlug:"fixture-workspace"}} /></TabsContent>
      <TabsContent value="other">Other tab works</TabsContent>
    </Tabs>
    {result.data && <EntityTableView entities={result.data.entities} owner="fixture-workspace" isDerived={false} hasAnyParents={false} linkedEntityLookups={{}} measureColumns={[]} sorting={sorting} onSortingChange={setSorting} page={page} pageSize={2} totalCount={4} hasMore={result.data.metadata.has_more} pageTitle="Records" onPrevPage={() => setPage(p=>p-1)} onNextPage={() => setPage(p=>p+1)} />}
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
    response.end(`<!doctype html><html><body><iframe sandbox="allow-scripts" style="width:900px;height:700px"></iframe><script>
      const frame = document.querySelector('iframe');
      const send = message => frame.contentWindow.postMessage({jsonrpc:'2.0',...message},'*');
      window.sendContext = ctx => send({method:'ui/notifications/host-context-changed',params:ctx});
      window.addEventListener('message', async event => {
        if(event.source !== frame.contentWindow || event.data.jsonrpc !== '2.0') return;
        const {id,method,params} = event.data;
        if(id === undefined || !method) return;
        let result = {};
        if(method === 'ui/initialize') {
          result = {hostContext:{theme:'light',styles:{variables:{'--color-text-primary':'rgb(11, 22, 33)','--color-text-inverse':'rgb(255, 255, 255)','--color-text-info':'rgb(30, 50, 70)'}}}};
          send({id,result});
          send({method:'ui/notifications/tool-input',params:{arguments:{organization:'fixture-workspace',params:{},scope:{}}}});
          return;
        }
        if(method === 'lobu/open-record') result = {mode:'peek'};
        if(method === 'ui/open-link') window.openedLink = params.url;
        if(method === 'tools/call') {
          if (await window.reportCall(params)) window.sorted = true;
          const input = params.arguments;
          if(input.search === 'loading') return;
          if(input.search === 'error') result={isError:true,structuredContent:{error:{code:'UPSTREAM_TIMEOUT'}},content:[{type:'text',text:'Upstream unavailable'}]};
          else result={structuredContent:{action:'list',entities:input.search==='empty'?[]:[{id:1,entity_type:'fixture',name:'Native row '+(input.offset+1),slug:'row',metadata:{},created_at:'2026-01-01'}],metadata:{page_size:2,has_more:input.offset===0}}};
        }
        send({id,result});
      });
      frame.srcdoc = ${JSON.stringify(shell).replaceAll("<", "\\u003c")};
    </script></body></html>`);
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
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
  await frame.getByText("Native row 1", { exact: true }).waitFor();
  assert.equal(await frame.getByTestId("state").textContent(), "data");
  assert.equal(await frame.locator("dd").nth(0).textContent(), "0");
  assert.match(
    (await frame.locator("dd").nth(1).textContent()) ?? "",
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
          "--color-text-info": "rgb(47, 99, 232)",
          "--color-text-inverse": "rgb(15, 14, 12)",
        },
      },
    })
  );
  await frame.getByTestId("theme").filter({ hasText: "dark" }).waitFor();
  assert.equal(
    await frame.locator("main").evaluate((el) => getComputedStyle(el).color),
    "rgb(210, 220, 230)"
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
        inverse: channels(inverse),
        primaryForeground: channels(primaryForeground),
      };
    });
  assert.deepEqual(buttonPalette.text, buttonPalette.primaryForeground);
  assert.notDeepEqual(
    buttonPalette.text,
    buttonPalette.inverse,
    "Dark primary controls must retain the product's readable foreground"
  );
  for (const state of ["empty", "error", "loading"]) {
    await frame.getByRole("textbox", { name: "Search" }).fill(state);
    await frame.getByTestId("state").filter({ hasText: state }).waitFor();
  }
  await frame.getByRole("textbox", { name: "Search" }).fill("data");
  await frame.getByText("Native row 1", { exact: true }).waitFor();
  assert.equal(
    await frame.getByRole("textbox", { name: "Search" }).inputValue(),
    "data"
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: native table, record values, tabs, peek request, pagination, structured reads, query states, live theme in an opaque browser sandbox"
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
