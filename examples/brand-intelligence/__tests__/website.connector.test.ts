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

const document = (body: string) =>
  `<!doctype html><html><head><title>Analytics platform</title></head><body>${body}</body></html>`;

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

  test(`recognizes consent choices across control types (sections=${parseSections})`, async () => {
    for (const control of [
      '<input type="button" value="Accept all">',
      '<input type="submit" value="Reject all">',
      '<button value="accept">Accept all</button>',
      '<button value="1">Accept all</button>',
      '<a role="button" aria-label="Reject all">No thanks</a>',
    ]) {
      const consent = `<div role="region" aria-label="Cookie consent"><p>We use necessary cookies with your consent.</p>${control}</div>`;
      const onlyBanner = await sync(document(consent), parseSections);
      expect(onlyBanner.events).toEqual([]);
      expect(onlyBanner.checkpoint.hashes).toEqual({});

      const withBusiness = await sync(
        document(`<main><h1>Reporting</h1><p>${business}</p></main>${consent}`),
        parseSections
      );
      expect(withBusiness.events).toHaveLength(1);
      expect(withBusiness.events[0].payload_text).toContain(business);
      expect(withBusiness.events[0].payload_text).not.toContain(
        "necessary cookies"
      );
    }
  });

  test(`retains a product region titled Cookie consent (sections=${parseSections})`, async () => {
    for (const controls of [
      "",
      "<button>Explore features</button>",
      '<input type="button" value="Explore features">',
      '<button value="accept">Explore features</button>',
    ]) {
      const description = "Our platform helps teams manage privacy choices.";
      const result = await sync(
        `<section role="region" aria-labelledby="product-heading">
          <h1 id="product-heading">Cookie consent</h1><p>${description}</p>${controls}
        </section>`,
        parseSections
      );
      expect(result.events).toHaveLength(1);
      expect(result.events[0].payload_text).toContain(description);
    }
  });

  test(`removes conventional banner class tokens (sections=${parseSections})`, async () => {
    for (const className of [
      "cookie-banner",
      "visible cookie_banner overlay",
    ]) {
      const consent = `<div class="${className}"><p>We use necessary cookies with your consent.</p><button>Accept all</button></div>`;
      const onlyBanner = await sync(document(consent), parseSections);
      expect(onlyBanner.events).toEqual([]);
      expect(onlyBanner.checkpoint.hashes).toEqual({});

      const withBusiness = await sync(
        document(`<main><h1>Reporting</h1><p>${business}</p></main>${consent}`),
        parseSections
      );
      expect(withBusiness.events).toHaveLength(1);
      expect(withBusiness.events[0].payload_text).toContain(business);
      expect(withBusiness.events[0].payload_text).not.toContain(
        "necessary cookies"
      );
    }
  });

  test(`a full document containing only consent UI supplies no evidence (sections=${parseSections})`, async () => {
    const result = await sync(document(banner()), parseSections);
    expect(result.events).toEqual([]);
    expect(result.checkpoint.hashes).toEqual({});
  });

  test(`document titles stay in metadata instead of page evidence (sections=${parseSections})`, async () => {
    const result = await sync(
      document(`<main><h1>Reporting</h1><p>${business}</p></main>${banner()}`),
      parseSections
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload_text).not.toContain("Analytics platform");
    expect(result.events[0].payload_text).toContain(business);
    if (!parseSections) {
      expect(result.events[0].title).toBe("Analytics platform");
      expect(result.events[0].metadata?.meta_title).toBe("Analytics platform");
    }
  });

  test(`recognizes consent dialogs labelled by heading references (sections=${parseSections})`, async () => {
    const result = await sync(
      `<main><h1>Analytics platform</h1><p>${business}</p></main>
      <div role="dialog" aria-labelledby="cookie-label preference-label">
        <h2><span id="cookie-label">Cookie</span> <span id="preference-label">preferences</span></h2>
        <p>We use necessary cookies with your consent for marketing measurement.</p>
        <button>Accept all</button>
      </div>`,
      parseSections
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload_text).toContain(business);
    expect(result.events[0].payload_text).not.toContain("necessary cookies");
  });

  test(`retains non-consent labelled content (sections=${parseSections})`, async () => {
    const result = await sync(
      `<div role="region" aria-label="Cookie consent" aria-labelledby="product-label">
        <h1 id="product-label">Privacy platform</h1><p>${business}</p>
      </div>`,
      parseSections
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload_text).toContain(business);
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
    '<div role="dialog" aria-label="Cookie preferences" aria-labelledby="missing-label">',
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
