import type { DeviceConnectorSpec } from "@lobu/connector-sdk";
import {
  macComputerUseActions,
  withComputerUseStatus,
} from "./mac-computer-use.js";

const expectedReminderState = {
  type: "object",
  description:
    "The reminder state this write was decided from, as read from the sync feed. Any listed field that no longer matches refuses the write without changing anything.",
  properties: {
    title: { type: "string" },
    due: {
      type: ["string", "null"],
      format: "date-time",
      description: "Null expects no due date.",
    },
    completed: { type: "boolean" },
  },
  additionalProperties: false,
};

/**
 * Canonical TypeScript source for the Mac-only device connector metadata. The
 * Mac app implements every entry natively; this package contains no executable
 * handlers. Connectors shared with another platform are authored separately
 * (see `os-shell.ts`) so both endpoints serialize the identical contract.
 */
export const macDeviceConnectorSpecs: readonly DeviceConnectorSpec[] = [
  {
    key: "apple.screen_time",
    version: "0.2.0",
    name: "Apple Screen Time",
    description:
      "Daily per-app usage totals from Lobu for Mac, sourced from the Apple Knowledge store. Captures both Mac usage and (if Screen Time iCloud sync is on) the user's iOS device usage.",
    faviconDomain: "apple.com",
    requiredCapability: "screentime",
    runtime: {
      platforms: ["macos"],
    },
    authSchema: {
      methods: [
        {
          type: "none",
        },
      ],
    },
    feeds: {
      daily_app_usage: {
        key: "daily_app_usage",
        name: "Daily app usage",
        operations: ["sync", "read"],
        description:
          "Per-day total foreground time for each application (identified by bundle id).",
        configSchema: {
          type: "object",
          properties: {
            backfill_days: {
              type: "integer",
              minimum: 1,
              maximum: 90,
              default: 14,
              description:
                "How many days the bridge should backfill on each sync.",
            },
          },
        },
        eventKinds: {
          screen_time_daily_app: {
            description:
              "Total time the user spent in one application on a given day.",
            metadataSchema: {
              type: "object",
              required: ["source", "origin_id", "date", "bundle_id", "seconds"],
              properties: {
                source: {
                  type: "string",
                  const: "apple_screen_time",
                },
                origin_id: {
                  type: "string",
                },
                date: {
                  type: "string",
                  format: "date",
                },
                bundle_id: {
                  type: "string",
                },
                seconds: {
                  type: "number",
                  minimum: 0,
                },
              },
            },
          },
        },
      },
    },
  },
  {
    key: "apple.health",
    version: "0.2.0",
    name: "Apple Health",
    description:
      "Sync Apple Health daily activity summaries and workouts from Lobu on your device. macOS reads HealthKit data synced from the user's iPhone (and Apple Watch) via iCloud Health.",
    faviconDomain: "apple.com",
    requiredCapability: "healthkit",
    runtime: {
      platforms: ["ios", "macos"],
      scopes: [
        "steps",
        "distance",
        "active-calories",
        "exercise-minutes",
        "workouts",
        "resting-heart-rate",
      ],
    },
    authSchema: {
      methods: [
        {
          type: "none",
        },
      ],
    },
    feeds: {
      daily_summaries: {
        key: "daily_summaries",
        name: "Daily summaries",
        operations: ["sync", "read"],
        description:
          "Daily Apple Health activity summaries: steps, distance, active energy, exercise minutes, and resting heart rate.",
        configSchema: {
          type: "object",
          properties: {
            backfill_days: {
              type: "integer",
              minimum: 1,
              maximum: 3650,
              default: 30,
              description:
                "How many days the bridge backfills on a fresh sync (incremental syncs only re-query changed days).",
            },
          },
        },
        eventKinds: {
          health_daily_summary: {
            description: "A daily summary of Apple Health activity data.",
            metadataSchema: {
              type: "object",
              required: ["source", "origin_id", "date"],
              properties: {
                source: {
                  type: "string",
                  const: "apple_health",
                },
                origin_id: {
                  type: "string",
                },
                date: {
                  type: "string",
                  format: "date",
                },
                steps: {
                  type: "number",
                },
                distance_m: {
                  type: "number",
                },
                active_energy_kcal: {
                  type: "number",
                },
                exercise_minutes: {
                  type: "number",
                },
                resting_heart_rate_bpm: {
                  type: ["number", "null"],
                },
              },
            },
          },
        },
      },
      workouts: {
        key: "workouts",
        name: "Workouts",
        operations: ["sync", "read"],
        description: "Workout sessions recorded in Apple Health.",
        configSchema: {
          type: "object",
          properties: {
            backfill_days: {
              type: "integer",
              minimum: 1,
              maximum: 3650,
              default: 30,
              description:
                "How many days the bridge backfills on a fresh sync.",
            },
          },
        },
        eventKinds: {
          health_workout: {
            description: "A workout recorded in Apple Health.",
            metadataSchema: {
              type: "object",
              required: ["source", "origin_id", "workout_type"],
              properties: {
                source: {
                  type: "string",
                  const: "apple_health",
                },
                origin_id: {
                  type: "string",
                },
                workout_type: {
                  type: "string",
                },
                started_at: {
                  type: "string",
                },
                duration_s: {
                  type: "number",
                },
                active_energy_kcal: {
                  type: ["number", "null"],
                },
                distance_m: {
                  type: ["number", "null"],
                },
              },
            },
          },
        },
      },
    },
  },
  {
    key: "apple.photos",
    version: "0.1.1",
    name: "Apple Photos",
    description:
      "Sync the metadata PhotoKit exposes for photos and optional videos on this Mac: dates, dimensions, location, albums, media subtype, and favorite or hidden state.",
    faviconDomain: "apple.com",
    requiredCapability: "photos",
    runtime: {
      platforms: ["macos"],
      scopes: ["date", "location", "albums"],
    },
    authSchema: {
      methods: [
        {
          type: "none",
        },
      ],
    },
    feeds: {
      library: {
        key: "library",
        name: "Library",
        operations: ["sync"],
        description:
          "PhotoKit assets in the configured backfill window. Events include dates, dimensions, location, album membership, media subtype, favorite and hidden state, and stable per-device asset identifiers.",
        configSchema: {
          type: "object",
          properties: {
            backfill_days: {
              type: "integer",
              minimum: 1,
              maximum: 36500,
              default: 3650,
              description:
                "How many days back the bridge backfills on a fresh sync. Default 10 years; incremental runs only re-query the modification window since last_sync_at.",
            },
            include_screenshots: {
              type: "boolean",
              default: true,
              description:
                "Include screenshots (PHAssetMediaSubtype.photoScreenshot).",
            },
            include_videos: {
              type: "boolean",
              default: false,
              description: "Include video assets in addition to photos.",
            },
          },
        },
        eventKinds: {
          photo: {
            description:
              "A single photo (or video, if enabled) from the user's Apple Photos library. The bridge populates what PhotoKit's public API exposes: asset_local_id, media_type, media_subtypes, date_taken, date_modified, width, height, duration_s, latitude/longitude/altitude_m, albums, is_favorite, is_hidden. place_name is added server-side by geo enrichment from latitude/longitude.",
            metadataSchema: {
              type: "object",
              required: ["source", "origin_id", "asset_local_id"],
              properties: {
                source: {
                  type: "string",
                  const: "apple_photos",
                },
                origin_id: {
                  type: "string",
                },
                asset_local_id: {
                  type: "string",
                  description:
                    "PHAsset.localIdentifier — stable per-device handle.",
                },
                media_type: {
                  type: "string",
                  enum: ["image", "video", "audio", "unknown"],
                },
                media_subtypes: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description:
                    "PHAssetMediaSubtype flags: live, hdr, screenshot, panorama, portrait, etc.",
                },
                date_taken: {
                  type: ["string", "null"],
                  format: "date-time",
                },
                date_modified: {
                  type: ["string", "null"],
                  format: "date-time",
                },
                width: {
                  type: ["integer", "null"],
                },
                height: {
                  type: ["integer", "null"],
                },
                duration_s: {
                  type: ["number", "null"],
                  description:
                    "Duration in seconds — videos and Live Photos only.",
                },
                latitude: {
                  type: ["number", "null"],
                },
                longitude: {
                  type: ["number", "null"],
                },
                altitude_m: {
                  type: ["number", "null"],
                },
                place_name: {
                  type: ["string", "null"],
                  description:
                    "Nearest place name, filled in server-side by geo enrichment from latitude/longitude.",
                },
                albums: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description: "User album names this asset belongs to.",
                },
                is_favorite: {
                  type: "boolean",
                },
                is_hidden: {
                  type: "boolean",
                },
              },
            },
          },
        },
      },
    },
  },
  {
    key: "apple.calendar",
    version: "0.2.0",
    name: "Calendar",
    description:
      "Sync your calendar events (titles, times, locations, attendees) from this Mac via Lobu for Mac. Events stay on the device.",
    faviconDomain: "apple.com",
    requiredCapability: "calendar",
    runtime: {
      platforms: ["macos"],
    },
    authSchema: {
      methods: [
        {
          type: "none",
        },
      ],
    },
    feeds: {
      events: {
        key: "events",
        name: "Events",
        operations: ["sync", "read"],
        description:
          "Calendar events from the Mac, in a rolling window around now.",
        configSchema: {
          type: "object",
          properties: {},
        },
        eventKinds: {
          calendar_event: {
            description: "A single calendar event occurrence.",
            metadataSchema: {
              type: "object",
              required: ["source", "origin_id", "start"],
              properties: {
                source: {
                  type: "string",
                  const: "apple_calendar",
                },
                origin_id: {
                  type: "string",
                },
                calendar: {
                  type: "string",
                },
                start: {
                  type: "string",
                },
                end: {
                  type: "string",
                },
                all_day: {
                  type: "boolean",
                },
                location: {
                  type: "string",
                },
                organizer: {
                  type: "string",
                },
                attendee_count: {
                  type: "integer",
                },
              },
            },
          },
        },
      },
    },
  },
  {
    key: "apple.reminders",
    version: "0.4.0",
    name: "Reminders",
    description:
      "Sync your reminders (titles, notes, due dates, completion) from this Mac via Lobu for Mac. Reminders stay on the device.",
    faviconDomain: "apple.com",
    requiredCapability: "reminders",
    runtime: {
      platforms: ["macos"],
    },
    authSchema: {
      methods: [
        {
          type: "none",
        },
      ],
    },
    feeds: {
      reminders: {
        key: "reminders",
        name: "Reminders",
        operations: ["sync", "read"],
        description:
          "Reminders from the Mac — incomplete plus recently completed.",
        configSchema: {
          type: "object",
          properties: {},
        },
        eventKinds: {
          reminder: {
            description: "A single reminder.",
            metadataSchema: {
              type: "object",
              required: ["source", "origin_id", "completed"],
              properties: {
                source: {
                  type: "string",
                  const: "apple_reminders",
                },
                origin_id: {
                  type: "string",
                },
                list: {
                  type: "string",
                },
                completed: {
                  type: "boolean",
                },
                due: {
                  type: "string",
                },
                completed_at: {
                  type: "string",
                },
                priority: {
                  type: "integer",
                },
              },
            },
          },
        },
      },
    },
    actions: {
      create_reminder: {
        key: "create_reminder",
        name: "Create reminder",
        description:
          "Create a reminder in Apple Reminders on this Mac (syncs via the user's iCloud to their other devices). Returns the origin_id for later update/complete/delete calls.",
        kind: "write",
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description: "Reminder title.",
            },
            notes: {
              type: "string",
              maxLength: 4000,
              description: "Optional notes body.",
            },
            due: {
              type: "string",
              format: "date-time",
              description:
                "Optional due date as ISO 8601 (e.g. 2026-10-14T09:00:00+01:00).",
            },
            list: {
              type: "string",
              maxLength: 200,
              description:
                "Target reminder list by name. Defaults to the system default list when omitted or unmatched.",
            },
            priority: {
              type: "integer",
              minimum: 0,
              maximum: 9,
              description:
                "EventKit priority 0 (none) through 9 (lowest); 1 is highest. Defaults to 0.",
            },
          },
          required: ["title"],
          additionalProperties: false,
        },
        outputSchema: { type: "object", additionalProperties: true },
      },
      update_reminder: {
        key: "update_reminder",
        name: "Update reminder",
        description:
          "Update title, notes, due date, list, or priority of an existing reminder. Only supplied fields change.",
        kind: "write",
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            origin_id: {
              type: "string",
              minLength: 1,
              description:
                "Reminder identity as returned by create_reminder or the sync feed (the 'reminder:<identifier>' origin_id or the bare calendar item identifier).",
            },
            title: {
              type: "string",
              minLength: 1,
              maxLength: 500,
            },
            notes: {
              type: ["string", "null"],
              maxLength: 4000,
              description: "Null clears the notes.",
            },
            due: {
              type: ["string", "null"],
              format: "date-time",
              description: "ISO 8601 due date. Null clears the due date.",
            },
            list: {
              type: "string",
              maxLength: 200,
              description: "Move the reminder to the named list.",
            },
            priority: {
              type: "integer",
              minimum: 0,
              maximum: 9,
            },
            expected: expectedReminderState,
          },
          required: ["origin_id"],
          additionalProperties: false,
        },
        outputSchema: { type: "object", additionalProperties: true },
      },
      complete_reminder: {
        key: "complete_reminder",
        name: "Complete reminder",
        description:
          "Mark a reminder completed (or, with completed:false, reopen it).",
        kind: "write",
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            origin_id: {
              type: "string",
              minLength: 1,
              description:
                "Reminder identity as returned by create_reminder or the sync feed.",
            },
            completed: {
              type: "boolean",
              default: true,
              description: "False reopens a completed reminder.",
            },
            expected: expectedReminderState,
          },
          required: ["origin_id"],
          additionalProperties: false,
        },
        outputSchema: { type: "object", additionalProperties: true },
      },
      delete_reminder: {
        key: "delete_reminder",
        name: "Delete reminder",
        description:
          "Permanently delete a reminder. Prefer complete_reminder when the user may want history.",
        kind: "write",
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            origin_id: {
              type: "string",
              minLength: 1,
              description:
                "Reminder identity as returned by create_reminder or the sync feed.",
            },
          },
          required: ["origin_id"],
          additionalProperties: false,
        },
        outputSchema: { type: "object", additionalProperties: true },
      },
    },
  },
  {
    key: "apple.computer_use",
    version: "0.2.2",
    name: "Mac Computer Use",
    description:
      "Observe and control this Mac through Lobu for Mac. Uses native macOS Screen Recording and Accessibility APIs in-process. Screenshots/UI trees stay on-device until an explicit action returns them.",
    faviconDomain: "apple.com",
    requiredCapability: "computer_use",
    runtime: {
      platforms: ["macos"],
    },
    authSchema: {
      methods: [
        {
          type: "none",
        },
      ],
    },
    feeds: {},
    actions: withComputerUseStatus({
      ...macComputerUseActions,
      permissions: {
        key: "permissions",
        kind: "read",
        name: "Check permissions",
        description:
          "Return Screen Recording, Accessibility, and Event Synthesizing permission status for this Mac.",
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      list_apps: {
        key: "list_apps",
        kind: "read",
        name: "List running apps",
        description:
          "List running macOS applications visible to the automation layer.",
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      list_windows: {
        key: "list_windows",
        kind: "read",
        name: "List windows",
        description:
          "List windows for an app, or the frontmost app when app is omitted.",
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object",
          properties: {
            app: {
              type: "string",
              description:
                "Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.",
            },
            include_offscreen: {
              type: "boolean",
              default: false,
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      screenshot: {
        key: "screenshot",
        kind: "read",
        name: "Take screenshot",
        description:
          "Capture a screen/window/frontmost app and return PNG bytes as base64 plus metadata.",
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              enum: ["frontmost", "screen", "window"],
              default: "frontmost",
            },
            app: {
              type: "string",
              description:
                "Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.",
            },
            window_id: {
              type: "integer",
            },
            screen_index: {
              type: "integer",
            },
            retina: {
              type: "boolean",
              default: false,
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      observe: {
        key: "observe",
        name: "Observe UI",
        description:
          "Capture the target and inspect its accessibility tree. Returns screenshot metadata, optional PNG base64, UI elements, and a snapshot_id for later element-targeted actions.",
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "object",
              properties: {
                app: {
                  type: "string",
                  description:
                    "Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.",
                },
                window_id: {
                  type: "integer",
                  description: "CoreGraphics window id.",
                },
                window_index: {
                  type: "integer",
                  description: "0-based window index within app.",
                },
                window_title: {
                  type: "string",
                  description: "Substring of target window title.",
                },
              },
              additionalProperties: false,
            },
            include_screenshot: {
              type: "boolean",
              default: true,
            },
            include_image_base64: {
              type: "boolean",
              default: false,
            },
            max_elements: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              default: 200,
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      click: {
        key: "click",
        name: "Click",
        description:
          "Click an element id, query, or coordinates. Events are delivered to whatever owns the point, so a target that is visible but not frontmost can absorb the click; set foreground:true to raise the target app/window first.",
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            element_id: {
              type: "string",
              description: "Element id from observe, e.g. elem_12.",
            },
            query: {
              type: "string",
              description: "Accessible label/text query to click.",
            },
            x: {
              type: "number",
            },
            y: {
              type: "number",
            },
            click_type: {
              enum: ["single", "double", "right"],
              default: "single",
            },
            snapshot_id: {
              type: "string",
              description:
                "Snapshot id returned by observe/screenshot/inspect. Use this with element ids like elem_12.",
            },
            app: {
              type: "string",
              description:
                "Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.",
            },
            window_id: {
              type: "integer",
            },
            foreground: {
              type: "boolean",
              default: false,
            },
          },
          additionalProperties: false,
          anyOf: [
            {
              required: ["element_id"],
            },
            {
              required: ["query"],
            },
            {
              required: ["x", "y"],
            },
          ],
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      type_text: {
        key: "type_text",
        name: "Type text",
        description:
          "Type text into the current focus or a target element. Prefer paste_text for long text.",
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: {
            text: {
              type: "string",
            },
            target: {
              type: "string",
              description: "Optional element id from observe.",
            },
            snapshot_id: {
              type: "string",
              description:
                "Snapshot id returned by observe/screenshot/inspect. Use this with element ids like elem_12.",
            },
            app: {
              type: "string",
              description:
                "Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.",
            },
            clear_existing: {
              type: "boolean",
              default: false,
            },
            delay_ms: {
              type: "integer",
              minimum: 0,
              maximum: 1000,
              default: 0,
            },
            press_return: {
              type: "boolean",
              default: false,
            },
            foreground: {
              type: "boolean",
              default: false,
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      paste_text: {
        key: "paste_text",
        name: "Paste text",
        description:
          "Set clipboard, paste text, then restore the previous clipboard contents. More reliable than synthetic typing.",
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: {
            text: {
              type: "string",
            },
            app: {
              type: "string",
              description:
                "Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.",
            },
            restore_delay_ms: {
              type: "integer",
              minimum: 0,
              maximum: 5000,
              default: 150,
            },
            foreground: {
              type: "boolean",
              default: false,
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      hotkey: {
        key: "hotkey",
        name: "Press hotkey",
        description: "Press a keyboard shortcut such as cmd,l or cmd,shift,t.",
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          required: ["keys"],
          properties: {
            keys: {
              type: "string",
              description: "Comma/plus/space separated key combo, e.g. cmd,l.",
            },
            app: {
              type: "string",
              description:
                "Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.",
            },
            hold_ms: {
              type: "integer",
              minimum: 0,
              maximum: 5000,
              default: 50,
            },
            foreground: {
              type: "boolean",
              default: false,
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      move_mouse: {
        key: "move_mouse",
        name: "Move mouse",
        description: "Move the mouse cursor to screen coordinates.",
        annotations: {
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          required: ["x", "y"],
          properties: {
            x: {
              type: "number",
            },
            y: {
              type: "number",
            },
            duration_ms: {
              type: "integer",
              minimum: 0,
              maximum: 5000,
              default: 0,
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      scroll: {
        key: "scroll",
        name: "Scroll",
        description:
          "Scroll up/down/left/right at the current pointer or target element.",
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          required: ["direction"],
          properties: {
            direction: {
              enum: ["up", "down", "left", "right"],
            },
            amount: {
              type: "integer",
              minimum: 1,
              maximum: 10000,
              default: 5,
            },
            target: {
              type: "string",
            },
            snapshot_id: {
              type: "string",
              description:
                "Snapshot id returned by observe/screenshot/inspect. Use this with element ids like elem_12.",
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      focus_window: {
        key: "focus_window",
        name: "Focus window",
        description: "Bring a window/application to the foreground.",
        annotations: {
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            app: {
              type: "string",
              description:
                "Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.",
            },
            window_id: {
              type: "integer",
              description: "CoreGraphics window id.",
            },
            window_index: {
              type: "integer",
              description: "0-based window index within app.",
            },
            window_title: {
              type: "string",
              description: "Substring of target window title.",
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
      launch_app: {
        key: "launch_app",
        name: "Launch app",
        description: "Launch an application by name or bundle id.",
        annotations: {
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          required: ["app"],
          properties: {
            app: {
              type: "string",
              description:
                "Application name, bundle id, or PID:<pid>. Defaults to the frontmost app/window when omitted.",
            },
            bundle_id: {
              type: "string",
            },
            activate: {
              type: "boolean",
              default: true,
            },
            wait_until_ready: {
              type: "boolean",
              default: false,
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
      },
    }),
  },
];
