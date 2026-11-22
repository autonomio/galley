// Stopping a paper's run before its folder is deleted: only the process whose
// command names the folder is the run, and every process of the run stops,
// whatever group it is in and whether or not its parent is still there.
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

// A process that ignores SIGTERM, as a model call's helper might: it says it is ready only once it does.
const STUBBORN = 'process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)'

/** A run that leads its own group, as the app starts runs, and has started one stubborn process, in a group of its own or in the run's. */
async function run(paper: string, own: boolean): Promise<{ leader: ChildProcess, child: number }> {
  const childFile = join(dir, 'child.pid')
  const leader = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(STUBBORN)}, process.argv[1]], { stdio: 'ignore', detached: ${own} }); setInterval(() => {}, 1000)`, childFile, paper], { detached: true, stdio: 'ignore' })
  started.push(leader)
  writeFileSync(join(paper, 'progress.json'), JSON.stringify({ pid: leader.pid }))
  await until(() => existsSync(childFile) && readFileSync(childFile, 'utf8').length > 0)
  const child = Number(readFileSync(childFile, 'utf8'))
  extra.push(child)
  return { leader, child }
}

describe('stopping a paper\'s run', () => {
  it('stops a run that names the paper\'s folder, spaces and all, with a process it started in a group of its own, one that ignores SIGTERM', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-stop-'))
    const paper = join(dir, 'a folder with spaces', 'papers', 'trees')
    mkdirSync(paper, { recursive: true })
    const { child } = await run(paper, true)
    expect(await stopRun(paper, 500)).toBe(true)
    expect(alive(child)).toBe(false)
  })

  it('stops what is left in the run\'s group once the run itself has died', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-stop-'))
    const paper = join(dir, 'trees')
    mkdirSync(paper)
    const { leader, child } = await run(paper, false)
    leader.kill('SIGKILL')
    await until(() => !alive(leader.pid!))
    expect(alive(child)).toBe(true)
    expect(await stopRun(paper, 500)).toBe(true)
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
