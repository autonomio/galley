// `npm run dev` serves the demo (demo/) with Galley's API mounted, keeping
// documents as markdown files in GALLEY_DIR (default ./.galley-data). An
// empty folder starts with the welcome document.
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { liveView } from './src/engine/live.js'
import { galleyVitePlugin } from './src/server/vite.js'

const dir = resolve(process.env.GALLEY_DIR || '.galley-data')
// Where papers are written; the end-to-end tests point it at a folder of their own.
const papers = resolve(process.env.GALLEY_PAPERS || 'papers')

// The paper an editor document belongs to: papers/<doc>, or the paper whose
// slug makes that document's name.
function paperForDocument(doc: string): string | null {
  const direct = join(papers, doc)
  if (existsSync(join(direct, 'state.json'))) return direct
  if (!existsSync(papers)) return null
  for (const name of readdirSync(papers)) {
    if (name.toLowerCase().replace(/[^a-z0-9-]+/g, '-') === doc.toLowerCase() && existsSync(join(papers, name, 'state.json'))) return join(papers, name)
  }
  return null
}

// A paper being written, as the editor shows it beside the text: who is
// working on what right now, its working notes and what has happened.
// Read from the paper's files; it never touches the run.
function livePlugin(): Plugin {
  return {
    name: 'galley-live',
    configureServer(server) {
      server.middlewares.use('/api/galley-live', (req, res) => {
        const doc = decodeURIComponent((req.url || '').replace(/^\//, '').split('?')[0])
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(doc)) { res.statusCode = 400; res.end(); return }
        const paperDir = paperForDocument(doc)
        const view = paperDir ? liveView(paperDir) : null
        if (!view) { res.statusCode = 404; res.end(); return }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(view))
      })
    },
  }
}

// The demo host's side of galley papers: the changes agents propose for a
// document live beside it as <slug>.proposals.json, and Accept or Decline
// is written back there for the paper's next run.
function proposalsPlugin(): Plugin {
  return {
    name: 'galley-proposals',
    configureServer(server) {
      server.middlewares.use('/api/galley-proposals', (req, res) => {
        const slug = decodeURIComponent((req.url || '').replace(/^\//, '').split('?')[0])
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) { res.statusCode = 400; res.end(); return }
        const file = resolve(dir, `${slug}.proposals.json`)
        const read = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { proposals: [] }
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            const { id, state } = JSON.parse(body || '{}')
            const data = read()
            const proposal = data.proposals.find((p: { id: string }) => p.id === id)
            if (!proposal || !['accepted', 'declined'].includes(state)) { res.statusCode = 404; res.end(); return }
            proposal.state = state
            writeFileSync(file, JSON.stringify(data, null, 2))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(proposal))
          })
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(read()))
      })
    },
  }
}

