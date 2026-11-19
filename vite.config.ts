// `npm run dev` serves the demo (demo/) with Galley's API mounted, keeping
// documents as markdown files in GALLEY_DIR (default ./.galley-data). An
// empty folder starts with the welcome document.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { galleyVitePlugin } from './src/server/vite.js'

const dir = resolve(process.env.GALLEY_DIR || '.galley-data')

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

// A seed document becomes a paper: the engine runs detached, writes its
// progress to papers/<slug>-paper/run.log, and puts the manuscript's editor
// document beside the seed, so it shows up in the same document list.
function papersPlugin(): Plugin {
  const cli = resolve('dist/engine/cli.js')
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
        const paperDir = resolve('papers', `${slug}-paper`)
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
          spawn(process.execPath, [cli, 'write', seed, paperDir, '--editor', dir, ...args], { detached: true, stdio: ['ignore', log, log] }).unref()
          res.statusCode = 202
          res.end(JSON.stringify({ dir: paperDir }))
        })
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
    plugins: [galleyVitePlugin({ dir }), proposalsPlugin(), papersPlugin()],
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
