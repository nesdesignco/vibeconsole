# Project Notes

## Session Notes

### [2026-09-08] Version 1.3.16 Release Preparation
- Version 1.3.16 packages persistent appearance settings (four light and four dark palettes), shared terminal/editor theming, reviewed skill updates and custom repositories, native scrollbar synchronization, and removal of the dedicated Plugins panel.
- The feature commit passed GitHub CI, including lint, typecheck, unit tests, renderer build, smoke launch, and terminal scroll regressions. Publish through the existing version-tag workflow so the application and DMG receive Apple notarization and updater metadata is regenerated from the final artifacts.

### [2026-09-07] Persistent Appearance Settings
- Added eight palettes (four light and four dark, including Linen and true-black Black), System mode, three styles, and editable interface/terminal colors through the rightmost toolbar Settings button using the existing Lucide icon library. `src/shared/appearance.js` owns palette values, validation, derived CSS variables, and xterm colors; components do not carry separate color palettes.
- Store actual selected color/style values in versioned `userData/appearance.json`, with temporary-file replacement. Updates fill missing fields only. Invalid files and future schema versions block writes and remain untouched. Reset requires explicit confirmation.
- Bootstrap the palette with Electron [WebPreferences.additionalArguments](https://www.electronjs.org/docs/latest/api/structures/web-preferences), apply before the window is shown, and synchronize native surfaces with [nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme). Copy validated settings into mutable renderer state because [contextBridge freezes exposed data](https://www.electronjs.org/docs/latest/api/context-bridge).
- Use public [xterm Terminal.options](https://xtermjs.org/docs/api/terminal/classes/terminal/#options) and Monaco `editor.defineTheme` / `editor.setTheme` (installed `monaco-editor/monaco.d.ts`) to update existing instances. Appearance changes do not recreate PTYs, terminal buffers, or editor models.
- Regression coverage: `test/appearance.test.js` checks persistence across a simulated preset update, validation, and preset text contrast; `test/terminalScrollApp.js` exercises all palettes/styles through production Electron IPC while retaining terminal history and editor undo state. Manual Electron checks cover native System changes, custom HEX keyboard focus, screenshots, and saved settings after a real process restart.

Appearance review passes:
1. Renderer state ownership: normalize frozen bridge snapshots into editable state; repeat mode changes through real IPC.
2. Light/Dark/System transitions: explicit preset selection activates its mode; native System events update appearance.
3. Selection consistency: only the applied preset is marked pressed; inactive saved palettes remain available.
4. Persistence and schema: retain actual user values after restart or preset changes; reject malformed colors, arrays, and future schemas.
5. Write failures: exclusive unique temporary files, cleanup after failed replacement, preserved originals, retry, and symlink refusal.
6. Terminal lifecycle: update every existing terminal, including inactive tabs; preserve history and native scrollbar position across presets/styles.
7. Editor lifecycle: preserve the model, unsaved text, and undo history while updating Monaco colors.
8. Visual consistency: shared corner tokens including Flat zero-radius controls, square color/preset controls, native select arrow spacing, Black backgrounds, and preset text contrast.
9. Keyboard accessibility: inert hidden settings, expanded toolbar state, visible focus, focus restoration after save/close, and confirmed reset.
10. Integration and documentation: verify renderer build, typecheck, unit suite, real Electron launch, screenshots, restart persistence, and the documented Settings behavior.

### [2026-09-07] Reviewed Skill Updates and Native Scrollbar Synchronization
- Skill updates are explicit: stage and review source differences or package versions, verify a backup, apply, and offer rollback. Files changed after review/update are not overwritten. Native plugin sources are verified; linked plugin caches/settings require their native CLI. Interrupted updates retain manual recovery files. Custom edits remain in backups; shared native skill directories remain shared.
- Reproduced a separate xterm 5.5 remount defect: buffer content remained at bottom while DOM scrollTop reset to zero; the next downward wheel jumped upward. Measurable remounts now rebase xterm's cached scrollTop before native viewport synchronization. Normal fits preserve pending wheel input. Regression coverage measures the native scrollbar, with 45 isolated and 22 full-app PTY checks passing.

### [2026-09-07] Skills Catalog Correction
- Removed Anthropic Frontend Design from the app catalog and website preview, including its plugin-specific detection branch and unused illustration. Existing personal skill installations are preserved.
- Replaced the Skills lightning icon with Lucide BookOpen in the app toolbar and website; Design DNA now uses its author's GitHub profile image supplied by the user.
- Further UI catalog selection should prioritize UI-focused open-source skill repositories by verified GitHub stars. These corrections are local only; the user explicitly prohibits commits, pushes and releases without renewed authorization.
- Added the user-requested Taste Skill and Scrollcraft repositories to both catalogs. The shared native-skill installer handles both. Scrollcraft's current `scroll-craft` name also recognizes existing `scrollcraft` folders and copies the installed command name, preserving customized legacy installs. Verified both tools are detected as installed for Claude and Codex on this machine without running an installer.
- Removed Vercel Web Design Guidelines from both catalogs at the user's request. The UI list is now Taste Skill, Impeccable, Scrollcraft and Design DNA.
- Added the Brain category with Obsidian Skills, QMD, Basic Memory, Obsidian Wiki, Graphiti and Cognee. CLI installation and external service setup have distinct actions; services are not reported as installed without verification.
- My Skills stores validated GitHub repository roots atomically in the app userData directory. Adding and removing catalog entries never deletes installed skill files. Installation opens the existing skills CLI chooser with overwrite confirmations; repository status follows source-lock records and the selected agent's skill directories. VibeConsole does not automatically update these installations.
- All skill cards use repository-linked names as headings and purpose statements as subtitles. RTK's installed-state action is labeled Configure Claude Code/Codex to distinguish agent integration from binary installation. Copy-command actions remain available for installed native skills.

### [2026-09-07] Shared Skills UI and Design Catalog
- Skills now has keyboard-accessible Token Saver and UI category tabs, using one catalog, renderer and installation path. The UI catalog includes Impeccable, Design DNA, Anthropic Frontend Design and Vercel Web Design Guidelines, verified against their public repositories.
- Native user skill directories are checked alongside plugins, including legacy Codex and shared agent skill locations. Existing customized copies are preserved. UI skills expose a copy-command action rather than token-saving mode controls; plugin toggles are offered only for managed plugin installations.
- Impeccable uses its Claude marketplace or its provider-specific global Codex installer. Codex project hooks are explicitly excluded from this user-wide installation and remain an optional, separately trusted project setup.
- File tree, Skills and Git refresh buttons reference one SVG symbol. Skills reuses the existing spinner helper and status badge styles. Official tool artwork is bundled locally; UI skills without a verified project mark use attributed Lucide illustrations.

### [2026-09-07] Version 1.3.15 Local Signed Build
- Bumped package and lockfile versions to 1.3.15 for the terminal scrollback/hidden-layout fixes and optional Skills panel. Built Apple Silicon application, DMG, ZIP and updater metadata under `release/v1.3.15` with publication disabled.
- Verified that packaged renderer/preload bundles, Skills modules, PTY manager and HTML match the checkout. The packaged application passed an isolated smoke launch (`VIBE_SMOKE_OK`) without sharing userData with the installed app.
- Application and DMG passed Developer ID signature/notarization and Gatekeeper checks; both Apple tickets were stapled and validated. Refreshed the DMG blockmap after stapling and verified both artifact sizes and SHA-512 values against `latest-mac.yml`.
- No installed application was replaced and no GitHub release was published.

### [2026-09-07] Scrollback Clear and Hidden Layout Regressions
- Reviewed the prior scroll fixes (`f30a52b`, `f4a0578`, `f5971e9`, `a621e82`), current PTY coalescing/IPC, mount lifecycle, grid rendering, fit callers, and xterm's parser/viewport implementation. The old 24 Chromium cases passed while new output-protocol and hidden-layout cases failed.
- Reproduced xterm 5.5's ED3 bug: after reading history, `ESC[3J` followed by 200 output lines left `viewportY=0`, `baseY=200`. This is the upstream issue [xtermjs#6046](https://github.com/xtermjs/xterm.js/issues/6046), fixed upstream by [#6081](https://github.com/xtermjs/xterm.js/pull/6081). Added a disposable parser addon using public APIs to reset follow-output before normal-buffer ED3/DECSED3 processing. It does not strip output, restore stale positions, affect ED2, or change normal-buffer scroll intent from the alternate screen. Remove the compatibility addon when the installed xterm includes the upstream fix and these tests pass without it.
- Reproduced hidden-layout corruption: `isConnected` allowed fitting through a `display:none` ancestor, shrinking 51x28 to 10x6 and reflowing/trimming history. On reveal, the same viewport offset displayed transcript line 268 instead of line 70; the missing history could not be restored. All fit paths now skip elements with zero client width/height before touching xterm or sending PTY resize.
- Expanded the real Chromium suite to 38 cases, including split/C1 escape sequences, alternate screens, background clears, zero remaining history, and hidden layout. Test history setup waits for the first paint after `reset()` because parser completion alone does not restore xterm's DOM row metrics.
- Added 9 full-app integration cases with real shell output through node-pty, output coalescing, preload IPC, toolbar, debounced rendering and ResizeObserver. Both suites now run under `npm run test:scroll` (renderer/preload build required) and in CI under Xvfb. Each app test uses temporary userData and explicitly destroys its own PTYs.
- Validation: 191 unit tests, 47 Electron scroll/integration cases, lint, typecheck and renderer build passed. No installed app was replaced and no release was published; the built checkout contains the fixes.

### [2026-09-07] Optional Token Saver Tools in a Dedicated Skills Panel
- Added a separate Skills toolbar action and Token Saver catalog containing RTK, Headroom, Caveman, and Ponytail, with independent Claude Code and Codex views.
- Installation uses native user-scoped tools: Claude plugins, the Ponytail Codex plugin, the global Caveman Codex skill, Homebrew for RTK, and an isolated uv tool environment for Headroom. Listing and app startup never install, upgrade, or enable tools. Existing installations are detected before installation, including after module/app reload; disabled plugins stay disabled. No tools are bundled into or removed with an app update.
- RTK setup/removal and Headroom wrap/unwrap open a fresh terminal so interactive setup never lands in an existing agent conversation. Binary installation is displayed separately from session activation. RTK's Codex integration supplies agent guidance; it is not presented as guaranteed command rewriting.
- Claude plugin toggles use the CLI. Codex plugin management and hook trust remain native to Codex. Lite/Full/Ultra/Off buttons copy explicit session commands; they do not claim to change a running agent's mode.
- Installer tests use temporary user profiles and mocked CLI execution to verify persistence, provider isolation, duplicate prevention, exact installation scope, source checks, and retry behavior. Real Electron UI checks use simulated installation states without installing third-party tools into the developer's profile.
- Validation: all 191 unit tests, lint, typecheck, renderer build, 12 isolated Electron UI checks, and the full-app smoke test with temporary userData passed. STRUCTURE.json was regenerated. No signed release was built or published.

### [2026-09-06] Version 1.3.14 Release Preparation
- Bumped package and lockfile versions to 1.3.14 for the verified editor, Git, updater, and mapped-IPv6 fixes. All 179 tests, lint, typecheck, and renderer build passed; the installed application was not opened.
- Built Apple Silicon artifacts under `release/v1.3.14`. Verified the packaged main-process files and renderer/preload bundles match the checkout, and the embedded package version is 1.3.14. The application passed Developer ID signature verification, notarization, stapler validation, and Gatekeeper assessment. Publication also requires a separately notarized/stapled DMG and matching ZIP/DMG update hashes.

### [2026-09-06] Follow-up Editor Review Regressions Closed
- The review found two uncovered cases: undoing back to the original buffer while a different snapshot was still being written allowed an unprompted close, and a failed new-file read left the previous document visible with no save target. Both reproduced in new tests before the fixes.
- Closing or opening another file now waits for pending save acknowledgements: the editor remains open and shows a saving status until the write finishes. The resulting saved baseline then determines whether the user's latest buffer still needs an unsaved-change confirmation. Failed writes also release the pending-save guard.
- File opening now keeps the active document, project, content, and view mode intact until the requested data loads successfully. SVG text and image reads commit together; a failure invalidates the pair and preserves the previous document. Edits made during a pending read require a fresh discard decision, and saving the visible document cancels pending navigation so its acknowledgement remains attached to the correct document.
- Added 10 regression tests covering both editor adapters, failed text/image/SVG reads, navigation during saves, edits during reads, and a real filesystem save/undo/close round trip. All 179 tests, lint, typecheck, and the renderer build passed. The application was not launched and no release was published.

### [2026-09-06] Verified Editor, Git, Updater, and Download Regressions Fixed
- Editor read/save IPC now echoes request IDs on both success and failure. Read generations invalidate closed or superseded documents, including SVG's paired text/preview responses. Save acknowledgements compare the current buffer with the submitted snapshot and stay bound to the document's original project; subsequent edits remain dirty. Opening another file also respects the existing unsaved-change confirmation behavior.
- Atomic editor saves serialize by canonical target, preserve file permission bits, and replace the resolved target without replacing its symlink. Temporary files use exclusive random names in the target directory. Broken links, changed targets, and outside-project targets fail without replacing the link; failed writes clean their own temporary files.
- Conflict modals retain their originating project and invalidate asynchronous work on project changes or close. The backend checks that the file is still unmerged before writing/staging a resolution. Diff and conflict-content reads use the existing raw Git buffer helper so EOF whitespace, tabs, CRLF, and missing final newlines survive hunk staging and conflict resolution.
- Update checks defer while downloading, downloaded, or installing. Main/renderer event guards preserve readiness, and stale state-query responses cannot undo newer renderer state. A retry refreshes the authoritative state, including an already downloaded update.
- Corrected the August review's mapped-IPv6 conclusion: URL normalization turns `::ffff:127.0.0.1` into `::ffff:7f00:1`, which bypassed the old string-based filter. IPv6 normalization and embedded-IPv4 classification now reject loopback/private mapped addresses for both initial downloads and redirects. The regression test exercises the production redirect loop with a Node HTTP adapter and verifies zero requests reach its isolated localhost server; no Chromium end-to-end exploit or remote code execution is claimed.
- Added 29 regression tests; all 169 unit tests, lint, typecheck, and the renderer build passed. Tests use isolated DOM/IPC/platform adapters and real temporary files/Git repositories. The application was not launched; GUI smoke/scroll checks and release publication were not performed. Intentional terminal execution and plaintext history behavior were left unchanged.

### [2026-09-05] Terminal Scroll Races Reproduced in Electron
- Prepared patch release `1.3.13`; verified 24 real Electron scroll checks, 140 unit tests, lint, typecheck, renderer build and isolated app smoke test before packaging. Release publication uses the existing version-tag workflow.
- Revisited the August 29 scroll fix with an isolated real Electron/Chromium harness. The blanket claim that every DOM remount resets the viewport to zero did not reproduce in the installed xterm/Electron versions. A concrete jump to zero did reproduce: mount captured viewportY=0, the user returned to the bottom, then the delayed 50 ms callback restored the obsolete zero. The inverse race forced a user reading history back to the bottom.
- Removed delayed scroll restoration and versioned mount callbacks so superseded mounts cannot fit or focus a later mount. Retained the grid DOM reuse optimization, kept all grid classes on metadata updates, and removed redundant delayed fits on those updates.
- Removed the pre-write bottom snapshot: xterm already follows output until the user scrolls away. The old asynchronous callback overrode user scrolling, including a deliberate one-line movement and return from the alternate screen. Resize now uses exact bottom detection and a temporary public xterm marker to preserve visible history through height changes, wrapping and buffer trimming.
- Added `npm run test:scroll`, an isolated Chromium regression suite using production terminal/grid render paths, without PTYs or access to user sessions. The installed application is not replaced by a renderer build; these changes must be launched from this checkout or packaged to reach the installed app.

### [2026-08-29] Terminal Kept Jumping to the Top of Scrollback (Root Cause Found)
- Symptom: the terminal view constantly ended up at the top of the scrollback and the user had to click the scroll-to-bottom button.
- Root cause: reattaching an already-opened xterm element to the DOM resets `.xterm-viewport` scrollTop to 0; xterm's `_handleScroll` then interprets that as a real scroll and moves the buffer to the top (its `offsetParent` guard only helps while detached). Remounts happened constantly because `TerminalGrid.render()` rebuilt the whole grid (`innerHTML = ''` + `mountTerminal` for every pane) on *every* state change — and state changes arrive on every AI-tool detection tick, rename, renumber, active switch, etc.
- Fix, two layers: (1) `mountTerminal` now captures at-bottom/viewportY *before* detaching and restores it after the post-mount fit (`scrollToBottom` or `scrollToLine`); (2) `TerminalGrid.render()` memoizes on `layout|terminalIds` and, when unchanged, only refreshes header names and active styling in place — no DOM teardown, no remount. The skip check requires an actual `.grid-cell` in the container so tab↔grid view switches still rebuild. Side benefit: user-resized grid tracks now survive state updates.

### [2026-08-07] Deep System Review and Verified Fixes
- Shipped as `1.3.12`. Security release: it carries a fix for a git flag-injection hole that was reproduced end to end (one click on Pull could run an attacker's script), so users should be moved onto it rather than left on 1.3.11.
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
- **Second pass — the remaining findings were verified individually, and four more were fixed.**
  - *Prompt history was the worst of them, and it was live.* The append-only log had reached 79MB / 568,439 lines, and `getHistory` read it whole into main memory, over IPC, into a panel that builds three DOM nodes per line — roughly 1.7M nodes on open. Now a 1MB / 5000-line tail with the partial first line dropped (which also discards a split UTF-8 sequence at the read boundary). Verified against the real file: 1ms, 4,442 lines. The log is untouched on disk; `Open History File` remains the way to see all of it.
  - The file-tree watcher ignored the filename `fs.watch` hands it, so every write under `node_modules`/`.git` rebuilt and re-sent a tree that cannot contain them. Filtered at the source. Worth recording: the synchronous scan the earlier review flagged as a main-thread hazard measured **1.2ms** on this repo, so it was left alone — the cost was the needless renderer DOM rebuild, not the scan. The tree also lost `scrollTop` on every rebuild; now carried across.
  - `loadWorkspace` now normalizes its structure. `addProject`/`removeProject` index into `workspaces[activeWorkspace].projects` from plain `ipcMain.on` handlers, so a structurally-off but valid-JSON file threw an uncaught TypeError into Electron's crash dialog.
  - *Checked and deliberately left alone.* The SSRF guard is stronger than the review implied: decimal/hex/short IP obfuscations (`2130706433`, `0x7f000001`, `127.1`) all resolve through `dns.lookup` and are caught by the existing private-address check, and the directly tested dotted IPv4-mapped IPv6 strings were blocked. **Correction (2026-09-06):** this did not cover full URLs, whose normalized hexadecimal mapped addresses bypassed the guard; that path is now fixed and regression-tested. The residual DNS-rebinding TOCTOU cannot be closed cleanly because Electron's `net` exposes no TLS servername, so connecting by validated IP would break HTTPS. OSC 8 links opening without a confirmation is a deliberate decision from the 2026-07-14 session, not a regression — left as the project chose. No single-instance lock was added: macOS LaunchServices already prevents double-launching the bundle, and `VIBE_USER_DATA_DIR` already covers the dev-instance case.
- **Third pass — path containment closed via `src/main/projectAccess.js`.** The validators in `shared/pathValidation` were correct; they were being asked the wrong question. Handlers called `isPathWithinProjectContent(filePath, projectPath)` with both arguments from the same renderer message, so the caller supplied its own base and `{projectPath: '/', filePath: '~/.ssh/id_rsa'}` passed. `LOAD_FILE_TREE`/`START_FILE_TREE_WATCH` had no check at all.
  - Rather than reshaping dozens of handlers to take a project id, `projectAccess` holds the set of roots main itself produced and re-exports the two validators with that check applied first. Call sites are untouched — only their import line changes — which is what kept this to one new module plus four import swaps.
  - Roots are learned in exactly two authoritative places, both in main: the folder picker / new-project dialog (the `onProjectSelected` seam already existed but `index.js` passed `() => {}`), and the workspace file for anything opened previously. **The ordering is the load-bearing detail:** the renderer sends `LOAD_FILE_TREE` *before* `ADD_PROJECT_TO_WORKSPACE`, so a naive "must already be in the workspace" gate would have rejected the first load of every newly picked project. Registering at dialog time avoids that entirely.
  - Second trap found while wiring it: `loadWorkspace` cached its empty fallback when `workspacePath` was still null, which would have pinned "no projects" for the process lifetime and made every real project fail the new gate — silently, and only in a startup race. It now returns the fallback without caching.
  - Verified against the real workspace on this machine: all 7 projects accepted and operable, attacker-chosen bases refused. Tests had to register their temp repos the same way the app does, which is itself a check that the gate is enforced — six git tests failed before that change.
  - Still unguarded by design: the git managers `cwd` into `projectPath` without a containment call (`loadBranches`, `loadChanges`, …). That reads a repo rather than arbitrary files, and the renderer already holds `TERMINAL_INPUT_ID`, so it was left rather than expanded into.

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
