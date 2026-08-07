# Project Notes

## Session Notes

### [2026-08-07] Deep System Review and Verified Fixes
- Ran a five-track review (security, main process, renderer, build/release, tests/quality) and then fixed only the findings that were reproduced first-hand, in five separate commits. Findings that were real but need design decisions were deliberately left out and are listed at the end of this entry.
- **Git flag injection (critical, exploited end to end).** `gitPull`/`gitPush` passed the branch name to git unvalidated. The name is not user-typed: `gitAheadBehind` reads it from `git branch --show-current`, which echoes whatever `.git/HEAD` contains, and the renderer sends it back. A project shipped as an archive with `ref: refs/heads/--upload-pack=/path/evil.sh` turned one click on Pull into local command execution — and it fires even with no `origin` remote. Fixed by sharing `isValidBranchName` through `gitExecUtils` plus a backstop in all three git exec paths that rejects `--upload-pack`/`--receive-pack`/`--exec`, which the app never uses legitimately.
- **Git status parsing.** Status was read without `-z`/`core.quotepath=false`, so `café.txt` arrived as the literal `"caf\303\251.txt"` and every follow-up pathspec built from it failed. Parsing now consumes NUL-delimited records, which also removes the ` -> ` rename ambiguity (in `-z` mode the old path is its own record and the field order is reversed).
- **Terminal link regex.** The pattern required a match to start with `/`, `./` or `../`, so `src/renderer/editor.js:42` — the form linters, test runners and git actually print — was never clickable. Bare relative paths now match, with the first segment barred from containing a dot so bare domains stay with `urlLinker` rather than being stolen by the file-path provider.
- **PTY output.** Every node-pty chunk was its own IPC message. Output is now coalesced per ~8ms frame with a 256KB cap, flushed on exit and destroy so trailing output is never lost; a 50-chunk burst became one message in test.
- **Discard-all consistency.** Bulk discard used `git clean -fd` (permanent) while single-file discard trashes. Both now trash, using `ls-files --others --exclude-standard --directory -z` so a wholly-untracked directory is one entry, matching `clean -fd` scope while respecting gitignore.
- `LC_ALL=C` added to `buildExecEnv` — several call sites classify git results by matching English stderr and nothing pinned the locale. Only the git helpers use that env; the terminal builds its own, so shell output is unaffected.
- Packaging: `*.map` excluded from both `dist/` and `node_modules/`. Measured on a `--dir` package the asar drops 109MB → 90MB from the node_modules exclusion alone, with a further 44MB of dist maps no longer shipping. Verified the packaged binary still boots with `VIBE_SMOKE=1`.
- Release workflow now fails fast unless the ref is a `v*` tag: the version check was tag-conditional, so a manual dispatch from a branch skipped it and reached `action-gh-release` with the branch name, which with `overwrite_files` could replace artifacts electron-updater clients consume.
- Removed six IPC channels with no working pair (two referenced nowhere, three listener-only, one self-echoing relay). Every constant automatically widens the preload allowlist, so these were dead attack surface.
- Test count 111 → 131. New coverage: the crafted-HEAD exploit, the git exec backstop, non-ASCII paths and renames end to end, PTY coalescing/flush ordering, trash-vs-delete semantics, and `filePathLinker`'s first tests (extracted `findFilePathMatches` to make the pattern testable without xterm).
- **Deliberately not fixed, still open.** Path containment is validated against a renderer-supplied base — `isPathWithinProjectContent(filePath, projectPath)` takes both arguments from the same IPC message, so `{projectPath: '/', filePath: '~/.ssh/id_rsa'}` passes. Confirmed by reading the handlers. The real fix is holding the project root authoritatively in the main process and having handlers accept a project id; that touches dozens of handlers and deserves its own session. Mitigating context: the renderer already holds `TERMINAL_INPUT_ID`, so this is defense-in-depth, not an independent hole. Also open and unverified here: SSRF DNS-rebinding TOCTOU in `droppedFiles`, OSC 8 links opening without confirmation, the file-tree watcher not filtering `node_modules`/`.git` before its synchronous rescan, no single-instance lock, and prompt-history file permissions.

