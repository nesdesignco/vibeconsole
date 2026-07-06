# Project Notes

## Session Notes

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
