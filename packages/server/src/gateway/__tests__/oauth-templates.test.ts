import { describe, expect, test } from "bun:test";
import {
  renderOAuthErrorPage,
  renderOAuthSuccessPage,
} from "../auth/oauth-templates.js";

describe("OAuth template escaping", () => {
  test("escapes reflected OAuth error params", () => {
    const html = renderOAuthErrorPage(
      '<script>alert("xss")</script>',
      '<img src=x onerror=alert("xss")>'
    );

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).not.toContain('<img src=x onerror=alert("xss")>');
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );
    expect(html).toContain("&lt;img src=x onerror=alert(&quot;xss&quot;)&gt;");
  });

  test("escapes provider name on success page", () => {
    const html = renderOAuthSuccessPage('"><svg onload=alert(1)>');

    expect(html).not.toContain('"><svg onload=alert(1)>');
    expect(html).toContain("&quot;&gt;&lt;svg onload=alert(1)&gt;");
  });

  test("drops unsafe settings URL on success page (does not render button)", () => {
    const html = renderOAuthSuccessPage(
      "Google",
      '"><script>alert(1)</script>'
    );

    // Unsafe href shapes (script tags, javascript:, data:, protocol-relative
    // `//evil.com`, backslash-prefixed paths) must not be rendered at all —
    // escaping is not enough because `escapeHtml` keeps `javascript:` intact.
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).not.toContain("Open Configuration");
  });

  test("renders safe http(s) and path-relative settings URLs", () => {
    const httpsHtml = renderOAuthSuccessPage(
      "Google",
      "https://example.com/settings"
    );
    expect(httpsHtml).toContain("Open Configuration");
    expect(httpsHtml).toContain("https://example.com/settings");

    const pathHtml = renderOAuthSuccessPage("Google", "/agents/foo/config");
    expect(pathHtml).toContain("Open Configuration");
    expect(pathHtml).toContain("/agents/foo/config");
  });

  test("rejects javascript: and protocol-relative settings URLs", () => {
    const jsHtml = renderOAuthSuccessPage("Google", "javascript:alert(1)");
    expect(jsHtml).not.toContain("javascript:");
    expect(jsHtml).not.toContain("Open Configuration");

    const protoRelHtml = renderOAuthSuccessPage("Google", "//evil.com/x");
    expect(protoRelHtml).not.toContain("Open Configuration");

    const backslashHtml = renderOAuthSuccessPage("Google", "/\\evil.com");
    expect(backslashHtml).not.toContain("Open Configuration");
  });
});

describe("OAuth setup recovery", () => {
  test("renders a setup problem without telling users to retry authentication", () => {
    const html = renderOAuthErrorPage("provider_not_configured", "Choose a connection option.", {
      title: "Connection setup required",
      actionUrl: "/workspace/connectors/example",
      actionLabel: "Back to connection options",
    });
    expect(html).toContain("Connection setup required");
    expect(html).toContain('href="/workspace/connectors/example"');
    expect(html).not.toContain("Authentication Failed");
    expect(html).not.toContain("try again");
  });

  test("escapes setup labels and rejects unsafe recovery URLs", () => {
    const html = renderOAuthErrorPage("setup", "description", {
      title: "<script>bad</script>",
      actionUrl: "javascript:alert(1)",
      actionLabel: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    // A rejected recovery URL must not leave the page with no way forward.
    expect(html).toContain("Return to Lobu to check the connection");
  });
});
