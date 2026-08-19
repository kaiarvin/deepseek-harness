/**
 * node:test suite for the host pure helpers. Run: `node --test lib/` from the
 * package directory (zero dependencies, node >= 20).
 * @module dsh-file-drop-inbox/pure.test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dedupTargetPath, fileLinkText, isWithin, requireAbsolute, sameDedupFamily, sanitizeInboxName } from './pure.js'

test('sanitizeInboxName reduces arbitrary names to one safe segment', () => {
  assert.equal(sanitizeInboxName('app.log'), 'app.log')
  assert.equal(sanitizeInboxName('C:\\logs\\app.log'), 'app.log')
  assert.equal(sanitizeInboxName('a/b/c.txt'), 'c.txt')
  assert.equal(sanitizeInboxName('a<b>:c|d?e*f"g.txt'), 'a_b__c_d_e_f_g.txt')
  assert.equal(sanitizeInboxName('..\\..\\evil'), 'evil')
  assert.equal(sanitizeInboxName('.hidden'), 'hidden')
  assert.equal(sanitizeInboxName('trailing...'), 'trailing')
  assert.equal(sanitizeInboxName('   '), 'file')
  assert.equal(sanitizeInboxName(''), 'file')
  assert.equal(sanitizeInboxName('中文日志.log'), '中文日志.log')
})

test('sameDedupFamily groups bare and -n names under one stem + extension', () => {
  assert.equal(sameDedupFamily('app.log', 'app.log'), true)
  assert.equal(sameDedupFamily('app-1.log', 'app.log'), true)
  assert.equal(sameDedupFamily('app-12.log', 'app.log'), true)
  assert.equal(sameDedupFamily('app-1.log', 'app-1.log'), true)
  assert.equal(sameDedupFamily('notes', 'notes'), true)
  assert.equal(sameDedupFamily('notes-3', 'notes'), true)
  // Different stems, extensions, or suffix shapes are not family members.
  assert.equal(sameDedupFamily('other.log', 'app.log'), false)
  assert.equal(sameDedupFamily('app.txt', 'app.log'), false)
  assert.equal(sameDedupFamily('app-x.log', 'app.log'), false)
  assert.equal(sameDedupFamily('app-x1.log', 'app.log'), false)
  assert.equal(sameDedupFamily('app.log', 'app-1.log'), false)
})

test('dedupTargetPath names the target: bare at 0, -n before the extension after', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-inbox-test-'))
  assert.equal(dedupTargetPath(dir, 'app.log', 0), join(dir, 'app.log'))
  assert.equal(dedupTargetPath(dir, 'app.log', 1), join(dir, 'app-1.log'))
  assert.equal(dedupTargetPath(dir, 'app.log', 2), join(dir, 'app-2.log'))
  // No extension: stem + -n.
  assert.equal(dedupTargetPath(dir, 'notes', 0), join(dir, 'notes'))
  assert.equal(dedupTargetPath(dir, 'notes', 3), join(dir, 'notes-3'))
})

test('the message-context index is the family count of draft labels + batch predecessors', async () => {
  // The host's derivation (pure): index = |{draftNames ∪ batchNames} ∩ family(safe)|.
  const indexFor = (draftNames, batchNames, safe) =>
    [...draftNames, ...batchNames]
      .filter(candidate => sameDedupFamily(sanitizeInboxName(candidate), safe)).length
  // Fresh message: no draft chips, no batch predecessors → bare name.
  assert.equal(indexFor([], [], 'claude_config.json'), 0)
  // Second upload in the same message (draft already holds the bare chip) → -1.
  assert.equal(indexFor(['claude_config.json'], [], 'claude_config.json'), 1)
  // Third upload: the draft holds bare AND -1 → -2, never a re-write of -1.
  assert.equal(indexFor(['claude_config.json', 'claude_config-1.json'], [], 'claude_config.json'), 2)
  // One drop with the same name twice: the batch predecessor counts.
  assert.equal(indexFor([], ['claude_config.json'], 'claude_config.json'), 1)
  // On-disk history never counts: a stale disk file does not feed the index.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-inbox-test-'))
  for (let i = 0; i < 5; i += 1) {
    await writeFile(join(dir, i === 0 ? 'x.log' : `x-${i}.log`), String(i))
  }
  const target = dedupTargetPath(dir, 'x.log', indexFor([], [], 'x.log'))
  assert.equal(target, join(dir, 'x.log'))
})

test('isWithin bounds targets under base with platform semantics', () => {
  assert.equal(isWithin('/w/app', '/w/app/a.log', 'linux'), true)
  assert.equal(isWithin('/w/app', '/w/app', 'linux'), true)
  assert.equal(isWithin('/w/app', '/w/app2/a.log', 'linux'), false)
  assert.equal(isWithin('/w/app', '/other/a.log', 'linux'), false)
  // Windows: case-insensitive, separator tolerant.
  assert.equal(isWithin('C:\\Users\\Me\\app', 'c:/users/me/app/file.log', 'win32'), true)
  assert.equal(isWithin('C:\\Users\\Me\\app', 'C:\\Users\\Me\\app2\\file.log', 'win32'), false)
})

test('requireAbsolute accepts absolute paths and rejects relative ones', () => {
  // resolve() prefixes the drive on Windows; assert absolute-ness, not a fixed spelling.
  assert.equal(requireAbsolute('/w/app'), resolve('/w/app'))
  assert.equal(requireAbsolute('C:\\w\\app'), resolve('C:\\w\\app'))
  assert.throws(() => requireAbsolute('relative/path'), /not an absolute path/)
})

test('fileLinkText is the sent form of an inbox-file chip (name-only markdown link)', () => {
  // Windows path: backslashes normalize to '/', link text is the basename.
  assert.equal(
    fileLinkText('C:\\Users\\Me\\proj\\.dsh\\inbox\\app.log'),
    '[app.log](<C:/Users/Me/proj/.dsh/inbox/app.log>)'
  )
  // POSIX path stays as-is.
  assert.equal(
    fileLinkText('/home/me/proj/.dsh/inbox/app.log'),
    '[app.log](</home/me/proj/.dsh/inbox/app.log>)'
  )
  // Spaces in the path survive inside the angle brackets.
  assert.equal(
    fileLinkText('/home/me/my files/app.log'),
    '[app.log](</home/me/my files/app.log>)'
  )
  // No basename (path ends in a separator) falls back to the full target.
  assert.equal(fileLinkText('/a/b/'), '[/a/b/](</a/b/>)')
})

test('client drop path inserts inbox-file chips, not literal markdown', () => {
  const src = readFileSync(fileURLToPath(new URL('./client.js', import.meta.url)), 'utf8')
  assert.match(src, /insertReference/)
  assert.match(src, /name: SOURCE_NAME/)
  assert.match(src, /label: fileNameOf\(path\)/)
  assert.match(src, /serialize: function \(ref\) \{ return Promise\.resolve\(linkifyPath\(ref\)\); \}/)
  assert.equal(src.includes('input.setDraft(draft.trim() === "" ? text : draft + "\\n" + text)'), false)
})

test('inbox directory can be created under cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-inbox-cwd-'))
  await mkdir(join(cwd, '.dsh', 'inbox'), { recursive: true })
  // The guard the host applies: the inbox must stay within the session cwd.
  assert.equal(isWithin(cwd, join(cwd, '.dsh', 'inbox')), true)
  assert.equal(isWithin(cwd, join(cwd, '..', 'escape')), false)
})
