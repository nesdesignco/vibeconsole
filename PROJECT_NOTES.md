# Project Notes

## Session Notes

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
