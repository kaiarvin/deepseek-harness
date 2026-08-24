/**
 * dsh-file-drop-inbox — host half.
 *
 * Owns one fenced route: POST /inbox/upload. The client half splits a file
 * drop into images (handed back to the built-in image intake) and everything
 * else, sends the non-images here as base64 JSON, and this half writes each
 * file below the session's working directory at `<cwd>/.dsh/inbox` with a
 * collision-free name (tmp + rename, like the dsh-better-sidebar fs.write).
 * The client then inserts each saved path as a filename-only composer chip
 * that serializes to `[name](<absolute path>)` on send, so the model can
 * `read` the file without a durable-attachment channel.
 *
 * The route carries the same browser-trust fence as the /api gateway:
 * Host-header loopback or a `webRuntime.trustedHosts` authority, and
 * cross-site browser markers refuse. This is a DNS-rebinding / cross-site
 * defense, not authentication.
 * @module dsh-file-drop-inbox
 */
import z from '@deepseek-ai/schemastery'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { dedupTargetPath, dirname, isWithin, requireAbsolute, sameDedupFamily, sanitizeInboxName } from './pure.js'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-file-drop-inbox'

/** Services required before mounting: the webserver routes, the session store, and the web runtime's trusted hosts. */
export const inject = ['webServer', 'sessions', 'webRuntime']

/** Plugin configuration (Loader-validated; defaults filled by the schema). */
export const Config = z.object({
  /** Per-file byte cap for one uploaded non-image file. */
  maxUploadBytes: z.number().min(1).default(20 * 1024 * 1024),
  /** Directory name below the session cwd that receives dropped files. */
  inboxDirName: z.string().default('.dsh/inbox'),
})

// ---- Browser-trust fence (behaviorally identical to the /api gateway's
// fence in @deepseek-ai/dsh-client-connection, BSD-3-Clause; copied here
// because the plugin must not depend on that package's internals). ----

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    let entryUrl
    try {
      entryUrl = new URL(`http://${entry}`)
    } catch {
      return false
    }
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one request may reach the plugin routes.
 * @param request - node HTTP request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours (loopback or trusted) and browser markers are same-origin.
 */
function isTrustedApiRequest(request, trustedHosts) {
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ---- Wire helpers (bounded body read + JSON envelopes). ----

/** One wire failure with its code and HTTP status. */
class InboxError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Read a request body with a hard byte bound (defense against unbounded reads). */
async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw new InboxError('too-large', 'request body too large', 413)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Write a JSON response with the given status. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
function writeError(res, error) {
  if (error instanceof InboxError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  writeJson(res, 500, {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
  })
}

/**
 * Resolve a session's authoritative working directory: the attached session
 * header wins, the caller's list-summary cwd is used while the session is
 * still hydrating, and the process cwd is the last resort.
 * @param ctx - host plugin context (sessions service).
 * @param sessionId - target session.
 * @param clientCwd - best-effort cwd from the browser list summary.
 * @returns the absolute working directory.
 */
function sessionCwdOf(ctx, sessionId, clientCwd) {
  const headerCwd = ctx.sessions.get(sessionId)?.header.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  if (clientCwd !== undefined && clientCwd !== '') {
    try {
      return requireAbsolute(clientCwd)
    } catch {
      throw new InboxError('bad-request', `invalid working directory "${clientCwd}"`)
    }
  }
  return process.cwd()
}

/** Validate one upload payload into {sessionId, cwd, name, bytes, draftNames, batchNames}. */
function parseUpload(payload, config) {
  if (payload === null || typeof payload !== 'object') {
    throw new InboxError('bad-request', 'request body must be a JSON object')
  }
  const { sessionId, name, data } = payload
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new InboxError('bad-request', 'missing sessionId')
  }
  if (typeof name !== 'string' || name === '') {
    throw new InboxError('bad-request', 'missing name')
  }
  if (typeof data !== 'string' || data === '') {
    throw new InboxError('bad-request', 'missing base64 data')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > config.maxUploadBytes) {
    throw new InboxError('too-large', `file exceeds the ${String(config.maxUploadBytes)} byte upload limit`, 413)
  }
  const clientCwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : undefined
  // Per-message dedup context (the client owns the draft): labels of chips
  // already in the draft plus raw names uploaded earlier in this batch.
  const draftNames = Array.isArray(payload.draftNames)
    ? payload.draftNames.filter((entry) => typeof entry === 'string')
    : []
  const batchNames = Array.isArray(payload.batchNames)
    ? payload.batchNames.filter((entry) => typeof entry === 'string')
    : []
  return { sessionId, clientCwd, name, bytes, draftNames, batchNames }
}

/**
 * Plugin body: mount the fenced /inbox upload route.
 * @param ctx - host plugin context (webServer, sessions, webRuntime).
 * @param config - validated configuration (schema defaults filled by the Loader).
 */
export function apply(ctx, config) {
  const resolved = { maxUploadBytes: config.maxUploadBytes, inboxDirName: config.inboxDirName }
  // Read per request from the live service value so a replaced trusted-hosts
  // list takes effect without a plugin restart (same source the /api gateway
  // fence derives its list from).
  const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)
  // Base64 inflates 4/3; bound the body at the file cap plus JSON envelope.
  const bodyLimit = Math.ceil(resolved.maxUploadBytes * 4 / 3) + 64 * 1024

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/inbox',
    handler: async (req, res) => {
      try {
        if (!fence(req)) throw new InboxError('forbidden', 'forbidden', 403)
        if (req.method !== 'POST') throw new InboxError('method-error', 'method not allowed', 405)
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        if (pathname !== '/inbox/upload') throw new InboxError('not-found', 'unknown inbox method', 404)
        const body = await readBody(req, bodyLimit)
        let payload
        try {
          payload = JSON.parse(body.toString('utf8'))
        } catch {
          throw new InboxError('bad-request', 'request body is not valid JSON')
        }
        const { sessionId, clientCwd, name, bytes, draftNames, batchNames } = parseUpload(payload, resolved)
        const cwd = sessionCwdOf(ctx, sessionId, clientCwd)
        const inboxDir = resolve(join(cwd, resolved.inboxDirName))
        if (!isWithin(cwd, inboxDir)) {
          throw new InboxError('bad-request', 'inbox directory escapes the session working directory')
        }
        await mkdir(inboxDir, { recursive: true })
        // Dedup is a pure function of the request's message context — the host
        // keeps no counter, so a fresh message always gets the bare name again
        // (on-disk history never counts; that accumulator is what produced the
        // `-9` suffixes).
        const safe = sanitizeInboxName(name)
        const index = [...draftNames, ...batchNames]
          .filter(candidate => sameDedupFamily(sanitizeInboxName(candidate), safe)).length
        const target = dedupTargetPath(inboxDir, safe, index)
        const tmp = `${target}.dsh-inbox-tmp-${process.pid}`
        try {
          await writeFile(tmp, bytes)
          await rename(tmp, target)
        } catch (error) {
          await rm(tmp, { force: true }).catch(() => {})
          throw new InboxError('fs-error', `cannot write "${basename(target)}": ${error instanceof Error ? error.message : String(error)}`)
        }
        writeJson(res, 200, { ok: true, value: { path: target } })
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-file-drop-inbox: /inbox routes')
}

export { dirname }
