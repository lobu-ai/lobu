/**
 * Website Connector
 *
 * Fetches web pages over HTTP and converts them to markdown.
 * Supports sitemap.xml discovery or explicit URL list.
 * Converts HTML → Markdown, splits into hierarchical sections.
 * Tracks changes between syncs via content hashing.
 * The `pages` feed also reads ONE public URL live (`query`), returning the same
 * rows a sync of that URL would emit, without persisting them.
 *
 * Server-side rendered HTML only. The connector runs in a V8 isolate with no
 * browser behind it, so a page whose content is painted by client-side JS
 * yields whatever its server response contains. That is the whole crawl
 * surface: every feed here reads public marketing and docs pages, which are
 * served as HTML.
 */

import { createHash } from "node:crypto";
import TurndownService from "turndown";
import {
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type FeedReadContext,
  type FeedReadResult,
  sleep,
  type SyncContext,
  type SyncResult,
  validatePublicUrl,
} from "@lobu/connector-sdk";

interface ExtractedPage {
  finalUrl: string;
  markdown: string;
  meta: { title?: string; description?: string; ogImage?: string };
  contentHash: string;
}

/**
 * A failure carrying an HTTP status. The isolate forwards `status`, and the
 * platform classifies it into the read result's typed `error_code`.
 */
function sourceError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

interface PageSection {
  heading: string;
  level: number;
  content: string;
  anchor: string;
}

