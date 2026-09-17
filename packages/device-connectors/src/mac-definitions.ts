import type { DeviceConnectorSpec } from "@lobu/connector-sdk";

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
    key: "local.directory",
    version: "0.2.0",
    name: "Local Folder",
    description:
      "Sync text files (txt/md/json/csv/html) from a folder on your Mac via Lobu for Mac.",
    faviconDomain: "apple.com",
    requiredCapability: "local_directory",
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
      files: {
        key: "files",
        name: "Files",
        operations: ["sync", "read"],
        description:
          "Text files from one local folder on the user's Mac. One feed per folder — folder_id is an opaque stable id minted by the Mac app (the security-scoped bookmark is held device-side; the server never sees the absolute path).",
        userManaged: true,
        configSchema: {
          type: "object",
          required: ["folder_id", "display_name"],
          properties: {
            folder_id: {
              type: "string",
              minLength: 8,
              maxLength: 64,
              description:
                "Opaque stable id (UUID) minted on the Mac. Maps to a security-scoped bookmark stored locally on the device.",
            },
            display_name: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description:
                'Folder name shown in the UI (e.g., "Documents"). Not used to locate the folder — the device resolves folder_id to its bookmark.',
            },
          },
        },
        eventKinds: {
          file_document: {
            description: "A text file from a configured local folder.",
            metadataSchema: {
              type: "object",
              required: ["source", "folder", "name"],
              properties: {
                source: {
                  type: "string",
                  const: "local_directory",
                },
                folder: {
                  type: "string",
                  description: "Display name of the local folder.",
                },
                name: {
                  type: "string",
                  description: "File name.",
                },
                ext: {
                  type: "string",
                },
                size_bytes: {
                  type: "number",
                },
                modified_at: {
                  type: "string",
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
    key: "apple.system_audio",
    version: "0.2.0",
    name: "Meeting Audio",
    description:
      'Record meetings on this Mac via Lobu for Mac and transcribe them. Captures the meeting audio, plus your own voice when microphone access is granted, as two separate recordings so each side gets its own transcript. Connecting arms it; you start a recording from the menu bar, or Lobu offers to start one when it notices an app using your microphone — automatically only for apps you have marked "always". Audio is captured on the device; only short segments are shipped, and only while recording is on.',
    faviconDomain: "apple.com",
    requiredCapability: "system_audio",
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
      recordings: {
        key: "recordings",
        name: "Recordings",
        operations: ["sync"],
        description:
          "System-audio segments captured while recording; transcribed server-side.",
        configSchema: {
          type: "object",
          properties: {},
        },
        eventKinds: {
          recording: {
            description:
              "A single captured audio segment (transcribed after ingest). One recording produces one event per audio source, so a segment with the microphone active yields two: the meeting audio and your own voice, sharing a timestamp.",
            metadataSchema: {
              type: "object",
              required: ["source", "origin_id"],
              properties: {
                source: {
                  type: "string",
                  const: "system_audio",
                },
                audio_source: {
                  // Deliberately NOT in `required`. The newest manifest any
                  // online device can execute wins for the whole org, so one
                  // updated Mac would make this schema authoritative for a
                  // second Mac still shipping segments without the field —
                  // and a metadata validation failure DROPS the item
                  // (`run-lifecycle.ts`) after the device has already
                  // check-pointed the file as shipped. That is a lost
                  // recording, so the field is validated when present and
                  // absent-tolerant otherwise.
                  description:
                    "Which side of the conversation this segment holds. The two are separate events rather than one event with two attachments because transcription supersedes the base event, so a second audio attachment's transcript would be discarded as stale. Absent on segments from a Mac predating microphone capture.",
                  type: "string",
                  enum: ["system", "microphone"],
                },
                origin_id: {
                  type: "string",
                  description:
                    "Namespaced by audio source ('system-audio:' or 'mic-audio:') so one interval's two events stay distinct.",
                },
                filename: {
                  type: "string",
                },
                size_bytes: {
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
    version: "0.2.0",
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
  },
  {
    key: "apple.computer_use",
    version: "0.1.0",
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
    actions: {
      permissions: {
        key: "permissions",
        kind: "read",
        name: "Check permissions",
        description:
          "Return Screen Recording, Accessibility, and Event Synthesizing permission status for this Mac.",
        requiresApproval: false,
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
        requiresApproval: false,
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
        requiresApproval: false,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
    },
  },
];
