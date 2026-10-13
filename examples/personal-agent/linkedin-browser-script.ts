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
