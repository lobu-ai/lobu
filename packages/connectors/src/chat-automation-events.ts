import type { ConnectorAutomationEvent } from "@lobu/connector-sdk";

// All server chat adapters use the same normalized message signal and turn
// routing. Keep the catalog aligned with that shared runtime capability.
export const CHAT_AUTOMATION_EVENTS: ConnectorAutomationEvent[] = [
	{
		key: "message.created",
		label: "A message is sent",
		description: "Runs for messages in the selected conversation scope.",
		resourceType: "channel",
		filterSchema: {
			type: "object",
			properties: {
				channel_id: {
					type: "string",
					title: "Channel",
					description: "Optional channel or direct-message identifier.",
				},
				mention_only: {
					type: "boolean",
					title: "Only when mentioned",
				},
			},
		},
		capabilities: { steering: true, replyToSource: true },
		defaults: {
			execution: "turn",
			activeRun: "steer",
			output: "reply_to_source",
		},
	},
];

