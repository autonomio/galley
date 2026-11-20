// Galley: a calm markdown writing surface any web app can adopt as its own
// editor. Browser entry point; the server half is `@autonomio/galley/server`.
//
//   import { createEditor, createHttpStore } from '@autonomio/galley'
//   import '@autonomio/galley/tokens.css'
//   import '@autonomio/galley/galley.css'
//
//   createEditor(document.querySelector('#editor')!, { store: createHttpStore() })

export {
  createEditor,
  type BuiltinAction,
  type BuiltinSelectionAction,
  type Editor,
  type EditorAction,
  type EditorEvents,
  type EditorOptions,
  type EditorPlugin,
  type Notice,
  type SaveState,
  type SelectedPassage,
  type SelectionAction,
} from './editor/editor.js'
export { icons } from './editor/icons.js'
export { iconButton } from './editor/toolbar.js'

export { createSurface, type Surface, type SurfaceOptions, type SurfaceCommand, type TextPatch } from './surface/surface.js'

export type { DocumentStore, UnloadSave } from './stores/types.js'
export { createHttpStore, type HttpStoreOptions } from './stores/http.js'
export { createMemoryStore, createLocalStore, type MemoryStoreOptions, type LocalStoreOptions } from './stores/memory.js'

export { ConflictError, InvalidSlugError, isConflict } from './core/errors.js'
export { findEditRange, applyEdit } from './core/edits.js'
export { reAnchor, rangeText, sameRange } from './core/anchoring.js'
export { deriveTitle, stripMarkdownForTitle } from './markdown/title.js'
export * as markdown from './markdown/syntax.js'

export { merge3, mergeAnnotations } from './core/merge.js'
export type {
  Annotation,
  AnnotationAuthor,
  AnnotationLabel,
  AnnotationRange,
  AnnotationReply,
  AnnotationsRead,
  AnnotationsWriteResult,
  DocRead,
  DocSummary,
  DocWriteResult,
  EditOutcome,
  EditProposal,
  Version,
  WriteContext,
} from './types.js'
