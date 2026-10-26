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

/** Read retained events in place; nothing here identifies anonymous visitors. */
export default class PosthogEventsConnector extends ConnectorRuntime {
  constructor(private readonly fetchImpl: FetchLike = fetch) {
    super();
  }
  readonly definition: RuntimeConnectorDefinition = {
    key: "posthog.events",
    name: "PostHog events",
    description:
      "Page through retained raw PostHog events. Query JSON requires start and end timestamps (at most 24 hours); continue with the returned cursor. Cookieless distinct IDs are daily estimates, not verified people.",
    version: "1.0.1",
    authSchema: {
      methods: [
        {
          type: "env_keys",
          scope: "connection",
          required: true,
          fields: [
            {
              key: "POSTHOG_API_KEY",
              label:
                "Personal API key with query:read for the selected project",
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
      required: ["api_host", "project_id"],
      properties: {
        api_host: {
          type: "string",
          enum: ["https://us.posthog.com", "https://eu.posthog.com"],
        },
        project_id: { type: "string", pattern: "^[0-9]+$" },
      },
    },
    feeds: {
      events: {
        key: "events",
        name: "Retained PostHog events",
        configSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        eventKinds: {
          analytics_event: { description: "A retained PostHog source event" },
        },
        read: async (ctx) => {
          const { api_host, project_id, POSTHOG_API_KEY } = ctx.config;
          if (
            !["https://us.posthog.com", "https://eu.posthog.com"].includes(
              String(api_host)
            ) ||
            !/^\d+$/.test(String(project_id))
          )
            throw new Error("Invalid PostHog host or project id");
          const range = logRange(ctx, JSON.stringify([api_host, project_id]));
          let where = `timestamp >= ${sqlString(range.start)} AND timestamp < ${sqlString(range.end)}`;
          if (range.after)
            where += ` AND (timestamp > ${sqlString(range.after.timestamp)} OR (timestamp = ${sqlString(range.after.timestamp)} AND uuid > ${sqlString(range.after.id)}))`;
          const response = await this.fetchImpl(
            `${api_host}/api/projects/${project_id}/query/`,
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(20000),
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${POSTHOG_API_KEY}`,
              },
              body: JSON.stringify({
                query: {
                  kind: "HogQLQuery",
                  query: `SELECT uuid, timestamp, event, properties FROM events WHERE ${where} ORDER BY timestamp, uuid LIMIT ${range.limit + 1}`,
                },
                refresh: "force_blocking",
              }),
            }
          );
          const body = await readLogJson(response);
          if (
            !Array.isArray(body.results) ||
            body.error ||
            (body.hasMore === true && body.results.length <= range.limit)
          )
            throw new Error("PostHog returned incomplete query results");
          const rows = body.results.map((row: unknown[]) => {
            if (!Array.isArray(row) || row.length !== 4)
              throw new Error("Unexpected PostHog row shape");
            return {
              uuid: row[0],
              timestamp: row[1],
              event: row[2],
              properties: row[3],
            };
          });
          return logPage(rows, range, "timestamp", "uuid");
        },
      },
    },
  };
}
