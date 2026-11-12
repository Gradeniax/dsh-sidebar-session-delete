/**
 * dsh-sidebar-session-delete — Host half.
 *
 * Gives the Web sidebar a two-stage deletion capability:
 *
 *   Delete conversation  →  moves the Session's log directory into a trash
 *                           directory beside the Sessions root, archives the
 *                           Session (which is what hides its row) and records
 *                           an entry in the trash manifest.
 *   Trash → Restore      →  moves the directory back and unarchives the
 *                           Session, so the row returns to its Workspace.
 *   Trash → Delete for   →  removes the trashed directory for good.
 *           good / Empty
 *
 * The DSH Session log is append-only and the persistence seam exposes no
 * deletion API — the JSONL backend documents this outright ("Nothing deletes
 * session files"). That is why stage one is a *move*: it is reversible, and it
 * takes the artifact out of the persistence root so even the Host's own
 * listings stop seeing it.
 *
 * The trash directory is a sibling of the Sessions root, never inside it: the
 * backend scans the root for project directories, so trash inside the root
 * would be indexed as Sessions again.
 *
 * Safety:
 *   - A running Agent is refused for both trash and purge: a live turn keeps
 *     appending, and its open log handle must not be yanked.
 *   - A move is atomic and fails as a no-op, so a refused move loses nothing;
 *     the archive is rolled back when the move fails.
 *   - Every path is containment-checked against the two roots before use.
 *
 * The browser half (client.js) contributes the sidebar row command, the trash
 * page, and the confirmations; both talk to this module through the route
 * prefix below.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Same-origin route prefix consumed by client.js. */
const ROUTE_PREFIX = '/dsh-sidebar-session-delete'

/** A stored Session directory is recognised by its current-generation log. */
const LOG_FILE_PATTERN = /^session(\.v\d+)?\.jsonl(\.zstd)?$/

/** Manifest filename kept inside the trash root. */
const MANIFEST = 'trash.json'

/**
 * Path-encode a Session id exactly as the JSONL persistence backend does.
 * @param {string} raw - Session id (non-empty).
 * @returns {string} one filesystem-safe path segment.
 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Build the readable project-directory key for a `cwd`, mirroring the JSONL
 * backend's convention: separators collapse to `-`, unsafe code units use the
 * same `~XXXX` escape, and the segment is length-bounded.
 * @param {string} cwd - the Session's project directory.
 * @returns {string} one filesystem-safe project directory name.
 */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = String.fromCharCode(cwd.charCodeAt(i))
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Resolve the Sessions root.
 * @param {object} ctx - Host context.
 * @param {object} config - plugin row config.
 * @returns {string} absolute session-log root.
 */
function resolveRoot(ctx, config) {
  const configured = typeof config?.root === 'string' ? config.root.trim() : ''
  if (configured !== '') return resolve(configured)
  const declared = ctx.get('sessionPersistence')?.root
  if (typeof declared === 'string' && declared !== '') return resolve(declared)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(join(home, 'sessions'))
}

/**
 * Resolve the trash root: a sibling of the Sessions root by default.
 * @param {object} config - plugin row config.
 * @param {string} root - the Sessions root.
 * @returns {string} absolute trash root, never inside {@link root}.
 */
function resolveTrash(config, root) {
  const configured = typeof config?.trashRoot === 'string' ? config.trashRoot.trim() : ''
  if (configured !== '') return resolve(configured)
  return join(dirname(root), `${basename(root)}-trash`)
}

/** Whether `child` is strictly inside `parent`. */
function isInside(parent, child) {
  const base = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(base) && !child.slice(base.length).includes('..')
}

/**
 * Find the Session-owned directory under one root.
 * @param {string} root - sessions root.
 * @param {string} sessionId - Session to locate.
 * @param {string | undefined} cwd - the stored header's project directory, used as a first guess.
 * @returns {Promise<string | null>} the Session-owned directory.
 */
