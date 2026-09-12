// Source stays worker-owned; the CLI build bundles only this compile entry.
// It requires esbuild and the SDK, never a worker process or native executor.
export {
  createIsolateConnectorCompiler,
  findBundledConnectorFile,
} from "@lobu/connector-worker/compile";
