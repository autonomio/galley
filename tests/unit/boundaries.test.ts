// The browser half must never pull in Node, and the shared core must stay
// free of both the DOM and Node, or the package stops working in one of the
// places it is meant to run.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '../../src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
}

const imports = (path: string) => [...readFileSync(path, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1])

describe('module boundaries', () => {
  it('keeps Node out of everything but src/server', () => {
    const offenders = files(SRC)
      .filter((path) => !relative(SRC, path).startsWith('server'))
      .filter((path) => imports(path).some((spec) => spec.startsWith('node:')))
      .map((path) => relative(SRC, path))
    expect(offenders).toEqual([])
  })

  it('keeps src/core and src/markdown free of the editor, the surface and the server', () => {
    const offenders = files(SRC)
      .filter((path) => /^(core|markdown)\//.test(relative(SRC, path)))
      .filter((path) => imports(path).some((spec) => /\/(editor|surface|server|stores)\//.test(spec)))
      .map((path) => relative(SRC, path))
    expect(offenders).toEqual([])
  })

  it('keeps the server free of the browser half', () => {
    const offenders = files(join(SRC, 'server'))
      .filter((path) => imports(path).some((spec) => /\/(editor|surface|stores)\//.test(spec)))
      .map((path) => relative(SRC, path))
    expect(offenders).toEqual([])
  })
})
