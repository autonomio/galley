// Stopping the run still going for a paper, before its folder is deleted. The
// process in the paper's progress file is taken for its run only if that
// process's command names the paper's folder, so a pid since reused by
// another process is left alone. A run started by the app leads its own
// process group, and every process in that group is stopped with it, the
// model calls it made among them.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

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

/**
 * True once nothing runs for the paper; false while its run is alive and could not be stopped. Each signal is given
 * `patienceMs` to work: first SIGTERM, then SIGKILL.
 */
export async function stopRun(paperDir: string, patienceMs = 5000): Promise<boolean> {
  let pid = 0
  try { pid = Number(JSON.parse(readFileSync(join(paperDir, 'progress.json'), 'utf8')).pid) } catch { return true }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !exists(pid)) return true
  let line = ''
  try {
    line = execFileSync('ps', ['-ww', '-o', 'pgid=,command=', '-p', String(pid)]).toString().trim()
  } catch {
    // Gone meanwhile, or not ours to look at: a run that cannot be inspected is not taken for stopped.
    return !exists(pid)
  }
  const fields = line.match(/^(\d+)\s+([\s\S]*)$/)
  if (!fields) return !exists(pid)
  const [, group, command] = fields
  // The folder as one argument, spaces and all: followed by the end, a space or a path inside it.
  const names = (path: string) => new RegExp(`(^|\\s)${escape(path)}(?=/|\\s|$)`).test(command)
  let real = paperDir
  try { real = realpathSync(paperDir) } catch { /* the folder as given */ }
  if (!names(paperDir) && !names(real)) return true
  const target = Number(group) === pid ? -pid : pid
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try { process.kill(target, signal) } catch { /* gone already */ }
    for (let waited = 0; waited < patienceMs && exists(target); waited += 100) await pause(100)
    if (!exists(target)) return true
  }
  return false
}