async function locateSessionDir(root, sessionId, cwd) {
  const segment = encodeSegment(sessionId)

  /**
   * Test one candidate directory for a generation log.
   * @param {string} candidate - candidate directory.
   * @returns {Promise<string | null>} the directory when it holds a log.
   */
  const inspect = async (candidate) => {
    let entries
    try {
      entries = await readdir(candidate, { withFileTypes: true })
    } catch {
      return null
    }
    return entries.some((entry) => entry.isFile() && LOG_FILE_PATTERN.test(entry.name)) ? candidate : null
  }

  /* Fast path: the stored header names the project directory, so the exact
   * candidate is checked first and the corpus is not scanned at all. The scan
   * below still runs when it misses, because a project directory that was
   * renamed or re-spelled after the header was written leaves the Session
   * under a key this derivation cannot reproduce. */
  if (typeof cwd === 'string' && cwd !== '') {
    const direct = await inspect(join(root, projectKey(cwd), segment))
    if (direct !== null) return direct
    const noCwd = await inspect(join(root, '_no-cwd', segment))
    if (noCwd !== null) return noCwd
  }

  let projectEntries
  try {
    projectEntries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const found = await inspect(join(root, projectEntry.name, segment))
    if (found !== null) return found
  }
  return null
}

/** Read and parse a JSON request body; `null` marks malformed input. */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** Failure shorthand. */
function fail(status, code, detail) {
  return { status, body: detail === undefined ? { ok: false, code } : { ok: false, code, detail } }
}

/**
 * Whether a path exists, without throwing on any filesystem error.
 * @param {string} path - candidate path.
 * @returns {Promise<boolean>} existence.
 */
