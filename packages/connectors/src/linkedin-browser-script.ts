export const LINKEDIN_HOME_URL = "https://www.linkedin.com/feed/foryou/";

/** Keep data inert in generated browser code, including an HTML script context. */
export function linkedInScriptArgument(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("LinkedIn browser input is required");
  const literal = JSON.stringify(json).replace(
    /[<>\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  // Parsing also preserves JSON object keys such as __proto__ as plain data.
  return `JSON.parse(${literal})`;
}

/** LinkedIn origins a scrape window or action tab is allowed to touch. */
export const LINKEDIN_ALLOWED_ORIGINS = ["linkedin.com", "*.linkedin.com"];

/** A landed path that means the paired Chrome is signed out. */
export const LINKEDIN_LOGGED_OUT_WHEN = {
  pathRegex: "/(login|authwall|uas/login|checkpoint|signup)\\b",
} as const;

export const LINKEDIN_LOGGED_OUT_ERROR =
  "Not logged into LinkedIn. Sign in to linkedin.com in the paired Chrome profile, then retry.";
