// Galley's server half: documents as markdown files, served over Galley's
// HTTP protocol.
//
//   import { createFileStore, createGalleyHandler } from '@autonomio/galley/server'
//   const handler = createGalleyHandler({ store: createFileStore({ dir: './documents' }) })
//   http.createServer((req, res) => handler(req, res)).listen(3000)
export {
  createFileStore,
  MAX_ANNOTATIONS_BYTES,
  MAX_DOC_BYTES,
  type FileStore,
  type FileStoreOptions,
  type Lock,
} from './file-store.js'
export { createGalleyHandler, type GalleyHandler, type HandlerOptions, type ServedStore } from './http.js'
export { galleyVitePlugin, type GalleyVitePluginOptions } from './vite.js'
export { ConflictError, InvalidSlugError } from '../core/errors.js'
export { isCanonicalSlug, newSlug, MAX_SLUG_LENGTH } from '../core/slug.js'
export { deriveTitle, stripMarkdownForTitle } from '../markdown/title.js'