### [2026-07-23] Terminal Link Clicks Made Reliable (Root Cause Found)
- Root cause of the long-standing "links never open" complaint: xterm's native Linkifier activation is identity-fragile — any viewport re-render between mousedown and mouseup (TUIs like Codex/Claude Code redraw on mouse reports and stream output constantly) recreates the link object and the `_mouseDownLink === _currentLink` check silently fails. Links only ever worked in an idle plain shell.
- Second gap: WebLinksAddon only linkifies `http(s)://` text (its internal `isUrl()` also rejects protocol-less matches even with a custom `urlRegex`), so bare domains printed by AI CLIs (`form-drive.vercel.app`, `github.com/user/repo`) were never clickable in any version.
- Fixes: new `src/shared/urlUtils.js` (curated-TLD bare URL regex, trailing-punctuation stripping, protocol normalization, column hit-testing) + `src/renderer/urlLinker.js` with a bare-URL `ILinkProvider` and a capture-phase click fallback that re-runs its own hit-test (incl. OSC 8 via guarded internal API) when native activation did not handle the click; 500 ms same-URL dedupe prevents double-opens. `openExternalSafely` now normalizes as defense-in-depth and logs drops/failures instead of swallowing them.
- Added `VIBE_USER_DATA_DIR` env override so test/dev instances never share userData with a running installed app.
- Verified end-to-end with a Playwright `_electron` driver clicking real links in the running app (full URL, parenthesized, bare domain, www, localhost, OSC 8, and under DECSET 1000/1002/1006 mouse capture): 8/8 scenarios green across consecutive runs; prepared the `1.3.11` patch release.

### [2026-07-14] Codex Usage Windows and Terminal Link Handling
- Corrected Codex quota placement by classifying primary and secondary rate-limit windows from `window_minutes`, while preserving positional fallback behavior for older CLI session data that omits the field.
- Routed OSC 8 terminal hyperlinks through the same protocol-restricted external URL IPC path as detected web links, removing xterm's generic danger confirmation for trusted user clicks without weakening the main-process protocol allowlist.
- Added regression coverage for weekly-only, reordered, conflicting, and legacy Codex rate-limit windows plus OSC 8 external link forwarding; prepared the `1.3.10` patch release.

### [2026-07-11] English-Only VibeConsole Project Context Setup
- Added an English-only Initialize Context / Audit Context action to the project file header. It checks the canonical context package (`STRUCTURE.json`, `PROJECT_NOTES.md`, and `tasks.json`) plus root instruction-file presence through a restricted status-only IPC handler, then prepares a provider-neutral workflow prompt in a ready Claude Code or Codex terminal without submitting it.
- Existing context files, `AGENTS.md`, and `CLAUDE.md` are treated as human-owned input and are never overwritten automatically. The terminal workflow requires evidence collection, complete content for missing files or focused diffs for existing files, and explicit approval before any write; it does not create a new instruction file when both are absent.
- Added authoritative CLI-process readiness state to terminal sessions so automated prompt preparation waits for the actual selected AI process instead of relying on a fixed startup delay.
- Validation completed: lint, typecheck, 93 unit tests, renderer build, and the real Electron smoke test passed.
- Prepared the `1.3.9` release and added a fail-fast release guard so pushed `v*` tags must match the version in `package.json` before signing and notarization begin.

