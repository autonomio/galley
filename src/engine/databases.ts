// Databases a paper draws on. A database is given by one line: the server it
// runs on (user@host, reached over SSH with the person's own keys) or its
// address (clickhouse://user:password@host:8123). galley finds the ClickHouse
// there, lists its databases, and keeps the connection in a file on the machine
// that runs galley, under a name: papers refer to the name, so a password never
// reaches a paper, a prompt, a log or the browser. Every query is read-only,
// with limits on time and result size, and the analysis takes from it only the
// aggregated extracts it needs.
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** How galley reaches a ClickHouse: over HTTP(S) at its address, or over SSH on the server that hosts it. */
export interface Connection {
  name: string
  kind: 'clickhouse'
  via: 'http' | 'ssh'
  /** http: the server's address, http(s)://host:port. */
  url?: string
  user?: string
  /** Kept only in the connections file on the machine running galley. */
  password?: string
  /** ssh: user@host, reached with the SSH keys of whoever runs galley. */
  host?: string
  /** ssh: the Docker container that runs ClickHouse (its own credentials are used), or none for clickhouse-client on the host. */
  container?: string
  database: string
}

/** What a server offers: where ClickHouse runs, its version, and each database with its size. */
export interface Discovered {
  via: 'http' | 'ssh'
  label: string
  url?: string
  user?: string
  host?: string
  container?: string
  version: string
  databases: { name: string; tables: number; rows: number; bytes: number }[]
}

/** The connections file: GALLEY_CONNECTIONS, or ~/.galley/connections.json; on a server for many users, one shared file. */
export const connectionsPath = () => process.env.GALLEY_CONNECTIONS || join(homedir(), '.galley', 'connections.json')

export function readConnections(): Connection[] {
  const path = connectionsPath()
  if (!existsSync(path)) return []
  try { return (JSON.parse(readFileSync(path, 'utf8')).connections ?? []) as Connection[] } catch { return [] }
}

/** Save a connection under its name; the file is readable by its owner only. */
export function saveConnection(connection: Connection): void {
  const path = connectionsPath()
  mkdirSync(dirname(path), { recursive: true })
  const others = readConnections().filter((c) => c.name !== connection.name)
  writeFileSync(path, JSON.stringify({ connections: [...others, connection] }, null, 2) + '\n')
  chmodSync(path, 0o600)
}

/** A connection as anyone may see it: everything but the password. */
export const publicConnection = ({ password: _password, ...rest }: Connection) => rest

/** The limits every query runs under, whatever the SQL asks: read-only, bounded in time and in what it returns. */
export const LIMITS = { readonly: 1, max_execution_time: 300, max_result_rows: 1_000_000, max_result_bytes: 1_000_000_000, result_overflow_mode: 'throw' }

/** One line, as the person gives it: user@host for SSH, or an http(s):// or clickhouse:// address. */
export function parseConnectionLine(line: string): { via: 'ssh'; host: string } | { via: 'http'; url: string; user?: string; password?: string; database?: string } {
  const text = line.trim()
  const address = text.match(/^(clickhouses?|https?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/:?#]+)(?::(\d+))?(?:\/([\w-]+))?/i)
  if (address) {
    const [, scheme, user, password, hostname, port, database] = address
    const secure = /^(clickhouses|https)$/i.test(scheme)
    return { via: 'http', url: `${secure ? 'https' : 'http'}://${hostname}:${port ?? (secure ? '8443' : '8123')}`, ...(user ? { user: decodeURIComponent(user) } : {}), ...(password ? { password: decodeURIComponent(password) } : {}), ...(database ? { database } : {}) }
  }
  const ssh = text.replace(/^ssh:\/\//i, '').replace(/\/.*$/, '')
  if (/^[\w.-]+@[\w.-]+$/.test(ssh) || /^[\w.-]+$/.test(ssh)) return { via: 'ssh', host: ssh }
  throw new Error(`"${line}" is neither user@server nor a clickhouse:// or http(s):// address`)
}

function run(cmd: string, args: string[], input?: string, timeout = 360_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).split('\n').filter(Boolean).slice(-4).join(' ').slice(0, 800))) : resolve(stdout))
    if (input !== undefined) { child.stdin?.write(input); child.stdin?.end() }
  })
}

const SSH = (host: string) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host]
const settingFlags = (limits: Record<string, string | number>) => Object.entries(limits).map(([k, v]) => `--${k}=${v}`)

/** One query, read-only and bounded, returning the server's text (CSV with names, unless the SQL names its own format). */
export async function query(c: Pick<Connection, 'via' | 'url' | 'user' | 'password' | 'host' | 'container'>, database: string, sql: string, format = 'CSVWithNames'): Promise<string> {
  const statement = `${sql.trim().replace(/;\s*$/, '')}${/\bFORMAT\s+\w+\s*$/i.test(sql.trim()) ? '' : ` FORMAT ${format}`}`
  if (c.via === 'http') {
    const params = new URLSearchParams({ database, ...Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, String(v)])) })
    const response = await fetch(`${c.url}/?${params}`, {
      method: 'POST', body: statement, signal: AbortSignal.timeout(360_000),
      headers: c.user ? { Authorization: `Basic ${Buffer.from(`${c.user}:${c.password ?? ''}`).toString('base64')}` } : {},
    })
    const text = await response.text()
    if (!response.ok) throw new Error(text.split('\n')[0].slice(0, 800))
    return text
  }
  const client = c.container ? ['docker', 'exec', '-i', c.container, 'clickhouse-client'] : ['clickhouse-client']
  return run('ssh', [...SSH(c.host!), ...client, `--database=${database}`, ...settingFlags(LIMITS)], statement)
}

