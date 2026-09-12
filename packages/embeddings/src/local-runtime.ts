import { pathToFileURL } from 'node:url';
import type * as LocalEmbeddings from './embeddings.js';

/** The launcher installs this component before spawning the service. */
export async function loadLocalEmbeddings(): Promise<typeof LocalEmbeddings> {
  // The installed CLI used 2 GiB, including ONNX even for remote-only users.
  // Import from the selected component's own directory so native resolution
  // stays with its installation. Source/container launches use the local file.
  const entry = process.env.LOBU_RUNTIME_EMBEDDINGS_ENTRY;
  const url = entry ? pathToFileURL(entry).href : new URL('./embeddings.js', import.meta.url).href;
  return import(url);
}