function ariaLabel(node: Element): string {
  return (
    node
      .getAttribute("aria-labelledby")
      ?.trim()
      .split(/\s+/)
      .map((id) => node.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim() ||
    node.getAttribute("aria-label")?.trim() ||
    ""
  );
}

export default class WebsiteConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "website",
    name: "Website",
    description:
      "Fetches web pages over HTTP. Supports sitemap.xml for auto-discovery. Converts to markdown sections and tracks changes.",
    version: "2.2.0",
    faviconDomain: "google.com",
    authSchema: {
      methods: [{ type: "none" }],
    },
    feeds: {
      pages: {
        sync: (ctx) => this.syncFeed(ctx),
        read: (ctx) => this.readPage(ctx),
        key: "pages",
        name: "Web Pages",
        description:
          "Scrape and parse web pages into structured content. A source read takes one public http(s) page URL as query and returns that page's rows, the same rows a sync of that URL emits, without crawling or a sitemap.",
        configSchema: {
          type: "object",
          properties: {
            sitemap_url: {
              type: "string",
              format: "uri",
              description:
                "URL to sitemap.xml. All URLs from the sitemap will be scraped. Takes priority over urls.",
            },
            urls: {
              type: "array",
              items: { type: "string", format: "uri" },
              description:
                "Explicit list of URLs to scrape. Ignored if sitemap_url is set.",
            },
            max_pages: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 20,
              description:
                "Maximum number of pages to scrape per sync (default: 20)",
            },
            parse_sections: {
              type: "boolean",
              default: true,
              description:
                "Split page into sections by headings (h1-h3). If false, one event per page.",
            },
          },
        },
        eventKinds: {
          page: {
            description: "Full page content",
            metadataSchema: {
              type: "object",
              properties: {
                content_hash: { type: "string" },
                meta_title: { type: "string" },
                meta_description: { type: "string" },
                og_image: { type: "string" },
                word_count: { type: "number" },
              },
            },
          },
          section: {
            description: "A section of a page (split by headings)",
            metadataSchema: {
              type: "object",
              properties: {
                heading: { type: "string" },
                heading_level: { type: "number" },
                anchor: { type: "string" },
                section_index: { type: "number" },
                page_url: { type: "string" },
                content_hash: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  private turndown: TurndownService;
  private readonly PAGE_TIMEOUT = 30000;
  private readonly PAGE_DELAY_MS = 2000;

  constructor() {
    super();
    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    // Apply removals during DOM traversal so referenced labels and controls
    // remain available when the enclosing consent container is classified.
    const nonContentTags = new Set([
      "head",
      "title",
      "script",
      "style",
      "noscript",
      "nav",
      "header",
      "footer",
      "aside",
      "iframe",
      "svg",
      "canvas",
      "video",
      "audio",
      "menu",
      "dialog",
      "embed",
      "object",
      "applet",
      "input",
      "link",
      "meta",
    ]);
    this.turndown.remove((node) =>
      nonContentTags.has(node.nodeName.toLowerCase())
    );
    // Remove the consent UI itself. Cookie or marketing vocabulary in the
    // surrounding page is business content, not evidence that the page is a banner.
    this.turndown.addRule("cookieConsent", {
      filter: (node) => {
        const role = node.getAttribute("role")?.toLowerCase();
        const label = ariaLabel(node);
        const consentRegion =
          role === "region" &&
          Array.from(
            node.querySelectorAll(
              'button, input[type="button"], input[type="submit"], [role="button"]'
            )
          ).some((control) =>
            /^(accept|allow|reject|deny)( all)?( cookies)?$/i.test(
              (
                ariaLabel(control) ||
                (control.nodeName === "INPUT"
                  ? control.getAttribute("value")
                  : control.textContent) ||
                ""
              )
                .replace(/\s+/g, " ")
                .trim()
            )
          );
        return (
          ((["dialog", "alertdialog"].includes(role ?? "") || consentRegion) &&
            /^cookies?\s+(consent|preferences|notice|settings)$/i.test(
              label
            )) ||
          [node.id, ...(node.getAttribute("class") ?? "").split(/\s+/)].some(
            (token) =>
              /^(onetrust-(consent|banner)-sdk|CybotCookiebotDialog|cookie[-_]?banner)$/i.test(
                token
              )
          )
        );
      },
      replacement: () => "",
    });
  }

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const sitemapUrl = ctx.config.sitemap_url as string | undefined;
    const explicitUrls = ctx.config.urls as string[] | undefined;
    const maxPages = (ctx.config.max_pages as number) ?? 20;
    const parseSections = (ctx.config.parse_sections as boolean) ?? true;
    const previousHashes =
      (ctx.checkpoint?.hashes as Record<string, string>) ?? {};

    // Resolve URLs from sitemap or explicit list
    let urls: string[];
    if (sitemapUrl) {
      validatePublicUrl(sitemapUrl);
      urls = await this.fetchSitemap(sitemapUrl);
    } else if (explicitUrls?.length) {
      urls = explicitUrls;
    } else {
      return {
        status: "complete",
        metadata: { error: "No sitemap_url or urls configured" },
      };
    }

    urls = urls.slice(0, maxPages);

    const events: EventEnvelope[] = [];
    const newHashes: Record<string, string> = {};

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        validatePublicUrl(url);
        const page = await this.extractPage(url);
        if (!page) continue;

        if (previousHashes[url] === page.contentHash) {
          newHashes[url] = page.contentHash;
          continue;
        }
        newHashes[url] = page.contentHash;

        for (const { key, hash, event } of this.pageEvents(
          url,
          page,
          parseSections
        )) {
          // Only sections carry their own unchanged-content skip; the page
          // event's skip is the page-level hash above.
          if (key !== url && previousHashes[key] === hash) {
            newHashes[key] = hash;
            continue;
          }
          newHashes[key] = hash;
          events.push(event);
        }
      } catch {
        // Best-effort per-URL fetch; continue with remaining URLs.
      }

      if (i < urls.length - 1) {
        await sleep(this.PAGE_DELAY_MS);
      }
    }

    await ctx.commit(events, {
      hashes: newHashes,
      last_sync_at: new Date().toISOString(),
    });
    return {
      status: "complete",
      metadata: { pages_scraped: urls.length, events_created: events.length },
    };
  }
  /**
   * Source read: `query` is exactly one public http(s) URL. Fetches that page
   * only (no sitemap, no other URLs, no inter-page delay) and returns the rows
   * a sync of the same URL would emit under this feed's config, so identity
   * (`origin_id`), text and `content_hash` agree across both operations. The
   * platform's read deadline bounds the call: it aborts the host fetch and
   * ends the isolate, and the per-page cap below never exceeds the longest
   * read budget. A page with no content returns no rows.
   */
  private async readPage(ctx: FeedReadContext): Promise<FeedReadResult> {
    const url = typeof ctx.query === "string" ? ctx.query : "";
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    if (
      !url ||
      url !== url.trim() ||
      /\s/.test(url) ||
      !parsed ||
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    ) {
      throw sourceError(
        400,
        "Website read query must be exactly one http(s) page URL"
      );
    }
    try {
      validatePublicUrl(url);
    } catch (error) {
      throw sourceError(
        400,
        error instanceof Error ? error.message : String(error)
      );
    }
    const page = await this.extractPage(url);
    const parseSections = (ctx.config.parse_sections as boolean) ?? true;
    const rows = page
      ? this.pageEvents(url, page, parseSections).map(({ event }) => event)
      : [];
    const offset = Math.max(0, Math.trunc(ctx.offset ?? 0));
    const limit = Math.max(1, Math.trunc(ctx.limit ?? rows.length));
    return {
      rows: rows.slice(offset, offset + limit) as unknown as Record<
        string,
        unknown
      >[],
      total: rows.length,
      hasMore: offset + limit < rows.length,
    };
  }

  /** Fetch one page and extract its markdown, or null when it has no content. */
  private async extractPage(url: string): Promise<ExtractedPage | null> {
    const { html, finalUrl } = await this.fetchPage(url);
    const markdown = this.deduplicateMarkdown(
      this.turndown.turndown(html).trim()
    );
    if (!markdown) return null;
    return {
      finalUrl,
      markdown,
      meta: this.extractMeta(html),
      contentHash: this.hash(markdown),
    };
  }

  /**
   * The events one page yields, each with the checkpoint key and hash a sync
   * records for it. Identity derives from the requested URL, never the
   * redirect target, so a sync and a read of the same URL agree.
   */
  private pageEvents(
    url: string,
    page: ExtractedPage,
    parseSections: boolean
  ): { key: string; hash: string; event: EventEnvelope }[] {
    const { finalUrl, markdown, meta, contentHash } = page;
    if (!parseSections) {
      return [
        {
          key: url,
          hash: contentHash,
          event: {
            origin_id: `web_page_${this.hash(url)}`,
            title: meta.title || finalUrl,
            payload_text: markdown,
            source_url: finalUrl,
            occurred_at: new Date(),
            origin_type: "page",
            semantic_type: "page",
            score: 50,
            metadata: {
              content_hash: contentHash,
              meta_title: meta.title,
              meta_description: meta.description,
              og_image: meta.ogImage,
              word_count: markdown.split(/\s+/).length,
            },
          },
        },
      ];
    }
    return this.parseSections(markdown).map((section, si) => {
      const sectionHash = this.hash(section.content);
      const sectionKey = `${url}#${section.anchor}`;
      const parentKey = section.parentAnchor
        ? `${url}#${section.parentAnchor}`
        : undefined;
      return {
        key: sectionKey,
        hash: sectionHash,
        event: {
          origin_id: `web_section_${this.hash(sectionKey)}`,
          title: section.heading,
          payload_text: section.content,
          source_url: `${finalUrl}#${section.anchor}`,
          occurred_at: new Date(),
          origin_type: "section",
          semantic_type: "section",
          score: 50,
          origin_parent_id: parentKey
            ? `web_section_${this.hash(parentKey)}`
            : undefined,
          metadata: {
            heading: section.heading,
            heading_level: section.level,
            anchor: section.anchor,
            section_index: si,
            page_url: finalUrl,
            content_hash: sectionHash,
          },
        },
      };
    });
  }

  /**
   * Fetch one page's HTML.
   *
   * `redirect: "follow"` matters: the markdown, the section anchors and every
   * `source_url` are keyed off the URL the server actually served, not the one
   * configured, so a site that redirects `/x` to `/x/` does not churn a whole
   * page's worth of sections on every sync.
   */
  private async fetchPage(
    url: string
  ): Promise<{ html: string; finalUrl: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.PAGE_TIMEOUT);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LobuBot/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!response.ok) {
        throw sourceError(
          response.status,
          `Page fetch failed: HTTP ${response.status}`
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !/\b(html|xml)\b/i.test(contentType)) {
        throw sourceError(
          415,
          `Page is not HTML (content-type: ${contentType})`
        );
      }
      return { html: await response.text(), finalUrl: response.url || url };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Deduplicate repeated lines in markdown output.
   * Animation containers and responsive layouts often produce identical image
   * or link lines multiple times. This keeps the first occurrence of each.
   */
  private deduplicateMarkdown(markdown: string): string {
    const lines = markdown.split("\n");
    const seen = new Set<string>();
    const result: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Only dedup substantial lines (short lines like blank lines or list markers are fine to repeat)
      if (trimmed.length >= 80) {
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
      }
      result.push(line);
    }
    return result.join("\n");
  }

  private async fetchSitemap(sitemapUrl: string, depth = 0): Promise<string[]> {
    // Sitemap-index recursion bound — caps fan-out from a remote sitemap that
    // links to a sitemap that links to a sitemap... untrusted XML must not
    // drive unbounded outbound traffic.
    if (depth > 2) return [];
    const response = await fetch(sitemapUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LobuBot/1.0)" },
    });

    if (!response.ok) {
      throw new Error(`Sitemap fetch failed: HTTP ${response.status}`);
    }

    const xml = await response.text();
    const urls: string[] = [];

    // Parse <loc> tags from sitemap XML
    const locPattern = /<loc>\s*(.*?)\s*<\/loc>/gi;
    let match = locPattern.exec(xml);
    while (match !== null) {
      const url = match[1].trim();
      // Skip non-HTML resources and anchor fragment URLs
      if (
        url &&
        !url.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|xml|json|zip|gz)$/i) &&
        !url.includes("#")
      ) {
        urls.push(url);
      }
      match = locPattern.exec(xml);
    }

    // Handle sitemap index (sitemaps linking to other sitemaps)
    if (urls.length === 0) {
      const sitemapPattern = /<sitemap>\s*<loc>\s*(.*?)\s*<\/loc>/gi;
      const childSitemaps: string[] = [];
      match = sitemapPattern.exec(xml);
      while (match !== null) {
        childSitemaps.push(match[1].trim());
        match = sitemapPattern.exec(xml);
      }
      for (const childUrl of childSitemaps.slice(0, 5)) {
        validatePublicUrl(childUrl);
        const childUrls = await this.fetchSitemap(childUrl, depth + 1);
        urls.push(...childUrls);
      }
    }

    return urls;
  }

  private extractMeta(html: string): {
    title?: string;
    description?: string;
    ogImage?: string;
  } {
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    const descMatch =
      html.match(
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
      ) ||
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i
      );
    const ogMatch =
      html.match(
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
      ) ||
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
      );

    return {
      title: titleMatch?.[1]?.trim(),
      description: descMatch?.[1]?.trim(),
      ogImage: ogMatch?.[1]?.trim(),
    };
  }

  private parseSections(
    markdown: string
  ): (PageSection & { parentAnchor?: string })[] {
    const lines = markdown.split("\n");
    const sections: (PageSection & { parentAnchor?: string })[] = [];
    let currentHeading = "Introduction";
    let currentLevel = 1;
    let currentLines: string[] = [];

    // Per-slug counters so anchors stay stable when unrelated sections change.
    // Only incremented when a section is emitted, not for heading stack entries.
    const slugCounts = new Map<string, number>();

    const makeAnchor = (heading: string): string => {
      const slug = this.slugify(heading);
      const count = slugCounts.get(slug) ?? 0;
      slugCounts.set(slug, count + 1);
      return count === 0 ? slug : `${slug}-${count}`;
    };

    // Track parent heading stack for hierarchy.
    // Anchors are assigned lazily when the heading's section is emitted.
    const headingStack: { heading: string; level: number; anchor?: string }[] =
      [];

    const emitSection = (heading: string, level: number, content: string) => {
      const anchor = makeAnchor(heading);
      // Update the heading stack entry for this heading so children can reference it
      const stackEntry = headingStack.find(
        (e) => e.heading === heading && e.anchor === undefined
      );
      if (stackEntry) stackEntry.anchor = anchor;
      const parent =
        headingStack.length > 0
          ? headingStack[headingStack.length - 1]
          : undefined;
      const parentAnchor =
        parent?.heading === heading ? undefined : parent?.anchor;
      sections.push({ heading, level, content, anchor, parentAnchor });
    };

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        const content = currentLines.join("\n").trim();
        if (content.length > 0) {
          emitSection(currentHeading, currentLevel, content);
        }

        const newLevel = headingMatch[1].length;
        const newHeading = headingMatch[2].trim();

        // Pop stack until we find a parent with a lower level
        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1].level >= newLevel
        ) {
          headingStack.pop();
        }
        headingStack.push({ heading: newHeading, level: newLevel });

        currentHeading = newHeading;
        currentLevel = newLevel;
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    const content = currentLines.join("\n").trim();
    if (content.length > 0) {
      emitSection(currentHeading, currentLevel, content);
    }

    return sections;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 60);
  }

  private hash(text: string): string {
    return createHash("sha256").update(text).digest("hex").substring(0, 16);
  }
}
