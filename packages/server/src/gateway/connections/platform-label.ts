const CHAT_PLATFORM_LABELS: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  discord: "Discord",
  teams: "Microsoft Teams",
  gchat: "Google Chat",
};

/** A chat platform's name as a reader knows it (`gchat` → `Google Chat`). */
export function chatPlatformLabel(platform: string): string {
  return CHAT_PLATFORM_LABELS[platform] ?? platform;
}
