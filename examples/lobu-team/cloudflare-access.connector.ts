import {
  ConnectorRuntime,
  type RuntimeConnectorDefinition,
} from "@lobu/connector-sdk";
import {
  type FetchLike,
  logPage,
  logRange,
  readLogJson,
  sqlString,
} from "./website-log-read.ts";

export default class CloudflareAccessConnector extends ConnectorRuntime {
  constructor(private readonly fetchImpl: FetchLike = fetch) {
    super();
  }
  readonly definition: RuntimeConnectorDefinition = {
    key: "cloudflare.access",
    name: "Cloudflare access logs",
    description:
      "Read retained http_requests from a zone's enabled Log Explorer dataset. Requires Logs Read. No sampled analytics fallback or historical backfill before retention was enabled. Query JSON requires start/end timestamps (at most 24 hours); page using the cursor.",
    version: "1.0.1",
    authSchema: {
      methods: [
        {
          type: "env_keys",
          scope: "connection",
          required: true,
          fields: [
            {
              key: "CLOUDFLARE_API_TOKEN",
              label: "API token with zone Logs Read",
              secret: true,
              required: true,
            },
          ],
        },
      ],
    },
    optionsSchema: {
      type: "object",
      additionalProperties: false,
      required: ["zone_id", "hostname"],
      properties: {
        zone_id: { type: "string", pattern: "^[a-f0-9]{32}$" },
        hostname: { type: "string", minLength: 1, maxLength: 253 },
      },
    },
    feeds: {
      requests: {
        key: "requests",
        name: "Retained website HTTP requests",
        configSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        eventKinds: {
          http_request: {
            description:
              "A retained Cloudflare HTTP request, including source fields",
          },
        },
        read: async (ctx) => {
          const { zone_id, hostname, CLOUDFLARE_API_TOKEN } = ctx.config;
          if (
            !/^[a-f0-9]{32}$/.test(String(zone_id)) ||
            typeof hostname !== "string" ||
            !/^[a-z0-9.-]+$/i.test(hostname)
          )
            throw new Error("Invalid zone id or hostname");
          const range = logRange(ctx, JSON.stringify([zone_id, hostname]));
          let where = `date >= ${sqlString(range.start.slice(0, 10))} AND date <= ${sqlString(range.end.slice(0, 10))} AND edgestarttimestamp >= ${sqlString(range.start)} AND edgestarttimestamp < ${sqlString(range.end)} AND clientrequesthost = ${sqlString(hostname)}`;
          if (range.after)
            where += ` AND (edgestarttimestamp > ${sqlString(range.after.timestamp)} OR (edgestarttimestamp = ${sqlString(range.after.timestamp)} AND rayid > ${sqlString(range.after.id)}))`;
          const response = await this.fetchImpl(
            `https://api.cloudflare.com/client/v4/zones/${zone_id}/logs/explorer/query/sql`,
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(20000),
              headers: {
                "Content-Type": "text/plain",
                Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
              },
              body: `SELECT * FROM http_requests WHERE ${where} ORDER BY edgestarttimestamp, rayid LIMIT ${range.limit + 1}`,
            }
          );
          const body = await readLogJson(response);
          // The API schema declares `result` nullable, so null is an empty page.
          if (
            body.success !== true ||
            (body.result !== null && !Array.isArray(body.result))
          )
            throw new Error(
              "Cloudflare log query failed or returned an unexpected result"
            );
          return logPage(
            body.result ?? [],
            range,
            "edgestarttimestamp",
            "rayid"
          );
        },
      },
    },
  };
}