// A seed document becomes a paper, in the same document: the engine runs
// detached, writes its progress to papers/<slug>/run.log, takes the seed into
// the project, and writes the living paper into the document it started from.
function papersPlugin(): Plugin {
  // GALLEY_CLI stands a test's engine in for the real one; nothing else sets it.
  const cli = resolve(process.env.GALLEY_CLI || 'dist/engine/cli.js')
  return {
    name: 'galley-papers',
    configureServer(server) {
      server.middlewares.use('/api/galley-papers', (req, res) => {
        const [slugPart, sub] = decodeURIComponent((req.url || '').replace(/^\//, '').split('?')[0]).split('/')
        if (slugPart === '_context') {
          // What the wizard shows before a paper starts: seats, models, defaults, and whether OpenAlex has a key.
          if (!existsSync(cli)) { res.statusCode = 503; res.end('build galley first: npm run build'); return }
          res.setHeader('Content-Type', 'application/json')
          res.end(execFileSync(process.execPath, [cli, 'context']).toString())
          return
        }
        const slug = slugPart
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) { res.statusCode = 400; res.end('bad document name'); return }
        // One document, one project: the paper is written into the document it starts from, so its folder takes the
        // document's name. A project started before this keeps its <name>-paper folder and is still found.
        const legacy = join(papers, `${slug}-paper`)
        const paperDir = existsSync(join(legacy, 'state.json')) ? legacy : join(papers, slug)
        if (sub === 'choices') {
          // "For this claim, choose a, b or c": the open choices, and a person's answer to one.
          const statePath = join(paperDir, 'state.json')
          if (!existsSync(statePath)) { res.statusCode = 404; res.end(); return }
          if (req.method === 'POST') {
            let body = ''
            req.on('data', (chunk) => { body += chunk })
            req.on('end', () => {
              const { claimId, answer } = JSON.parse(body || '{}')
              if (!/^C\d+$/.test(claimId) || !/^[a-z, ]+$|^(auto|none)$/.test(answer)) { res.statusCode = 400; res.end(); return }
              const out = execFileSync(process.execPath, [cli, 'choose', paperDir, claimId, answer]).toString()
              const state = JSON.parse(readFileSync(statePath, 'utf8'))
              const open = Object.values(state.choices ?? {}).filter((c: any) => !c.answered).length
              let running = false
              try { process.kill(JSON.parse(readFileSync(join(paperDir, 'progress.json'), 'utf8')).pid, 0); running = true } catch { /* not running */ }
              // Once every choice is answered, the paper carries on by itself.
              if (!open && !running) {
                const log = openSync(join(paperDir, 'run.log'), 'a')
                spawn(process.execPath, [cli, 'run', paperDir], { detached: true, stdio: ['ignore', log, log] }).unref()
              }
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ message: out.trim(), open }))
            })
            return
          }
          const state = JSON.parse(readFileSync(statePath, 'utf8'))
          const choices = Object.values(state.choices ?? {}).filter((c: any) => !c.answered).map((c: any) => ({
            claimId: c.claimId,
            claim: state.claims.find((x: any) => x.id === c.claimId)?.text ?? '',
            options: c.options.map((o: any) => {
              const w = state.works[o.workId] ?? {}
              return { letter: o.letter, passage: o.passage, fit: o.fit, role: o.role, title: w.title, year: w.year, authors: (w.authors ?? []).slice(0, 3) }
            }),
          }))
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ choices }))
          return
        }
        if (req.method !== 'POST') {
          if (!existsSync(join(paperDir, 'state.json'))) { res.statusCode = 404; res.end(); return }
          // Where the paper stands, as data the status view draws; reading it never touches the run.
          let data: unknown = null
          try { data = JSON.parse(execFileSync(process.execPath, [cli, 'status', paperDir, '--json']).toString()) } catch (error) { res.statusCode = 500; res.end(String(error)); return }
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ data }))
          return
        }
        if (!existsSync(cli)) { res.statusCode = 503; res.end('build galley first: npm run build'); return }
        if (existsSync(join(paperDir, 'state.json'))) { res.statusCode = 409; res.end('a paper for this document already exists'); return }
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          const { text, settings = {}, materials = [], citations } = JSON.parse(body || '{}')
          const stamp = Date.now()
          const seed = join(tmpdir(), `galley-seed-${slug}-${stamp}.md`)
          writeFileSync(seed, String(text || ''))
          // The wizard's settings become the engine's flags; each value is checked against what the engine accepts.
          const s = settings as Record<string, unknown>
          const args: string[] = []
          const add = (name: string, value: unknown, ok: (v: string) => boolean) => { const v = String(value ?? '').trim(); if (v && ok(v)) args.push(`--${name}`, v) }
          add('author', s.author, (v) => v.length <= 200)
          add('affiliation', s.affiliation, (v) => v.length <= 300)
          add('venue', s.venue, (v) => v.length <= 200)
          add('words', s.words, (v) => /^\d{3,5}$/.test(v))
          add('rounds', s.rounds, (v) => /^[12]$/.test(v))
          add('dial', s.dial, (v) => ['autonomous', 'assisted', 'propose'].includes(v))
          add('citations', s.citations ?? citations, (v) => ['auto', 'choose', 'mixed'].includes(v))
          // An option the paper includes, in support or as what its main contribution rests on.
          if (s.literatureReview === true) args.push('--literature-review', s.reviewRole === 'load-bearing' ? 'load-bearing' : 'yes')
          if (s.simulation === true) args.push('--simulation', s.simulationRole === 'load-bearing' ? 'load-bearing' : 'yes')
          // Uploaded files are written under their own names for the engine to copy into the paper; links pass as they are.
          const inbox = join(tmpdir(), `galley-materials-${slug}-${stamp}`)
          for (const m of materials as { name?: string; url?: string; data?: string; private?: boolean }[]) {
            if (m.url && /^https?:\/\//i.test(m.url)) { args.push('--material', m.url); continue }
            if (!m.data || !m.name) continue
            mkdirSync(inbox, { recursive: true })
            const file = join(inbox, m.name.replace(/[^\w.-]+/g, '_'))
            writeFileSync(file, Buffer.from(m.data, 'base64'))
            args.push(m.private === false ? '--shared-material' : '--material', file)
          }
          mkdirSync(paperDir, { recursive: true })
          const log = openSync(join(paperDir, 'run.log'), 'a')
          // The paper is written into the document it starts from, by that document's exact name.
          spawn(process.execPath, [cli, 'write', seed, paperDir, '--editor', dir, '--editor-doc', slug, ...args], { detached: true, stdio: ['ignore', log, log] }).unref()
          res.statusCode = 202
          res.end(JSON.stringify({ dir: paperDir }))
        })
      })
    },
  }
}

