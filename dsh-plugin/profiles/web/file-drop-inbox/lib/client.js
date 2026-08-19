window.__ModuleLoader__.load({
	id: "dsh-file-drop-inbox",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/**
		 * dsh-file-drop-inbox — client half.
		 *
		 * Intercepts whole-page file drops in the CAPTURE phase (before the
		 * built-in InputBar document listeners, which run on bubble and would
		 * reject non-images with "仅支持图片"). Splits the drop:
		 *   - non-image files → POST /inbox/upload (host writes them under
		 *     <cwd>/.dsh/inbox) → each saved path is inserted as a composer
		 *     reference chip whose label is the file name only. Submit
		 *     serializes the chip to `[name](<absolute path>)` so the chat
		 *     bubble can render an openable link (click → Host opens the
		 *     document) and the model can read from its target;
		 *   - image files → re-dispatched as a fresh drop to the built-in
		 *     image intake (rail pre-check and host limits still apply).
		 * A pure-image drop is left untouched: the built-in intake owns it.
		 *
		 * Zero dependencies: only the runtime services (sessions,
		 * inputTriggers) and fetch. This file IS the built bundle
		 * (exports["./client"]); edit here.
		 */
		var IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

		/**
		 * Reference source that owns dropped-file chips. Empty candidates: it
		 * never appears in the @ menu; it exists so submit can serialize each
		 * occurrence back to `[name](<absolute path>)`.
		 */
		var SOURCE_NAME = "inbox-file";

		/** Services required before mounting (session list + chip serializer). */
		var inject = ["sessions", "inputTriggers"];

		/** Base64-encode bytes without a Node global (browser btoa, chunked). */
		function bytesToBase64(bytes) {
			var binary = "";
			var chunk = 0x8000;
			for (var i = 0; i < bytes.length; i += chunk) {
				binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
			}
			return btoa(binary);
		}

		/**
		 * Upload one file through the fenced /inbox/upload route. Dedup is
		 * per-message, so the request carries the dedup context: the labels of
		 * chips already in the current draft plus the raw names uploaded
		 * earlier in this same drop batch. The host derives the suffix purely
		 * from those — a fresh message always gets the bare name again.
		 * @param draftNames - labels of chips already in the current draft.
		 * @param batchNames - raw names uploaded earlier in this drop batch.
		 */
		async function uploadOne(sessionId, cwd, file, draftNames, batchNames) {
			var data = await file.arrayBuffer();
			var response = await fetch("/inbox/upload", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId: sessionId,
					cwd: cwd === undefined || cwd === "" ? undefined : cwd,
					name: file.name,
					data: bytesToBase64(new Uint8Array(data)),
					draftNames: draftNames,
					batchNames: batchNames
				})
			});
			var parsed = null;
			try { parsed = await response.json(); } catch (e) { /* non-JSON error body */ }
			if (!response.ok || parsed === null || parsed.ok !== true) {
				var message = parsed !== null && parsed.error && parsed.error.message
					? parsed.error.message
					: "HTTP " + String(response.status);
				throw new Error(message);
			}
			return parsed.value.path;
		}

		/**
		 * Clear the built-in drop overlay: the InputBar shows it from its own
		 * document dragenter count; we stopped the drop before its bubble
		 * handler could reset it, so a synthetic dragleave (carrying a Files
		 * type) brings the count back to zero.
		 */
		function resetOverlay() {
			try {
				var dt = new DataTransfer();
				dt.items.add(new File([""], "dsh-inbox-reset"));
				document.dispatchEvent(new DragEvent("dragleave", { dataTransfer: dt }));
			} catch (e) {
				// Overlay state is cosmetic; the drop itself is already handled.
			}
		}

		/** Re-dispatch the image subset as a fresh drop for the built-in intake. */
		function handImagesToIntake(images) {
			try {
				var dt = new DataTransfer();
				for (var i = 0; i < images.length; i += 1) dt.items.add(images[i]);
				document.dispatchEvent(new DragEvent("drop", {
					dataTransfer: dt, bubbles: true, cancelable: true
				}));
			} catch (e) {
				// Mixed-drop images degrade to a no-op; non-images are already saved.
			}
		}

		/** Basename of a saved path (separators normalized to '/'). */
		function fileNameOf(path) {
			var target = path.replace(/\\/g, "/");
			var name = target.slice(target.lastIndexOf("/") + 1);
			return name === "" ? target : name;
		}

		/**
		 * Absolute saved path → markdown file link `[<name>](<target>)`:
		 * the chip serializes to this on submit (and copies this on
		 * clipboard). The angle-bracketed target carries the full path
		 * (separators normalized to '/', valid on Windows) so the model
		 * can extract and read the file from the link.
		 */
		function linkifyPath(path) {
			var target = path.replace(/\\/g, "/");
			return "[" + fileNameOf(path) + "](<" + target + ">)";
		}

		/** Codec + empty @ source so submit can expand inbox-file chips. */
		function inboxFileSource() {
			return {
				trigger: "@",
				name: SOURCE_NAME,
				candidates: function () { return Promise.resolve([]); },
				onPick: function () { return undefined; },
				codec: {
					clipboardText: function (ref) { return linkifyPath(ref); },
					serialize: function (ref) { return Promise.resolve(linkifyPath(ref)); }
				}
			};
		}

		/**
		 * Insert each saved path as a filename-only composer chip. Submit
		 * expands the chip to `[name](<absolute path>)` via the inbox-file
		 * codec; the bubble then renders that markdown as an openable link.
		 */
		function insertDraft(ctx, sessionId, paths, failed) {
			try {
				var actx = ctx.sessions.scope(sessionId);
				var conversation = ctx.get("conversation");
				if (actx === undefined || conversation === undefined) return;
				var input = conversation.input.for(actx);
				if (failed.length > 0) {
					input.notify("error", "文件上传失败：" + failed.join("；"));
				}
				if (paths.length === 0) return;
				if (typeof input.insertReference !== "function") {
					input.notify("error", "当前输入框不支持文件引用，无法插入已保存的文件");
					return;
				}
				var lead = input.state.getSnapshot();
				if (lead.draft.trim() !== "" && !/\s$/.test(lead.draft)) {
					input.setDraft(lead.draft + "\n");
				}
				for (var i = 0; i < paths.length; i += 1) {
					var path = paths[i];
					var snap = input.state.getSnapshot();
					var at = snap.draft.length;
					var ok = input.insertReference({
						source: SOURCE_NAME,
						ref: path.replace(/\\/g, "/"),
						label: fileNameOf(path),
						clipboardText: linkifyPath(path)
					}, { start: at, end: at, draftRev: snap.draftRev });
					if (!ok) {
						input.notify("error", "无法将文件插入输入框：" + fileNameOf(path));
					}
				}
			} catch (error) {
				console.warn("[dsh-file-drop-inbox] draft insert failed:", error);
			}
		}

		/** Upload non-images, insert paths, and hand images to the intake. */
		async function handleDrop(ctx, sessionId, cwd, images, nonImages) {
			var paths = [];
			var failed = [];
			// Per-message dedup context: the chips already sitting in the
			// current draft (a fresh message is empty, so its first upload
			// takes the bare name regardless of what earlier messages left in
			// `.dsh/inbox`), plus the names this drop batch already uploaded.
			var actx = ctx.sessions.scope(sessionId);
			var conversation = actx === undefined ? undefined : ctx.get("conversation");
			var input = conversation === undefined ? undefined : conversation.input.for(actx);
			var draftNames = input === undefined
				? []
				: input.state.getSnapshot().occurrences.map(function (occurrence) { return occurrence.label; });
			var batchNames = [];
			for (var i = 0; i < nonImages.length; i += 1) {
				try {
					paths.push(await uploadOne(sessionId, cwd, nonImages[i], draftNames, batchNames));
					batchNames.push(nonImages[i].name);
				} catch (error) {
					failed.push(nonImages[i].name + "（" + (error instanceof Error ? error.message : String(error)) + "）");
				}
			}
			if (images.length > 0) handImagesToIntake(images);
			insertDraft(ctx, sessionId, paths, failed);
		}

		/**
		 * Client plugin body.
		 * @param ctx - the client cordis root context (sessions, get, effect).
		 */
		function apply(ctx) {
			var inputTriggers = ctx.get("inputTriggers");
			if (inputTriggers !== undefined) {
				ctx.effect(function () {
					return inputTriggers.registerSource(inboxFileSource());
				}, "dsh-file-drop-inbox: inbox-file source");
			}
			var onDrop = function (event) {
				var dt = event.dataTransfer;
				if (dt === null) return;
				if (!dt.types || !dt.types.includes("Files")) return;
				var files = Array.prototype.slice.call(dt.files);
				if (files.length === 0) return;
				var images = files.filter(function (file) { return IMAGE_TYPES.indexOf(file.type) !== -1; });
				var nonImages = files.filter(function (file) { return IMAGE_TYPES.indexOf(file.type) === -1; });
				if (nonImages.length === 0) return; // pure-image drop: built-in intake owns it
				event.preventDefault();
				event.stopPropagation();
				resetOverlay();
				var list = ctx.sessions.list.getSnapshot();
				var sessionId = list.current;
				if (sessionId === undefined) return; // no session: nothing to attach to
				var cwd = list.byId[sessionId] !== undefined ? list.byId[sessionId].cwd : undefined;
				handleDrop(ctx, sessionId, cwd, images, nonImages).catch(function (error) {
					console.warn("[dsh-file-drop-inbox] drop handling failed:", error);
				});
			};
			ctx.effect(function () {
				document.addEventListener("drop", onDrop, true); // capture: before InputBar
				return function () {
					document.removeEventListener("drop", onDrop, true);
				};
			}, "dsh-file-drop-inbox: drop interception");
		}

		module.exports = { inject: inject, apply: apply };
		return module.exports;
	}
});