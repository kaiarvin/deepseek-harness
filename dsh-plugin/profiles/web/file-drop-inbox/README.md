# dsh-file-drop-inbox

English | [中文](README.zh.md)

DSH web plugin: drop non-image files (logs, configs, etc.) into the window, save them to the current session workspace's `.dsh/inbox/`, and insert a **filename-only** reference chip in the composer (clicking the chip opens the file on the host machine directly). On send the chip serializes to the markdown hyperlink `[filename](<absolute path>)` — the message bubble renders that link as a **clickable file link** (clicking opens the document on the host, same as deliverable chips), and the model can resolve the path from the link target and `read` the file directly, without waiting for the official generic attachment feature.

Images (PNG/JPG/WebP/GIF) are unaffected: pure-image drops still go through the built-in image intake (attachment rail + host limits); mixed drops send images to the attachment rail and non-images to the inbox.

## How it works

- **Host half** (`lib/index.js`): mounts a fenced route `POST /inbox/upload`. The request carries `sessionId`, `cwd` (best effort), `name`, `data` (base64), and the **current draft's dedup context** (`draftNames`: filenames of chips already in the draft; `batchNames`: filenames already uploaded in this drop batch). The session cwd wins (session header first); the file is written to `<cwd>/.dsh/inbox/<name>`. Same-name dedup counts **only within the current message** — a `-1`/`-2` suffix (before the extension) is added only when the draft already has a same-name chip (or the same batch uploads several same-name files); a fresh message's first drop always gets the bare name, and historical conversations or existing files on disk never count. Writes use tmp + rename, and path checks guarantee the file cannot escape the session cwd. The route carries the same browser trust fence as the `/api` gateway (loopback / `webRuntime.trustedHosts`, rejects cross-site).
- **Client half** (`lib/client.js`): a document-level capture-phase `drop` listener (ahead of the built-in InputBar bubble listener). When non-image files are present it calls `preventDefault` + `stopPropagation`, uploads, then inserts each file as a composer reference chip (chip label is filename-only; clicking the chip opens the file directly — the host `openFile` path, same as bubble links). The plugin also registers an empty `@inbox-file` trigger source providing only the codec: on send the chip serializes to `[filename](<absolute path>)`. The image subset re-dispatches a drop to the built-in intake. Pure-image drops are untouched.
- **Bubble rendering** (user-message projection in the DSH `ui-conversation`): `[filename](<absolute path>)` in user messages is decorated as a clickable link (blue, underline on hover); clicking goes through the chat view's `openFile` (host opens the document) — the same open path as deliverable chips; a non-absolute link target stays literal text.

## Configuration

| Key | Default | Description |
|---|---|---|
| `maxUploadBytes` | `20971520` (20 MB) | Per-file byte limit |
| `inboxDirName` | `.dsh/inbox` | Inbox directory name under the session cwd |

Example (profile `cordis.patch.yml` or bundle override):

```yaml
- id: file-drop-inbox
  config:
    maxUploadBytes: 52428800
    inboxDirName: '.dsh/inbox'
```

## Installation

In the profile directory (or add to `dsh.profile.bundles`):

```sh
pnpm dsh plugin --profile web add ./profiles/web/file-drop-inbox
```

Restart `pnpm dsh web` and hard-refresh the browser. Verify:

```sh
pnpm dsh --profile web --dump-config | grep file-drop-inbox
```

## Tests

```sh
node --test lib/
```

Covers filename sanitization, same-name avoidance, path-escape guards, and the other host pure functions.

## Known limitations

- While hovering during a drag, the built-in overlay still shows "drop an image to add it" — the browser cannot see file contents during `dragover`, so image vs non-image cannot be distinguished early; the behavior splits at drop time.
- Non-images get no model-visible "attachment card": the draft holds a filename chip, and only on send does it become a markdown hyperlink with the full path (clickable in the bubble) — that is exactly the plugin's design (workspace write + path reference).
- Drops with no session (hero page) are ignored (there is no cwd to attribute to).
