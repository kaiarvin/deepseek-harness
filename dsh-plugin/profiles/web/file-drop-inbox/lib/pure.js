/**
 * Pure helpers shared by the host half and its node:test suite. No cordis,
 * no Node-only imports beyond node:path and node:fs/promises (client-reachable
 * code must stay free of Node globals, so base64 encoding lives in the
 * client bundle).
 * @module dsh-file-drop-inbox/pure
 */
import { basename, dirname, extname, join, resolve } from 'node:path'

/** Characters illegal in Windows file names (also invalid on POSIX as '/'). */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * Reduce an arbitrary browser file name to a safe single path segment:
 * the basename, illegal characters replaced by '_', leading dots/trailing
 * dots+spaces stripped (Windows hides/terminates them), and an empty result
 * falling back to 'file'.
 * @param name - browser-reported file name (may contain path separators).
 * @returns a safe single segment.
 */
export function sanitizeInboxName(name) {
  const base = basename(name.replace(/\\/g, '/')).trim()
  const cleaned = base
    .replace(ILLEGAL, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  return cleaned === '' ? 'file' : cleaned
}

/**
 * Whether two sanitized names belong to the same dedup family: same stem and
 * extension, with the stem either bare or `-<digits>`-suffixed. Per-message
 * dedup counts family members — the draft chip `claude_config-1.json` and a
 * fresh `claude_config.json` upload both count toward the next index, so the
 * third same-name upload in one message is `-2`, never a re-write of `-1`.
 * @param name - sanitized candidate (e.g. a draft chip label).
 * @param safe - sanitized name being uploaded.
 * @returns whether `name` occupies a slot in `safe`'s dedup family.
 */
export function sameDedupFamily(name, safe) {
  const extName = extname(name)
  const extSafe = extname(safe)
  if (extName !== extSafe) return false
  const stem = extName === '' ? name : name.slice(0, -extName.length)
  const stemSafe = extSafe === '' ? safe : safe.slice(0, -extSafe.length)
  if (stem === stemSafe) return true
  if (!stem.startsWith(`${stemSafe}-`)) return false
  return /^\d+$/.test(stem.slice(stemSafe.length + 1))
}

/**
 * The dedup-indexed target path for a sanitized name: the bare name at index
 * 0, otherwise `stem-i.ext` (so `app.log` → `app-1.log`).
 * @param dir - absolute inbox directory (created by the caller).
 * @param name - already-sanitized single segment.
 * @param index - the dedup index for this upload (0 = the bare name).
 * @returns the absolute target path.
 */
export function dedupTargetPath(dir, name, index) {
  if (index === 0) return join(dir, name)
  const ext = extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  return join(dir, `${stem}-${index}${ext}`)
}

/**
 * Whether `target` lies under `base` (or equals it), tolerant of separator
 * style and — on Windows, where the filesystem is case-insensitive — of
 * letter case. Mirrors the dsh-better-sidebar guard so a case-mismatched or
 * mixed-separator path can never be misclassified.
 * @param base - the containing directory (absolute).
 * @param target - the path to test (absolute).
 * @param platform - filesystem semantics; injectable for tests.
 */
export function isWithin(base, target, platform = process.platform) {
  const norm = (value) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const b = norm(base)
  const t = norm(target)
  if (platform === 'win32') {
    const lb = b.toLowerCase()
    const lt = t.toLowerCase()
    return lt === lb || lt.startsWith(`${lb}/`)
  }
  return t === b || t.startsWith(`${b}/`)
}

/**
 * Normalize a caller-supplied path to an absolute, resolved path.
 * @param path - absolute (POSIX or drive-letter) path.
 * @returns the resolved absolute path.
 * @throws {Error} when the input is not absolute.
 */
export function requireAbsolute(path) {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`"${path}" is not an absolute path`)
  }
  return resolve(path)
}

/**
 * Format a saved absolute path as a markdown file link `[<name>](<target>)`:
 * the link text is the file name only, the angle-bracketed target carries
 * the full path with separators normalized to '/' (valid on Windows), so a
 * model can extract and read the file from the link. The client bundle
 * mirrors this implementation (it cannot import this module) and uses the
 * same string as the inbox-file chip's submit serialization.
 * @param path - absolute saved path, any separator style.
 * @returns markdown inline link.
 */
export function fileLinkText(path) {
  const target = path.replace(/\\/g, '/')
  const name = target.slice(target.lastIndexOf('/') + 1) || target
  return `[${name}](<${target}>)`
}

/** Parent directory of a path (dirname), re-exported for the host's bounds check. */
export { dirname }