// How a paper's file is sent: shown in the browser where it can be, saved where it cannot.
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
}
// Sources, references and records read as they are, as text.
const TEXT = /\.(md|markdown|tex|typ|bib|jsonl|ya?ml|txt|log|ris|html?)$/i

/** Every file under a folder, hidden ones left out, as paths relative to it. */
function listFiles(root: string): { path: string, size: number, modified: string }[] {
  const files: { path: string, size: number, modified: string }[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || files.length >= 10_000) continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), path)
      else if (entry.isFile()) {
        const stats = statSync(join(dir, entry.name))
        files.push({ path, size: stats.size, modified: stats.mtime.toISOString() })
      }
    }
  }
  walk(root, '')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function sendFile(res: ServerResponse, file: string): void {
  const ext = (/\.([a-z0-9]+)$/i.exec(file)?.[1] ?? '').toLowerCase()
  const stats = statSync(file)
  res.setHeader('Content-Type', TYPES[ext] ?? (TEXT.test(file) ? 'text/plain; charset=utf-8' : 'application/octet-stream'))
  res.setHeader('Content-Length', String(stats.size))
  res.setHeader('Last-Modified', stats.mtime.toUTCString())
  // The paper is typeset again whenever its text changes: always the latest.
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // A figure is a picture, never a page that runs.
  if (ext === 'svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
  createReadStream(file).on('error', () => res.destroy()).pipe(res)
}

// A folder of out/, or all of it, as one zip made while it is sent, by the zip
// the engine packs submission.zip with. It holds exactly the files the list
// shows: zip left to walk a folder itself packs what a link in it points to,
// which can be the materials outside out/.
function sendZip(res: ServerResponse, out: string, files: string[], name: string): void {
  // A name is read one per line, so a name with a line break in it could name another file.
  const names = files.filter((f) => !/[\r\n]/.test(f))
  if (!names.length) { res.statusCode = 404; res.end('Nothing here yet.'); return }
  // -nw: a name is a name, never a pattern; -y: a link that appears after the list was read is packed as a link.
  const zip = spawn('zip', ['-q', '-nw', '-y', '-', '-@'], { cwd: out })
  zip.stdin.on('error', () => { /* zip is gone; its own error answers */ })
  zip.stdin.end(names.join('\n') + '\n')
  zip.on('error', () => {
    if (res.headersSent) { res.destroy(); return }
    res.removeHeader('Content-Disposition')
    res.statusCode = 501
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('zip is not installed on this machine')
  })
  res.on('close', () => zip.kill())
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.setHeader('Cache-Control', 'no-store')
  // The zip is only whole once zip says so: a file it could not read cuts the
  // download off, so the browser reports it failed instead of saving half an archive.
  zip.stdout.pipe(res, { end: false })
  zip.on('close', (code) => {
    if (res.writableEnded) return // answered already: no zip on this machine
    if (code === 0) res.end()
    else res.destroy()
  })
}

// What a paper has made, each file at a link of its own: /papers/<doc>/<file>
// is one file of its out/ folder, /papers/<doc>/<folder>.zip one of its
// folders, /papers/<doc>.zip all of it, and /papers/<doc>/ the list, open in
// the editor. /api/galley-files/<doc> is that list as data. Only out/ is ever
// served: the materials a person brought stay where they are.
function paperFilesPlugin(): Plugin {
  const NAME = /^[a-z0-9][a-z0-9-]*$/i
  // A seed document from before one-document projects has its paper at <doc>-paper.
  const projectOf = (doc: string): string | null => {
    const legacy = join(papers, `${doc}-paper`)
    return existsSync(join(legacy, 'state.json')) ? legacy : paperForDocument(doc)
  }
  const outOf = (doc: string): string | null => {
    const project = projectOf(doc)
    return project && existsSync(join(project, 'out')) ? realpathSync(join(project, 'out')) : null
  }
  const inside = (out: string, path: string) => existsSync(path) && realpathSync(path).startsWith(out + sep)
  return {
    name: 'galley-files',
    configureServer(server) {
      server.middlewares.use('/api/galley-files', (req, res) => {
        let doc = ''
        try { doc = decodeURIComponent((req.url || '').replace(/^\//, '').split('?')[0]) } catch { /* a malformed name is no name */ }
        if (!NAME.test(doc)) { res.statusCode = 400; res.end(); return }
        const out = outOf(doc)
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ paper: !!projectOf(doc), files: out ? listFiles(out) : [] }))
      })
      server.middlewares.use('/papers', (req, res, next) => {
        let parts: string[]
        try { parts = new URL(req.url || '/', 'http://localhost').pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch { res.statusCode = 400; res.end(); return }
        const whole = parts.length === 1 && parts[0].endsWith('.zip')
        const doc = whole ? parts[0].slice(0, -4) : parts[0] ?? ''
        if (!NAME.test(doc)) { next(); return }
        if (parts.length === 1 && !whole) {
          res.statusCode = 302
          res.setHeader('Location', `/?doc=${encodeURIComponent(doc)}&view=files`)
          res.end()
          return
        }
        const out = outOf(doc)
        if (!out) { res.statusCode = 404; res.end('This document has no files yet.'); return }
        const listed = () => listFiles(out).map((f) => f.path)
        // A whole-project zip leaves out submission.zip, which is most of it zipped already.
        if (whole) { sendZip(res, out, listed().filter((p) => p !== 'submission.zip'), `${doc}.zip`); return }
        const rel = parts.slice(1).join('/')
        // Nothing outside out/, and nothing hidden in it.
        if (rel.split('/').some((p) => !p || p.startsWith('.'))) { res.statusCode = 404; res.end(); return }
        const target = resolve(out, rel)
        if (inside(out, target) && statSync(target).isFile()) { sendFile(res, realpathSync(target)); return }
        const folder = rel.endsWith('.zip') ? rel.slice(0, -4) : ''
        if (folder && inside(out, resolve(out, folder)) && statSync(resolve(out, folder)).isDirectory()) {
          sendZip(res, out, listed().filter((p) => p.startsWith(`${folder}/`)), `${doc}-${folder.replace(/\//g, '-')}.zip`)
          return
        }
        res.statusCode = 404
        res.end()
      })
    },
  }
}

export default defineConfig(({ command }) => {
  if (command === 'serve') {
    mkdirSync(dir, { recursive: true })
    if (!readdirSync(dir).some((name) => name.endsWith('.md'))) {
      writeFileSync(resolve(dir, 'welcome.md'), readFileSync(resolve('demo/welcome.md'), 'utf8'))
    }
  }
  return {
    root: 'demo',
    plugins: [galleyVitePlugin({ dir }), proposalsPlugin(), papersPlugin(), livePlugin(), paperFilesPlugin()],
    server: {
      port: Number(process.env.PORT || 5174),
      strictPort: !!process.env.PORT,
      fs: { allow: ['..'] },
    },
    build: {
      outDir: '../dist-demo',
      emptyOutDir: true,
    },
  }
})