### [2026-07-10] Process-Based AI Tool Detection for the Usage Bar
- Root-caused the usage bar showing the wrong provider (Codex quota during a Claude session) and spurious N/A: the per-terminal `aiTool` tag was set only by a keystroke heuristic, never verified against the running process, and never cleared on CLI exit; shell-history recall and tab completion bypassed detection entirely.
- Added `src/main/aiToolProcessDetector.js`: one `ps -ax` walk per 3s tick resolves each PTY shell's descendant tree to `claude`/`codex`/null (exact basename match, null debounced over 2 ticks) and pushes a full snapshot over the new `TERMINAL_AI_TOOL_DETECTED` channel; the renderer applies it as the authoritative signal with a 5s grace window protecting freshly typed start commands. Keystroke heuristic stays for instant feedback (now case-insensitive, basename-aware, shared in `src/shared/aiToolDetection.js`).
- Claude usage errors (401/non-200/parse) now fall back to last-good cached values so the UI shows stale data with a "Warning:" tooltip instead of N/A.
- Codex usage windows whose `resets_at` has passed are rendered as 0% (`applyWindowExpiry`, a non-mutating view over the cache) with data age and a reset note in the tooltip — previously the last recorded percentage was shown forever with "(soon)".
- Updater hardening for 1.3.8: install is blocked with a clear message when running from the DMG or under App Translocation (Squirrel can't replace read-only bundles); INSTALL_UPDATE is re-entry guarded; the modal shows an "Installing update…" state; the manual unsigned-install script (extracted to `src/main/updaterInstallScript.js`, unit-tested) now swaps the bundle with rollback instead of delete-then-move; hourly re-checks no longer regress a downloaded update back to "available".

### [2026-07-06] Updater Notes and Sidebar Layout Hardening
- Added a safe release-notes renderer for GitHub HTML so update modals do not expose raw `<h2>`, `<ul>`, or anchor markup.
- Kept updater release-note links on the existing external-url IPC path and added regression coverage for GitHub HTML, fallback HTML stripping, and Markdown rendering.
- Reworked the toolbar update badge into an inline pill to avoid titlebar clipping.
- Stabilized sidebar project/file-tree scroll gutters and constrained deep file-tree indentation so nested paths truncate instead of causing horizontal sidebar movement.

### [2026-07-06] Monaco-Based Editor Upgrade
- Replaced the file editor text surface with a Monaco-backed adapter while preserving the existing Electron IPC read/write path, SVG/image preview flow, and textarea fallback.
- Added a dedicated Monaco worker build step so editor, JSON, CSS, HTML, and TypeScript workers are emitted into `dist/` for packaged Electron use.
- Added a Lucide-backed editor tool strip for Monaco actions (`find`, `replace`, `go to line`, command palette, format, undo/redo), view toggles, and app-space fullscreen mode.
- Set `maxNodeModuleJsDepth: 0` in `jsconfig.json` so `tsc --checkJs` continues checking application code without descending into Monaco's bundled dependency JavaScript.

### [2026-07-06] Stable macOS DMG Download Link
- Added a fixed DMG artifact name for release builds so the public direct-download URL can remain stable across versions: `VibeConsole-mac.dmg`.
- Made the release workflow explicitly overwrite same-named assets on reruns and fail when expected release files are missing.
- Coordinated the website CTA target with the stable direct-download asset in the separate `vibeconsoleweb` project.

### [2026-02-13] Public Readiness Pass
- TODO: Capture notable decisions and fixes made while preparing the repository for a public push.

### [2026-02-17] GitHub Panel Refactor (Items 1 and 2)
- User: "tamam 1 ve 2 yi planla ama çok emin ol %100 doğru yapılmalı"
- Assistant: Proposed a safety-first plan with phased execution and strict validation gates (`lint`, `test`, manual interaction matrix).
- User: "tamam devam et"
- Work completed in this session:
  - Event binding refactor to delegated handling for Git changes/stash interactions.
  - `githubPanel.js` internal modularization with extracted state/render/event helpers.
  - `STRUCTURE.json` updated after adding new modules.
  - Validation run: lint passed, tests passed.
- User: "ok"

### [2026-02-17] TerminalTabBar Lifecycle Hardening
- User: "tmm devam et refactore edilcek bişiy varsa"
- Assistant: Identified low-risk high-impact refactor in `terminalTabBar` listener lifecycle (IPC/state listeners could survive component teardown).
- Work completed in this session:
  - Added explicit IPC listener registry/cleanup flow in `src/renderer/terminalTabBar.js`.
  - Added state subscription cleanup support by returning unsubscribe from `state.onProjectChange`.
  - Extended `TerminalTabBar.destroy()` to release listeners and remove detached toolbar/menu DOM nodes.
  - Validation run: lint passed, tests passed.
- User: "evet profesyonel hale getir"
