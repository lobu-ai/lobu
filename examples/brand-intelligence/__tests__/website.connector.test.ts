import { beforeAll, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";
import { runSync } from "./sync-harness";

mock.module("@lobu/connector-sdk", connectorSdkMock);

let WebsiteConnector: any;
beforeAll(async () => {
  WebsiteConnector = (await import("../website.connector")).default;
});

const url = "https://site.example/product";
const business =
  "Connect marketing data sources and automate reporting for your team.";
const banner = (
  label = "Accept all"
) => `<div role="region" aria-label="Cookie consent">
  <p>We use necessary cookies with your consent for marketing measurement.</p>
  <button>${label}</button><button>Reject all</button></div>`;

async function sync(html: string, parseSections = false, checkpoint: any = {}) {
  const connector = new WebsiteConnector();
  connector.fetchPage = async () => ({ html, finalUrl: url });
  return runSync(connector, {
    feedKey: "pages",
    config: { urls: [url], parse_sections: parseSections },
    checkpoint,
  });
}

for (const parseSections of [false, true]) {
  test(`retains business content beside a consent banner (sections=${parseSections})`, async () => {
    const result = await sync(
      `<main><h1>Analytics platform</h1><p>${business}</p></main>${banner()}`,
      parseSections
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload_text).toContain(business);
    expect(result.events[0].payload_text).not.toContain("necessary cookies");
    expect(result.events[0].payload_text).not.toContain("Accept all");
    expect(result.checkpoint.hashes[url]).toBeString();
  });

  test(`retains a consent product's description (sections=${parseSections})`, async () => {
    const description =
      "Manage cookie consent and marketing preferences using our privacy platform.";
    const result = await sync(
      `<main><h1>Privacy platform</h1><p>${description}</p></main>`,
      parseSections
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload_text).toContain(description);
  });
}

test("a consent banner alone supplies no company evidence or successful content hash", async () => {
  const result = await sync(banner());
  expect(result.events).toEqual([]);
  expect(result.checkpoint.hashes).toEqual({});
});

test("recognizes consent dialogs and conventional banner containers without inspecting business vocabulary", async () => {
  const containers = [
    '<div role="dialog" aria-label="Cookie preferences">',
    '<section role="alertdialog" aria-label="Cookie settings">',
    '<div id="onetrust-consent-sdk">',
    '<div id="onetrust-banner-sdk">',
    '<div id="CybotCookiebotDialog">',
    '<div id="cookie-banner">',
    '<div id="cookie_banner">',
  ];
  for (const opening of containers) {
    const closing = opening.startsWith("<section") ? "</section>" : "</div>";
    const result = await sync(
      `<main><p>${business}</p></main>${opening}<p>Necessary cookies and consent settings.</p>${closing}`
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload_text).toBe(business);
  }
});

test("consent-banner changes do not change source identity or re-emit unchanged business content", async () => {
  const content = `<main><h1>Analytics platform</h1><p>${business}</p></main>`;
  const first = await sync(content + banner());
  expect(first.events).toHaveLength(1);
  expect(first.events[0].origin_id).toStartWith("web_page_");
  const second = await sync(
    content + banner("Allow all"),
    false,
    first.checkpoint
  );
  expect(second.events).toEqual([]);
  expect(second.checkpoint.hashes).toEqual(first.checkpoint.hashes);
});