async function existsQuietly(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Normalize any thrown value into text. */
const textOf = (error) => String(error?.message ?? error)

/**
 * Trash store: the manifest plus its serialized write chain.
 *
 * The manifest is the trash page's only source of truth for titles and times;
 * directories are the truth for occupancy. A missing or damaged manifest
 * degrades to "directories without titles" instead of losing the trash.
 */
class TrashStore {
  #root
  #dir
  #tail = Promise.resolve()

  /**
   * @param {string} dir - trash root.
   */
  constructor(dir) {
    this.#dir = dir
    this.#root = join(dir, MANIFEST)
  }

  /** The manifest path, for diagnostics. */
  get location() {
    return this.#dir
  }

  /** Read the manifest, tolerating absence and damage. */
  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#root, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.entries !== null && typeof parsed.entries === 'object') {
        return parsed
      }
    } catch {
      /* Absent or damaged: start from an empty manifest. */
    }
    return { version: 1, entries: {} }
  }

  /**
   * Serialize one manifest mutation behind every earlier one.
   * @param {function(object): object} mutate - receives and returns the manifest.
   * @returns {Promise<object>} the committed manifest.
   */
  update(mutate) {
    const next = this.#tail.then(async () => {
      const current = await this.read()
      const changed = mutate(current)
      await mkdir(this.#dir, { recursive: true })
      await writeFile(this.#root, JSON.stringify(changed, null, 2))
      return changed
    })
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * List trash entries, reconciled against the directories actually present so
   * a hand-deleted folder or a hand-copied one never desynchronizes the page.
   * @returns {Promise<object[]>} entries, newest first.
   */
  async list() {
    const manifest = await this.read()
    let dirs = []
    try {
      const found = await readdir(this.#dir, { withFileTypes: true })
      dirs = found.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
    const entries = []
    for (const dirName of dirs) {
      const record = manifest.entries[dirName] ?? {}
      let bytes = 0
      try {
        const info = await stat(join(this.#dir, dirName))
        bytes = info.size
      } catch {
        /* Directory vanished between listing and stat. */
      }
      entries.push({
        dirName,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : dirName,
        title: typeof record.title === 'string' ? record.title : '',
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
        deletedAt: typeof record.deletedAt === 'number' ? record.deletedAt : 0,
        warnings: Array.isArray(record.warnings) ? record.warnings : [],
        orphaned: typeof record.sessionId !== 'string',
        bytes,
      })
    }
    entries.sort((left, right) => right.deletedAt - left.deletedAt || left.dirName.localeCompare(right.dirName))
    return entries
  }
}

/**
 * Move one Session's log directory into the trash and hide its row.
 * @param {object} deps - resolved Host services.
 * @param {string} sessionId - Session to trash.
 * @param {string} displayTitle - the row title, stored for the trash page.
 * @returns {Promise<{ status: number, body: object }>} HTTP outcome.
 */
async function trashSession(deps, sessionId, displayTitle) {
  const agent = deps.agents.get(sessionId)
  if (agent !== undefined && agent.status === 'running') return fail(409, 'running')

  let snapshot
  try {
    snapshot = await deps.persistence.stat(sessionId)
  } catch (error) {
    return fail(500, 'stat-failed', textOf(error))
  }

  const storedCwd = snapshot?.header?.cwd
  const located = await locateSessionDir(deps.root, sessionId, storedCwd)
  if (located === null) {
    /* Distinguish "no record at all" from "already moved to the trash": the
     * second is a normal repeat click, the first is a bad id. */
    if (snapshot === undefined) {
      const alreadyTrashed = await existsQuietly(join(deps.trashRoot, encodeSegment(sessionId)))
      return alreadyTrashed ? fail(409, 'already-trashed') : fail(404, 'missing')
    }
    return fail(409, 'already-trashed')
  }
  if (!isInside(deps.root, located)) return fail(500, 'bad-path')
  if (isInside(deps.trashRoot, located)) return fail(500, 'bad-path')

  const alreadyArchived = deps.registry.archivedSessionIds.includes(sessionId)
  if (!alreadyArchived) {
    try {
      await deps.registry.archiveSession(sessionId)
    } catch (error) {
      return fail(409, 'archive-refused', textOf(error))
    }
  }

  const dirName = encodeSegment(sessionId)
  const target = join(deps.trashRoot, dirName)
  try {
    await mkdir(deps.trashRoot, { recursive: true })
    await rm(target, { recursive: true, force: true })
    await rename(located, target)
  } catch (error) {
    if (!alreadyArchived) {
      try {
        await deps.registry.unarchiveSession(sessionId)
      } catch {
        /* Reported through `rolledBack` below. */
      }
    }
    return {
      status: 500,
      body: { ok: false, code: 'move-failed', detail: textOf(error), rolledBack: !alreadyArchived },
    }
  }

  const warnings = []
  await deps.trash.update((manifest) => ({
    ...manifest,
    entries: {
      ...manifest.entries,
      [dirName]: {
        sessionId,
        title: typeof displayTitle === 'string' ? displayTitle : '',
        cwd: typeof storedCwd === 'string' ? storedCwd : '',
        deletedAt: Date.now(),
        wasArchived: alreadyArchived,
        warnings,
      },
    },
  }))

  return { status: 200, body: { ok: true, sessionId, entry: dirName } }
}

/**
 * Restore one trashed Session: move it back and unhide it.
 * @param {object} deps - resolved Host services.
 * @param {string} sessionId - Session to restore.
 * @returns {Promise<{ status: number, body: object }>} HTTP outcome.
 */
async function restoreSession(deps, sessionId) {
  const dirName = encodeSegment(sessionId)
  const source = join(deps.trashRoot, dirName)
  if (!isInside(deps.trashRoot, source)) return fail(500, 'bad-path')

  try {
    const info = await stat(source)
    if (!info.isDirectory()) return fail(404, 'not-trashed')
  } catch {
    return fail(404, 'not-trashed')
  }

  const manifest = await deps.trash.read()
  const record = manifest.entries[dirName] ?? {}
  const cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined

  const projectDir = join(deps.root, cwd === undefined ? '_no-cwd' : projectKey(cwd))
  const target = join(projectDir, dirName)
  if (!isInside(deps.root, target)) return fail(500, 'bad-path')

  try {
    await mkdir(projectDir, { recursive: true })
    await rm(target, { recursive: true, force: true })
    await rename(source, target)
  } catch (error) {
    return fail(500, 'move-failed', textOf(error))
  }

  await deps.trash.update((current) => {
    const entries = { ...current.entries }
    delete entries[dirName]
    return { ...current, entries }
  })

  const warnings = []
  /* A conversation archived before it was trashed stays archived on restore:
   * "restore from trash" undoes the trashing, not the archive the user chose
   * earlier. */
  if (record.wasArchived === true) {
    try {
      await deps.registry.archiveSession(sessionId)
    } catch {
      /* Already archived, or the registry no longer knows it. */
    }
  } else {
    try {
      await deps.registry.unarchiveSession(sessionId)
    } catch (error) {
      warnings.push(`unarchive: ${textOf(error)}`)
    }
  }

  return { status: 200, body: { ok: true, sessionId, warnings } }
}

/**
 * Permanently remove one entry from the trash.
 * @param {object} deps - resolved Host services.
 * @param {string} sessionId - Session to purge.
 * @returns {Promise<{ status: number, body: object }>} HTTP outcome.
 */
async function purgeSession(deps, sessionId) {
  const dirName = encodeSegment(sessionId)
  const target = join(deps.trashRoot, dirName)
  if (!isInside(deps.trashRoot, target)) return fail(500, 'bad-path')

  try {
    await rm(target, { recursive: true, force: true })
  } catch (error) {
    return fail(500, 'remove-failed', textOf(error))
  }

  await deps.trash.update((current) => {
    const entries = { ...current.entries }
    delete entries[dirName]
    return { ...current, entries }
  })

  /* Keep the Session archived. Archiving is the flag that hides a row, and a
   * Session can still be resident in memory after its log is gone; clearing the
   * flag here would make exactly that Session reappear — detached from every
   * Workspace — as an "Ungrouped" ghost. A leftover archive id is inert: it can
   * only hide an id that no longer exists.
   *
   * The Workspace account slot is dropped for tidiness; hiding does not depend
   * on it. Both calls tolerate unknown ids. */
  const warnings = []
  if (!deps.registry.archivedSessionIds.includes(sessionId)) {
    try {
      await deps.registry.archiveSession(sessionId)
    } catch (error) {
      warnings.push(`archive: ${textOf(error)}`)
    }
  }
  for (const workspace of deps.registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      warnings.push(`detach: ${textOf(error)}`)
    }
    break
  }

  return { status: 200, body: { ok: true, sessionId, warnings } }
}

/**
 * Permanently remove every trash entry.
 * @param {object} deps - resolved Host services.
 * @returns {Promise<{ status: number, body: object }>} HTTP outcome.
 */
async function emptyTrash(deps) {
  const entries = await deps.trash.list()
  const removed = []
  const failed = []
  for (const entry of entries) {
    const outcome = await purgeSession(deps, entry.sessionId)
    if (outcome.status === 200) removed.push(entry.sessionId)
    else failed.push({ sessionId: entry.sessionId, code: outcome.body.code })
  }
  return { status: 200, body: { ok: true, removed: removed.length, failed } }
}

/**
 * Host plugin body.
 * @param {object} ctx - Host context.
 * @param {object} [config] - row config: `root` and `trashRoot`.
 */
export function apply(ctx, config = {}) {
  const root = resolveRoot(ctx, config)
  if (!isAbsolute(root)) {
    console.error('[sidebar-session-delete] refusing to load: session root is not absolute')
    return
  }
  const trashRoot = resolveTrash(config, root)
  if (isInside(root, trashRoot) || trashRoot === root) {
    console.error('[sidebar-session-delete] refusing to load: the trash root must live outside the sessions root')
    return
  }

  const deps = {
    root,
    trashRoot,
    trash: new TrashStore(trashRoot),
    persistence: ctx.sessionPersistence,
    registry: ctx.workspaceRegistry,
    sessions: ctx.sessions,
    agents: ctx.agents,
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const endpoint = url.pathname.slice(ROUTE_PREFIX.length)

        try {
          if (req.method === 'GET' && endpoint === '/trash') {
            sendJson(res, 200, { ok: true, entries: await deps.trash.list() })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 404, { ok: false, code: 'not-found' })
            return
          }

          const body = await readJsonBody(req)
          if (body === null) {
            sendJson(res, 400, { ok: false, code: 'bad-args' })
            return
          }

          if (endpoint === '/trash/empty') {
            const outcome = await emptyTrash(deps)
            sendJson(res, outcome.status, outcome.body)
            return
          }

          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(res, 400, { ok: false, code: 'bad-args' })
            return
          }

          let outcome
          if (endpoint === '/trash') outcome = await trashSession(deps, body.sessionId, body.displayTitle)
          else if (endpoint === '/trash/restore') outcome = await restoreSession(deps, body.sessionId)
          else if (endpoint === '/trash/purge') outcome = await purgeSession(deps, body.sessionId)
          else {
            sendJson(res, 404, { ok: false, code: 'not-found' })
            return
          }
          sendJson(res, outcome.status, outcome.body)
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'internal', detail: textOf(error) })
        }
      },
    }),
  )

  console.error(
    `[sidebar-session-delete] host ready: ${ROUTE_PREFIX}/{trash,trash/restore,trash/purge,trash/empty} (root=${root}, trash=${trashRoot})`,
  )
}

export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'sessions', 'agents']
