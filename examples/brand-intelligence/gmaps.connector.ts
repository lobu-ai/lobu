/**
 * Google Maps Connector (V1 runtime) — example-only, not bundled with Lobu.
 *
 * Fetches business reviews using Google Places API.
 */

import {
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  createHttpClient,
  type EventEnvelope,
  finalizeTimestampSync,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

interface GMapsReview {
  author_name: string;
  author_url?: string;
  profile_photo_url?: string;
  rating: number;
  relative_time_description?: string;
  text: string;
  time: number;
}

interface PlaceDetailsResponse {
  status: string;
  result?: {
    name?: string;
    reviews?: GMapsReview[];
    url?: string;
  };
}

interface FindPlaceResponse {
  candidates?: Array<{ place_id: string }>;
}

const configSchema = {
  type: "object",
  properties: {
    place_id: {
      type: "string",
      description: "Google Place ID",
    },
    business_name: {
      type: "string",
      description: "Business name for search-based fallback",
    },
  },
};

export default class GoogleMapsConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "gmaps",
    name: "Google Maps",
    description: "Fetches business reviews using Google Places API.",
    version: "1.1.0",
    faviconDomain: "maps.google.com",
    authSchema: {
      methods: [
        {
          type: "env_keys",
          required: true,
          fields: [
            {
              key: "GOOGLE_MAPS_API_KEY",
              label: "Google Maps API Key",
              secret: true,
            },
          ],
        },
      ],
    },
    feeds: {
      reviews: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "reviews",
        name: "Business Reviews",
        description: "Fetch reviews for a business on Google Maps.",
        configSchema,
        eventKinds: {
          review: {
            description: "A Google Maps business review",
            metadataSchema: {
              type: "object",
              properties: {
                rating: { type: "number", description: "Star rating (1-5)" },
                author_url: { type: "string", format: "uri" },
                profile_photo_url: { type: "string", format: "uri" },
                relative_time_description: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  // Google Places authenticates via the `key` query param, not a bearer header,
  // so the client carries no token — it's adopted purely for retry/backoff on
  // transient 429/5xx and consistent error formatting.
  private readonly http = createHttpClient({ errorPrefix: "Google Places" });

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const apiKey = ctx.config.GOOGLE_MAPS_API_KEY as string | undefined;
    if (!apiKey) {
      throw new Error("GOOGLE_MAPS_API_KEY is required");
    }

    let placeId = ctx.config.place_id as string | undefined;
    const businessName = ctx.config.business_name as string | undefined;

    if (!placeId && !businessName) {
      throw new Error("Either place_id or business_name is required");
    }

    // If no place_id, search by business name
    if (!placeId && businessName) {
      const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(businessName)}&inputtype=textquery&fields=place_id&key=${apiKey}`;
      const searchResponse = await this.http.raw(searchUrl);
      if (!searchResponse.ok) {
        throw new Error(
          `Google Places search failed (${searchResponse.status}): ${await searchResponse.text()}`
        );
      }
      const searchData = (await searchResponse.json()) as FindPlaceResponse;
      if (!searchData.candidates || searchData.candidates.length === 0) {
        throw new Error(`Business not found: ${businessName}`);
      }
      placeId = searchData.candidates[0].place_id;
    }

    // Fetch place details with reviews
    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,reviews,url&key=${apiKey}`;
    const detailsResponse = await this.http.raw(detailsUrl);
    if (!detailsResponse.ok) {
      throw new Error(
        `Google Places details failed (${detailsResponse.status}): ${await detailsResponse.text()}`
      );
    }
    const data = (await detailsResponse.json()) as PlaceDetailsResponse;

    if (data.status !== "OK") {
      throw new Error(`Google Places API error: ${data.status}`);
    }

    const place = data.result;
    const reviews = place?.reviews ?? [];
    const placeUrl =
      place?.url ?? `https://maps.google.com/?q=place_id:${placeId}`;

    // Transform reviews to EventEnvelope[] — skip reviews without text
    const events: EventEnvelope[] = reviews
      .filter((review) => review.text)
      .map((review) => ({
        origin_id: `${placeId}_${review.time}`,
        payload_text: review.text,
        author_name: review.author_name || undefined,
        occurred_at: new Date(review.time * 1000),
        origin_type: "review",
        source_url: placeUrl,
        score: calculateEngagementScore("gmaps", { rating: review.rating }),
        metadata: {
          rating: review.rating,
          author_url: review.author_url,
          profile_photo_url: review.profile_photo_url,
          relative_time_description: review.relative_time_description,
        },
      }));

    const { events: emitted, checkpoint: newCheckpoint } =
      finalizeTimestampSync(events, ctx.checkpoint);

    await ctx.commit(emitted, newCheckpoint);
    return {
      status: "complete",
      metadata: {
        items_found: reviews.length,
      },
    };
  }
}
