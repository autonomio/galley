// An import must fit the same per-document limit the server enforces
// (MAX_DOC_BYTES), checked before the file is read into a document so an
// oversized pick fails fast.
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024

export function decodeMarkdownImport(buffer: ArrayBuffer): string {
  if (buffer.byteLength > IMPORT_MAX_BYTES) {
    throw new Error('Choose a file smaller than 5 MiB.')
  }
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new Error('Choose a UTF-8 text file; this one could not be read as text.')
  }
  // Line endings are the one normalization import performs: a carriage
  // return would otherwise survive the `\n` split, breaking fence, table
  // and rule matching and persisting into the saved document.
  return content.replace(/\r\n?/g, '\n')
}
