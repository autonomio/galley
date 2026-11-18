// A Vite plugin that serves Galley's protocol from the dev and preview
// servers, backed by a folder of markdown files. Typed structurally so
// Galley does not depend on Vite.
import { createFileStore, type FileStoreOptions } from './file-store.js'
import { createGalleyHandler } from './http.js'

interface Middlewares {
  use(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: (error?: unknown) => void) => void): void
}

export interface GalleyVitePluginOptions extends FileStoreOptions {
  basePath?: string
}

export function galleyVitePlugin(options: GalleyVitePluginOptions) {
  const store = createFileStore(options)
  const handler = createGalleyHandler({ store, basePath: options.basePath })
  const mount = (server: { middlewares: Middlewares }) => {
    server.middlewares.use((req, res, next) => { void handler(req, res, next) })
  }
  return {
    name: 'galley',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}
