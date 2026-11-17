import type { ActionDefinition } from "@lobu/connector-sdk";

// Every Chat-SDK connector shares one outbound message contract. The gateway's
// chat transport delivers it through the connection's adapter; the connector
// only declares it, so policy, approval and audit have a named action.
export const CHAT_TRANSPORT_ACTIONS: Record<string, ActionDefinition> = {
	send_message: {
		key: "send_message",
		name: "Send message",
		description:
			"Post a message to a channel the agent is bound to, outside the conversation that asked it.",
		kind: "write",
		delivery: "chat_transport",
		annotations: { openWorldHint: true },
		inputSchema: {
			type: "object",
			required: ["channel_id", "text"],
			additionalProperties: false,
			properties: {
				channel_id: {
					type: "string",
					minLength: 1,
					title: "Channel",
					description: "Platform-native channel id the message is posted to.",
					"x-lobu-destination": true,
				},
				thread_id: {
					type: "string",
					minLength: 1,
					title: "Thread",
					description: "Root message id of the thread to reply in. Absent: a new top-level message.",
				},
				text: {
					type: "string",
					minLength: 1,
					maxLength: 4000,
					title: "Message",
					format: "markdown",
				},
			},
		},
		outputSchema: {
			type: "object",
			properties: {
				message_id: { type: ["string", "null"] },
				thread: { type: "string" },
			},
		},
	},
};