/** Find ClickHouse on a server reached over SSH: running in Docker, or installed on the host. */
async function sshCandidates(host: string): Promise<{ container?: string }[]> {
  // A server without Docker or without a client is not an error; the listing only says what it finds.
  const listing = await run('ssh', [...SSH(host), 'sh', '-c', `"docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null; if command -v clickhouse-client >/dev/null 2>&1; then echo HOST_CLIENT; fi; true"`], undefined, 60_000)
  const found: { container?: string }[] = []
  for (const line of listing.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line === 'HOST_CLIENT') found.push({})
    else if (/clickhouse/i.test(line.split(' ')[1] ?? '')) found.push({ container: line.split(' ')[0] })
  }
  return found
}

const DATABASES = "SELECT database AS name, count() AS tables, sum(total_rows) AS rows, sum(total_bytes) AS bytes FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') GROUP BY database ORDER BY bytes DESC"

/** What a connection line leads to: every ClickHouse found there, with its databases. */
export async function discover(line: string): Promise<Discovered[]> {
  const parsed = parseConnectionLine(line)
  const out: Discovered[] = []
  const describe = async (c: Pick<Connection, 'via' | 'url' | 'user' | 'password' | 'host' | 'container'>, label: string) => {
    const version = (await query(c, 'system', 'SELECT version()', 'TSV')).trim()
    const rows = (await query(c, 'system', DATABASES, 'TSV')).trim().split('\n').filter(Boolean).map((l) => l.split('\t'))
    out.push({ via: c.via, label, ...(c.url ? { url: c.url } : {}), ...(c.user ? { user: c.user } : {}), ...(c.host ? { host: c.host } : {}), ...(c.container ? { container: c.container } : {}), version, databases: rows.map(([name, tables, n, bytes]) => ({ name, tables: Number(tables) || 0, rows: Number(n) || 0, bytes: Number(bytes) || 0 })) })
  }
  if (parsed.via === 'http') await describe(parsed, parsed.url)
  else {
    for (const candidate of await sshCandidates(parsed.host)) {
      try { await describe({ via: 'ssh', host: parsed.host, ...candidate }, `${candidate.container ?? 'clickhouse-client'} on ${parsed.host}`) } catch { /* a ClickHouse galley cannot query is not offered */ }
    }
  }
  return out
}

/**
 * A database's tables with their columns, rows and size, and the comments the database keeps on them (how a database
 * documents itself): the schema the models plan from, never a row of the data.
 */
export async function schema(c: Connection): Promise<{ table: string; rows: number; bytes: number; columns: string[]; comment?: string }[]> {
  const tables = JSON.parse(await query(c, c.database, `SELECT name, toUInt64(ifNull(total_rows, 0)), toUInt64(ifNull(total_bytes, 0)), comment FROM system.tables WHERE database = currentDatabase() ORDER BY total_bytes DESC`, 'JSONCompact')).data as [string, string | number, string | number, string][]
  const columns = await query(c, c.database, `SELECT table, groupArray(if(comment = '', concat(name, ' ', type), concat(name, ' ', type, ' -- ', comment))) FROM system.columns WHERE database = currentDatabase() GROUP BY table`, 'JSONCompact')
  const byTable = new Map<string, string[]>((JSON.parse(columns).data ?? []).map((row: [string, string[]]) => [row[0], row[1]]))
  return tables.map(([table, rows, bytes, comment]) => ({ table, rows: Number(rows) || 0, bytes: Number(bytes) || 0, columns: byTable.get(table) ?? [], ...(comment ? { comment } : {}) }))
}

/** A database as a paper is given it: a saved connection's name, or the one line and the database to use, with what the person says about it. */
export interface DatabaseSpec {
  connection?: string
  line?: string
  via?: 'http' | 'ssh'
  host?: string
  container?: string
  url?: string
  user?: string
  password?: string
  database: string
  name?: string
  producedBy?: 'authors' | 'others'
  private?: boolean
}

/** The connection a spec names: a saved one, or one made from the line and kept under its name. */
export async function resolveConnection(spec: DatabaseSpec): Promise<Connection> {
  if (spec.connection) {
    const saved = readConnections().find((c) => c.name === spec.connection)
    if (!saved) throw new Error(`no saved connection named "${spec.connection}" in ${connectionsPath()}`)
    return { ...saved, database: spec.database || saved.database }
  }
  let found: Discovered | undefined
  if (spec.via && (spec.host || spec.url)) found = { via: spec.via, label: '', host: spec.host, container: spec.container, url: spec.url, user: spec.user, version: '', databases: [] }
  else if (spec.line) found = (await discover(spec.line)).find((d) => d.databases.some((x) => x.name === spec.database))
  if (!found) throw new Error(`no ClickHouse holding the database "${spec.database}" was found${spec.line ? ` at ${spec.line}` : ''}`)
  const parsed = spec.line ? parseConnectionLine(spec.line) : null
  const password = spec.password ?? (parsed?.via === 'http' ? parsed.password : undefined)
  const connection: Connection = {
    name: connectionName(found, spec.database), kind: 'clickhouse', via: found.via, database: spec.database,
    ...(found.url ? { url: found.url } : {}), ...(found.user ? { user: found.user } : {}), ...(password ? { password } : {}),
    ...(found.host ? { host: found.host } : {}), ...(found.container ? { container: found.container } : {}),
  }
  saveConnection(connection)
  return connection
}

/** A name for a connection a person made: the database and where it is. */
export const connectionName = (d: Pick<Discovered, 'host' | 'url' | 'container'>, database: string) =>
  `${database} on ${d.host ?? new URL(d.url!).hostname}${d.container ? ` (${d.container})` : ''}`
