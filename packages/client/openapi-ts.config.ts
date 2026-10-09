import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input:
    process.env.LOBU_OPENAPI_URL ??
    "http://localhost:8787/lobu/api/docs/openapi.json",
  output: {
    path: "src/generated",
    format: "prettier",
    importFileExtension: ".js",
  },
  plugins: [
    "@hey-api/typescript",
    "@hey-api/sdk",
    { name: "@hey-api/client-fetch", baseUrl: "http://localhost:8787" },
  ],
});
