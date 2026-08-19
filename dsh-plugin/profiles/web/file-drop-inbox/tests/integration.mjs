/**
 * Host-half integration test: mounts apply() against a fake ctx, then drives
 * the registered /inbox/upload handler with real request/response faces.
 * Requires the profile environment (resolves @deepseek-ai/schemastery from
 * the profile node_modules): run `node --test tests/` from the profile dir
 * or with the test copied where the plugin package resolves.
 * @module dsh-file-drop-inbox/integration
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from 'dsh-file-drop-inbox'

/** Build a fake IncomingMessage face over a string body. */
function makeReq(body, headers = {}, method = 'POST', url = '/inbox/upload') {
  return {
    url,
    method,
    headers: { host: '127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
  }
}

/** Capture one handler response; read `.status`/`.json` AFTER the call. */
function makeRes() {
  const capture = { status: 0, payload: '' }
  return {
    res: {
      writeHead(code, headers) {
        capture.status = code
        assert.equal(headers['content-type'], 'application/json; charset=utf-8')
      },
      end(text) {
        capture.payload = text
      },
    },
    get status() { return capture.status },
    get json() { return JSON.parse(capture.payload) },
  }
}

/** Mount the plugin against a fake ctx rooted at `cwd`. */
function mount(cwd, config) {
  const routes = []
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    sessions: { get: () => ({ header: { cwd } }) },
    webRuntime: { trustedHosts: [] },
    effect: (fn) => { fn() },
  }
  apply(ctx, { maxUploadBytes: 1024 * 1024, inboxDirName: '.dsh/inbox', ...config })
  return routes[0].handler
}

const base64 = (text) => Buffer.from(text).toString('base64')

test('upload writes under cwd/.dsh/inbox and returns the absolute path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-inbox-int-'))
  const handler = mount(cwd)
  const capture = makeRes()
  await handler(makeReq({ sessionId: 's1', name: 'app.log', data: base64('hello log') }), capture.res)
  assert.equal(capture.status, 200)
  assert.equal(capture.json.ok, true)
  const path = capture.json.value.path
  assert.match(path, /app\.log$/)
  assert.equal(await readFile(path, 'utf8'), 'hello log')
  assert.equal((await stat(join(cwd, '.dsh', 'inbox'))).isDirectory(), true)
  await rm(cwd, { recursive: true, force: true })
})

test('collision-free names: second same-name upload becomes name-1.ext', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-inbox-int-'))
  const handler = mount(cwd)
  const first = makeRes()
  await handler(makeReq({ sessionId: 's1', name: 'app.log', data: base64('one') }), first.res)
  const second = makeRes()
  await handler(makeReq({ sessionId: 's1', name: 'app.log', data: base64('two') }), second.res)
  assert.equal(second.json.value.path.endsWith('app-1.log'), true)
  assert.equal(await readFile(second.json.value.path, 'utf8'), 'two')
  await rm(cwd, { recursive: true, force: true })
})

test('path traversal in the name is neutralized', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-inbox-int-'))
  const handler = mount(cwd)
  const capture = makeRes()
  await handler(makeReq({ sessionId: 's1', name: '..\\..\\evil.txt', data: base64('x') }), capture.res)
  assert.equal(capture.status, 200)
  assert.equal(capture.json.value.path.includes('evil.txt'), true)
  assert.equal(capture.json.value.path.includes('..'), false)
  await rm(cwd, { recursive: true, force: true })
})

test('oversized file is refused with 413', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-inbox-int-'))
  const handler = mount(cwd, { maxUploadBytes: 4 })
  const capture = makeRes()
  await handler(makeReq({ sessionId: 's1', name: 'big.log', data: base64('0123456789') }), capture.res)
  assert.equal(capture.status, 413)
  assert.equal(capture.json.error.code, 'too-large')
  await rm(cwd, { recursive: true, force: true })
})

test('cross-site Host header is refused', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-inbox-int-'))
  const handler = mount(cwd)
  const capture = makeRes()
  await handler(makeReq(
    { sessionId: 's1', name: 'a.log', data: base64('x') },
    { host: 'evil.example', 'sec-fetch-site': 'cross-site' },
  ), capture.res)
  assert.equal(capture.status, 403)
  assert.equal(capture.json.error.code, 'forbidden')
  await rm(cwd, { recursive: true, force: true })
})

test('non-POST and unknown paths are refused', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-inbox-int-'))
  const handler = mount(cwd)
  const get = makeRes()
  await handler(makeReq({}, {}, 'GET', '/inbox/upload'), get.res)
  assert.equal(get.status, 405)
  const unknown = makeRes()
  await handler(makeReq({}, {}, 'POST', '/inbox/other'), unknown.res)
  assert.equal(unknown.status, 404)
  await rm(cwd, { recursive: true, force: true })
})

test('malformed JSON body is refused', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-inbox-int-'))
  const handler = mount(cwd)
  const capture = makeRes()
  const req = {
    url: '/inbox/upload',
    method: 'POST',
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('not json') },
  }
  await handler(req, capture.res)
  assert.equal(capture.status, 400)
  assert.equal(capture.json.error.code, 'bad-request')
  await rm(cwd, { recursive: true, force: true })
})
