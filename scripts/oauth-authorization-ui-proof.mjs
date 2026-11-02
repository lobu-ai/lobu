import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runNativeReferenceProof } from "./native-reference-ui-proof.mjs";

const require = createRequire(import.meta.url);
const runtime = process.env.PLAYWRIGHT_RUNTIME;
const chromePath = process.env.CHROME_PATH;
const baseUrl = process.env.PROOF_BASE_URL;
const outputDir = process.env.PROOF_OUTPUT_DIR;

if (!runtime || !chromePath || !baseUrl || !outputDir) {
  throw new Error(
    "PLAYWRIGHT_RUNTIME, CHROME_PATH, PROOF_BASE_URL, and PROOF_OUTPUT_DIR are required"
  );
}

const { chromium } = require(join(runtime, "node_modules", "playwright-core"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonResponse(response, operation) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${operation} failed (${response.status}): ${JSON.stringify(body)}`
    );
  }
  return body;
}

async function postJson(path, body) {
  return jsonResponse(
    await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    `POST ${path}`
  );
}

async function postForm(path, body) {
  return jsonResponse(
    await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }),
    `POST ${path}`
  );
}

async function browserPost(page, path, body, headers = {}) {
  const result = await page.evaluate(
    async ({ path, body, headers }) => {
      const response = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { path, body, headers }
  );
  if (!result.ok) {
    throw new Error(
      `POST ${path} failed (${result.status}): ${JSON.stringify(result.body)}`
    );
  }
  return result.body;
}

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage({
  viewport: { width: 1440, height: 1400 },
  colorScheme: "light",
  deviceScaleFactor: 1,
});

const results = {
  base_url: baseUrl,
  workspaces_created: [],
  consent: {},
  device: {},
};

try {
  await page.goto(new URL("/api/health", baseUrl).toString());
  const localInit = await browserPost(
    page,
    "/api/local-init",
    {},
    { "X-Lobu-Client": "oauth-authorization-ui-proof" }
  );
  assert(localInit?.user?.id, "Local preview bootstrap did not return a user");
  assert(
    localInit?.organization?.id,
    "Local preview bootstrap did not return a workspace"
  );

  // Preserve earlier review fixtures when the preview keeps its database.
  const fixtureId = randomBytes(4).toString("hex");
  for (const [name, prefix] of [
    ["Engineering", "oauth-proof-engineering"],
    ["Customer operations", "oauth-proof-customer-operations"],
  ]) {
    const slug = `${prefix}-${fixtureId}`;
    const organization = await browserPost(
      page,
      "/api/auth/organization/create",
      { name, slug }
    );
    results.workspaces_created.push({ id: organization?.id, name, slug });
  }
  const membershipResponse = await page.request.get(
    new URL("/api/organizations", baseUrl).toString()
  );
  assert(membershipResponse.ok(), "Read synthetic preview memberships failed");
  const memberships = await membershipResponse.json();
  const workspaceCount = memberships.organizations?.length;
  assert(workspaceCount >= 3, "Preview memberships are missing fixtures");

  const redirectUri = "http://localhost:8787/oauth-proof/callback";
  const consentClient = await postJson("/oauth/register", {
    client_name: "Lobu MCP Client",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  });
  assert(
    consentClient?.client_id,
    "Consent client registration returned no client_id"
  );

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(12).toString("base64url");
  const authorizeUrl = new URL("/oauth/authorize", baseUrl);
  authorizeUrl.searchParams.set("client_id", consentClient.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set(
    "scope",
    "mcp:read mcp:write mcp:admin profile:read"
  );
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  const resourceUrl = new URL("/mcp", baseUrl);
  resourceUrl.hostname = "localhost";
  authorizeUrl.searchParams.set("resource", resourceUrl.toString());

  await page.goto(authorizeUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Authorize application" }).waitFor();
  await page.getByText(`0 of ${workspaceCount} workspaces selected.`).waitFor();
  await page
    .getByRole("button", { name: `Select all ${workspaceCount}` })
    .click();
  await page
    .getByText(`${workspaceCount} of ${workspaceCount} workspaces selected.`)
    .waitFor();
  await page.getByLabel("Read only").check();
  await page.screenshot({
    path: join(outputDir, "oauth-consent-review.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL((url) => url.pathname === "/oauth-proof/callback");

  const callbackUrl = new URL(page.url());
  const code = callbackUrl.searchParams.get("code");
  assert(code, "Consent approval did not redirect with an authorization code");
  assert(
    callbackUrl.searchParams.get("state") === state,
    "Consent redirect changed OAuth state"
  );
  const consentTokens = await postForm("/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: consentClient.client_id,
    code_verifier: verifier,
    resource: resourceUrl.toString(),
  });
  const consentScope = String(consentTokens.scope || "")
    .split(/\s+/)
    .filter(Boolean);
  assert(
    consentScope.includes("mcp:read"),
    "Downscoped consent token lost mcp:read"
  );
  assert(
    !consentScope.includes("mcp:write"),
    "Downscoped consent token retained mcp:write"
  );
  assert(
    !consentScope.includes("mcp:admin"),
    "Downscoped consent token retained mcp:admin"
  );
  results.consent = {
    screenshot: "oauth-consent-review.png",
    requested_access: "admin",
    approved_access: "read",
    workspace_access: "all_current",
    token_scope: consentScope,
  };

  const deviceClient = await postJson("/oauth/register", {
    client_name: "Lobu CLI",
    grant_types: [
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ],
    token_endpoint_auth_method: "none",
  });
  assert(
    deviceClient?.client_id,
    "Device client registration returned no client_id"
  );
  const deviceAuthorization = await postJson("/oauth/device_authorization", {
    client_id: deviceClient.client_id,
    scope:
      "device_worker:run mcp:read mcp:write mcp:admin profile:read connections:token",
  });
  assert(
    deviceAuthorization?.verification_uri_complete,
    "Device authorization returned no link"
  );

  await page.goto(deviceAuthorization.verification_uri_complete, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Authorize application" }).waitFor();
  await page.getByText("Device capabilities").waitFor();
  await page.getByText(`1 of ${workspaceCount} workspaces selected.`).waitFor();
  await page
    .getByRole("button", { name: `Select all ${workspaceCount}` })
    .click();
  await page
    .getByText(`${workspaceCount} of ${workspaceCount} workspaces selected.`)
    .waitFor();
  await page
    .getByLabel(
      "I initiated this request and confirmed that the device code matches."
    )
    .click();
  await page.screenshot({
    path: join(outputDir, "oauth-device-review.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText("Access Authorized", { exact: true }).waitFor();

  const deviceTokens = await postForm("/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceAuthorization.device_code,
    client_id: deviceClient.client_id,
  });
  const deviceScope = String(deviceTokens.scope || "")
    .split(/\s+/)
    .filter(Boolean);
  assert(
    deviceScope.includes("device_worker:run"),
    "Device token lost device_worker:run"
  );
  assert(
    deviceScope.includes("mcp:admin"),
    "Device token lost approved mcp:admin"
  );
  results.device = {
    screenshot: "oauth-device-review.png",
    approved_access: "admin",
    workspace_access: "all_current",
    token_scope: deviceScope,
  };

  results.native_report = await runNativeReferenceProof({
    page,
    browserPost,
    baseUrl,
    outputDir,
    assert,
  });

  await writeFile(
    join(outputDir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`
  );
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await page
    .screenshot({ path: join(outputDir, "failure.png"), fullPage: true })
    .catch(() => {
      // Preserve the original proof failure when a diagnostic screenshot fails.
    });
  await writeFile(
    join(outputDir, "failure.txt"),
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  throw error;
} finally {
  await browser.close();
}
