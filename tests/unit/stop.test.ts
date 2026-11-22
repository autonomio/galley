// Stopping a paper's run before its folder is deleted: only the process whose
// command names the folder is the run, and every process in its group stops.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stopRun } from '../../src/engine/stop.js'

let dir = ''
const started: ChildProcess[] = []
const extra: number[] = []
afterEach(() => {
  for (const child of started.splice(0)) try { child.kill('SIGKILL') } catch { /* gone */ }
  for (const pid of extra.splice(0)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((done) => setTimeout(done, 50)) }

describe('stopping a paper\'s run', () => {
  it('stops a run that names the paper\'s folder, spaces and all, with every process of its group, even one that ignores SIGTERM', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-stop-'))
    const paper = join(dir, 'a folder with spaces', 'papers', 'trees')
    mkdirSync(paper, { recursive: true })
    const childFile = join(dir, 'child.pid')
    // The run leads its own group, as the app starts runs; the model call it started ignores SIGTERM.
    const leader = spawn(process.execPath, ['-e', `
      const child = require('child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      require('fs').writeFileSync(process.argv[1], String(child.pid))
      setInterval(() => {}, 1000)`, childFile, paper], { detached: true, stdio: 'ignore' })
    started.push(leader)
    writeFileSync(join(paper, 'progress.json'), JSON.stringify({ pid: leader.pid }))
    await until(() => existsSync(childFile))
    const child = Number(readFileSync(childFile, 'utf8'))
    extra.push(child)
    expect(await stopRun(paper, 500)).toBe(true)
    await until(() => !alive(child))
    expect(alive(child)).toBe(false)
  })

  it('leaves alone a process whose command does not name the paper\'s folder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-stop-'))
    const paper = join(dir, 'trees')
    mkdirSync(paper)
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(dir, 'trees-2')], { detached: true, stdio: 'ignore' })
    started.push(other)
    writeFileSync(join(paper, 'progress.json'), JSON.stringify({ pid: other.pid }))
    expect(await stopRun(paper, 500)).toBe(true)
    expect(alive(other.pid!)).toBe(true)
  })

  it('takes a paper with no run for stopped', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-stop-'))
    expect(await stopRun(dir)).toBe(true)
  })
})
