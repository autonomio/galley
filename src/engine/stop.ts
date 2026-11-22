// Stopping the run still going for a paper, before its folder is deleted. The
// process in the paper's progress file is taken for its run only if that
// process's command names the paper's folder, so a pid since reused by
// another process is left alone. Every process of the run is stopped with
// it: whatever it started, model calls among them in process groups of their
// own, and whatever its group still holds once it has gone.
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

/**
 * The run's processes: its leader, everything descended from it, and every member of a group one of them leads. A
 * group the leader merely belongs to, such as the shell it was started from, is not the run's. Once the leader is
 * gone, its group still holds what it left; while that group lives, no new process can take the leader's pid.
 */
function runProcesses(all: Proc[], leader: number): Proc[] {
  const run = new Map<number, Proc>()
  const children = new Map<number, Proc[]>()
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const take = (p: Proc) => {
    if (run.has(p.pid) || p.pid <= 1 || p.pid === process.pid) return
    run.set(p.pid, p)
    for (const child of children.get(p.pid) ?? []) take(child)
  }
  const head = all.find((p) => p.pid === leader)
  if (head) take(head)
  for (let grew = true; grew;) {
    const led = new Set([leader, ...run.keys()])
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
  const leader = all.find((p) => p.pid === pid)
  if (leader) {
    // The folder as one argument, spaces and all: followed by the end, a space or a path inside it.
    const names = (path: string) => new RegExp(`(^|\\s)${escape(path)}(?=/|\\s|$)`).test(leader.command)
    let real = paperDir
    try { real = realpathSync(paperDir) } catch { /* the folder as given */ }
    if (!names(paperDir) && !names(real)) return true
  } else if (!all.some((p) => p.pgid === pid)) return true
  const tracked = new Set(runProcesses(all, pid).map((p) => p.pid))
  const living = () => [...tracked].filter((id) => exists(id))
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    // Whatever the run started since it was last looked at is stopped too.
    for (const p of runProcesses(processes() ?? [], pid)) tracked.add(p.pid)
    const alive = living()
    if (!alive.length) return true
    for (const id of alive) { try { process.kill(id, signal) } catch { /* gone already */ } }
    for (let waited = 0; waited < patienceMs && living().length; waited += 100) await pause(100)
  }
  return !living().length
}
