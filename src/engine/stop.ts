// Stopping the run still going for a paper, before its folder is deleted. The
// process in the paper's progress file is taken for its run only if that
// process's command names the paper's folder, so a pid since reused by
// another process is left alone. Every process of the run is stopped with
// it: whatever it started, model calls among them in process groups of their
// own, but never a shared service it started for every project. Once the run
// has gone, what its group still holds is stopped only where it shows it is
// this paper's.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

interface Proc { pid: number; ppid: number; pgid: number; command: string }

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a process exists, or for a negative id any process of that group: one we may not signal still exists. */
function exists(id: number): boolean {
  try {
    process.kill(id, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Every process on the machine as ps sees it, or null when ps cannot be asked. */
function processes(): Proc[] | null {
  try {
    return execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,command='], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\s\S]*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] }))
  } catch {
    return null
  }
}

// Services a run may start but does not own, with everything under them: Canary's local service, which the first run
// to need it starts (literature.ts, ensureCanary), serves every project's literature reviews.
const SHARED = [/\bcanary\.cli runs serve\b/]
const shared = (p: Proc) => SHARED.some((re) => re.test(p.command))

/** Where a process works, or null when it cannot be told. */
function workingDir(pid: number): string | null {
  try {
    const line = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).toString().split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
  } catch {
    return null
  }
}

/**
 * The run's processes, from `starts`: each with everything descended from it, and every member of a group one of
 * them leads. A group a process merely belongs to, such as the shell it was started from, is not the run's; nor is a
 * shared service, or anything under it.
 */
function runProcesses(all: Proc[], starts: Proc[]): Proc[] {
  const run = new Map<number, Proc>()
  const children = new Map<number, Proc[]>()
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const take = (p: Proc) => {
    if (run.has(p.pid) || p.pid <= 1 || p.pid === process.pid || shared(p)) return
    run.set(p.pid, p)
    for (const child of children.get(p.pid) ?? []) take(child)
  }
  for (const p of starts) take(p)
  for (let grew = true; grew;) {
    const led = new Set(run.keys())
    const before = run.size
    for (const p of all) if (led.has(p.pgid)) take(p)
    grew = run.size > before
  }
  return [...run.values()]
}

/**
 * True once nothing runs for the paper; false while some process of its run is alive and could not be stopped. The
 * run's processes are taken before the first signal and followed by pid, since one whose parent has exited can no
 * longer be traced to it. Each signal is given `patienceMs` to work: first SIGTERM, then SIGKILL.
 */
export async function stopRun(paperDir: string, patienceMs = 5000): Promise<boolean> {
  let pid = 0
  try { pid = Number(JSON.parse(readFileSync(join(paperDir, 'progress.json'), 'utf8')).pid) } catch { return true }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return true
  const all = processes()
  // A run that cannot be inspected is not taken for stopped.
  if (!all) return !exists(pid) && !exists(-pid)
  let real = paperDir
  try { real = realpathSync(paperDir) } catch { /* the folder as given */ }
  const folders = [...new Set([paperDir, real])]
  // The folder as one argument, spaces and all: followed by the end, a space or a path inside it.
  const names = (command: string) => folders.some((path) => new RegExp(`(^|\\s)${escape(path)}(?=/|\\s|$)`).test(command))
  const inside = (dir: string | null) => !!dir && folders.some((path) => dir === path || dir.startsWith(`${path}/`))
  const leader = all.find((p) => p.pid === pid)
  if (leader && !names(leader.command)) return true
  // Where the run starts from. A living leader that names the folder is the run, and what descends from it is too.
  // Once it has gone, what is left in its group counts only when it shows it is this paper's: its command names the
  // folder, or it works inside it. Its pid can be reused once that group has emptied, and the group that then has
  // it is someone else's.
  const starts = (table: Proc[]) => leader
    ? table.filter((p) => p.pid === pid)
    : table.filter((p) => p.pgid === pid && !shared(p) && (names(p.command) || inside(workingDir(p.pid))))
  const first = starts(all)
  if (!first.length) return true
  const tracked = new Set(runProcesses(all, first).map((p) => p.pid))
  const living = () => [...tracked].filter((id) => exists(id))
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    // Whatever the run started since it was last looked at is stopped too, from wherever it still runs: a process that
    // outlived its leader can start a helper of its own.
    const table = processes() ?? []
    for (const p of runProcesses(table, [...starts(table), ...table.filter((q) => tracked.has(q.pid))])) tracked.add(p.pid)
    const alive = living()
    if (!alive.length) return true
    for (const id of alive) { try { process.kill(id, signal) } catch { /* gone already */ } }
    for (let waited = 0; waited < patienceMs && living().length; waited += 100) await pause(100)
  }
  return !living().length
}
