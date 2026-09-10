<p align="center">
  <img src="build/icon.svg" width="140" height="140" alt="VibeConsole">
</p>

<h1 align="center">VibeConsole</h1>

<p align="center">
  <strong>The terminal IDE built for AI coding workflows.</strong><br>
  Not a code editor — a <em>project management framework</em> for developers who ship with AI.
</p>

<!-- Badges -->
<p align="center">
  <a href="https://github.com/nesdesignco/vibeconsole/releases"><img src="https://img.shields.io/github/v/release/nesdesignco/vibeconsole?style=flat-square&color=8b5cf6&label=release" alt="Release"></a>
  <a href="https://github.com/nesdesignco/vibeconsole/blob/main/LICENSE"><img src="https://img.shields.io/github/license/nesdesignco/vibeconsole?style=flat-square&color=8b5cf6" alt="License"></a>
  <a href="https://github.com/nesdesignco/vibeconsole/stargazers"><img src="https://img.shields.io/github/stars/nesdesignco/vibeconsole?style=flat-square&color=8b5cf6" alt="Stars"></a>
  <a href="https://github.com/nesdesignco/vibeconsole/issues"><img src="https://img.shields.io/github/issues/nesdesignco/vibeconsole?style=flat-square&color=8b5cf6" alt="Issues"></a>
  <a href="https://github.com/nesdesignco/vibeconsole/pulls"><img src="https://img.shields.io/github/issues-pr/nesdesignco/vibeconsole?style=flat-square&color=8b5cf6" alt="PRs"></a>
  <img src="https://img.shields.io/github/last-commit/nesdesignco/vibeconsole?style=flat-square&color=8b5cf6" alt="Last Commit">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS-black?style=flat-square&logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/electron-42-47848f?style=flat-square&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome">
</p>

<!-- Navigation -->
<p align="center">
  <a href="#-why-vibeconsole">Why?</a> •
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#%EF%B8%8F-keyboard-shortcuts">Shortcuts</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-faq">FAQ</a> •
  <a href="#-contributing">Contributing</a>
</p>

<br>

<p align="center">
  <img src="docs/screenshots/vibe-console-source-control.png" width="900" alt="VibeConsole Source Control panel screenshot">
</p>

---

## 💡 Why VibeConsole?

When developing with AI coding assistants, you don't need a traditional IDE — you need a **terminal**. But staying terminal-only means:

- Projects get **disorganized**
- Context gets **lost between sessions**
- Decisions are **forgotten**

**VibeConsole** solves this by combining a multi-terminal workspace with project management tools that preserve context across sessions.

> Works with **Claude Code**, **Codex CLI**, **Gemini CLI**, and any terminal-based AI tool.
> Your AI writes the code. VibeConsole keeps you organized.

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🖥️ Multi-Terminal
Up to **9 independent terminals** with tabs or grid view.
Flexible layouts: `2×1` `2×2` `3×1` `3×2` `3×3`

### 📁 Project Explorer
File tree with **drag-drop** to terminal, context menu, rename, delete, and a quick **editor overlay** for fast edits.

### 🔀 Git Integration
Built-in panel for **staged/unstaged changes**, branches, worktrees, and full **inline diffs** with syntax highlighting.

### 💾 Saved Prompts
Save and reuse your most common prompts across sessions. One-click paste to terminal.

</td>
<td width="50%" valign="top">

### 🧠 Context Preservation
`AGENTS.md`, `STRUCTURE.json`, and `PROJECT_NOTES.md` keep your architectural decisions and project context alive across sessions.

### 📊 Usage Tracking
Real-time **Claude & Codex usage** monitoring. Session utilization, weekly limits, and reset timers.

### 🤖 AI Tool Selector
Switch between **Claude Code**, **Codex CLI**, **Grok Build**, **Gemini CLI**, **GitHub Copilot CLI**, **Cursor CLI**, **Qwen Code**, and **Kimi Code** from the toolbar. Each terminal can run a different tool.

Install and sign in to the CLI you want to use, then select it and click **Start**. The selected tool's application menu includes its setup guide. VibeConsole does not bundle these CLIs or their subscriptions.

When Bash, Zsh, sh or Fish reports a supported CLI command is missing, the terminal shows its install command, prerequisites, a copy button and the official setup guide. This also works for manually typed commands. If already installed, check its PATH; after installing, open a fresh terminal and start the tool again.

| CLI | Launch command | Setup |
| --- | --- | --- |
| Grok Build | `grok` | [Official guide](https://docs.x.ai/build/overview) |
| Gemini CLI | `gemini` | [Official guide](https://geminicli.com/docs/get-started/installation/) |
| GitHub Copilot CLI | `copilot` | [Official guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) |
| Cursor CLI | `cursor-agent` | [Official guide](https://cursor.com/docs/cli/installation) |
| Qwen Code | `qwen` | [Official guide](https://github.com/QwenLM/qwen-code#installation) |
| Kimi Code | `kimi` | [Official guide](https://moonshotai.github.io/kimi-code/en/guides/getting-started) |

The legacy `kimi-cli` command is also recognized. Cursor starts with `cursor-agent` because both Cursor and Grok install an `agent` alias. Usage bars and managed Skills installations currently support Claude Code and Codex; other agents show their tool name without quota bars.

### Computer Use

Open the monitor button in the toolbar, install [Peekaboo](https://github.com/openclaw/Peekaboo/blob/main/docs/install.md), grant macOS permissions and refresh. Enter a task and choose **Prepare in terminal**, then review and press Enter in your running AI agent. Requires macOS 15+ and an agent allowed to run local shell tools. The agent uses Peekaboo to inspect and operate Mac apps; no separate AI account is needed for this CLI workflow.

</td>
</tr>
</table>

**Also includes:** Prompt history with timestamps • Auto-updater • Keyboard-driven workflow • Drag file → terminal pastes quoted path • macOS native menus

### Appearance

Open **Settings** with the gear at the far right of the terminal toolbar. Choose a palette: Paper, Ivory, Mist, Linen (light); Violet, Charcoal, Midnight, or Black (dark) (true black backgrounds). Choosing a palette immediately activates its Light or Dark mode. Choose **System** to follow macOS using your saved light/dark palettes. **Classic**, **Flat**, and **Soft** adjust corners, control spacing, and shadows; Flat uses square corners.

Use **Personal colors** to change accent and folder colors with a color picker or six-digit HEX value. Expand **All interface colors** or **Terminal palette** for the remaining colors. Changes apply immediately to the interface, existing terminals, and code editor. **Reset appearance**, at the bottom of Settings, asks before restoring Dark / Violet / Classic and removing custom colors.

Preferences are saved in `appearance.json` under Electron's `userData` directory, outside the application bundle. Saved color and style values survive restarts and app updates; new settings receive defaults without replacing existing values. A damaged or unsupported preferences file is preserved and reported in Settings instead of being overwritten.

---

## 🚀 Quick Start

### Install & Run

```bash
git clone https://github.com/nesdesignco/vibeconsole.git
cd vibeconsole
npm install
npm start
```

### Development

```bash
npm run dev          # Watch mode + launch app
npm run build        # Bundle renderer + create macOS DMG
npm run lint         # Run ESLint
npm test             # Run tests
```

### Build for Distribution

```bash
npm run dist:mac     # Create macOS DMG
```

> **Requirements:** Node.js 22.12+ • macOS • Git

### Installing a Downloaded Release

Release builds are signed and notarized for macOS Gatekeeper. If macOS reports that the app is damaged, download the latest release again from the official GitHub Releases page.

Unsigned local builds are available for development with `npm run dist:mac:unsigned`.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Start the selected AI tool in active terminal |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> | New terminal |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> | Close terminal |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> | Next / Previous terminal |
| <kbd>Ctrl</kbd>+<kbd>1</kbd> – <kbd>9</kbd> | Jump to terminal N |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Toggle grid view |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Toggle sidebar |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> | Toggle history panel |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Toggle saved prompts |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> | Toggle git branches |

---

## 🏗️ Architecture

```
src/
├── main/           # Main process — PTY, file tree, git
├── renderer/       # Renderer process — terminal UI, panels, styles
└── shared/         # IPC channel constants, path validation
```

> See [`STRUCTURE.json`](STRUCTURE.json) for the full module map.

---

## 🛠️ Tech Stack

<table>
<tr>
<td align="center" width="150">
  <img src="https://cdn.simpleicons.org/electron/47848F" width="36" height="36" alt="Electron"><br>
  <sub><b>Electron 42</b></sub><br>
  <sub>Desktop framework</sub>
</td>
<td align="center" width="150">
  <img src="https://cdn.simpleicons.org/javascript/F7DF1E" width="36" height="36" alt="JavaScript"><br>
  <sub><b>JavaScript</b></sub><br>
  <sub>Language</sub>
</td>
<td align="center" width="150">
  <img src="https://cdn.simpleicons.org/nodedotjs/339933" width="36" height="36" alt="Node.js"><br>
  <sub><b>Node.js 22.12+</b></sub><br>
  <sub>Runtime</sub>
</td>
<td align="center" width="150">
  <img src="https://cdn.simpleicons.org/esbuild/FFCF00" width="36" height="36" alt="esbuild"><br>
  <sub><b>esbuild</b></sub><br>
  <sub>Bundler</sub>
</td>
</tr>
<tr>
<td align="center" width="150">
  <br>
  <sub><b>xterm.js 5.5</b></sub><br>
  <sub>Terminal emulator</sub>
</td>
<td align="center" width="150">
  <br>
  <sub><b>node-pty 1.1</b></sub><br>
  <sub>PTY management</sub>
</td>
<td align="center" width="150">
  <img src="https://cdn.simpleicons.org/git/F05032" width="36" height="36" alt="Git"><br>
  <sub><b>Git</b></sub><br>
  <sub>Version control</sub>
</td>
<td align="center" width="150">
  <img src="https://cdn.simpleicons.org/eslint/4B32C3" width="36" height="36" alt="ESLint"><br>
  <sub><b>ESLint</b></sub><br>
  <sub>Code quality</sub>
</td>
</tr>
</table>

---

## ❓ FAQ

<details>
<summary><strong>Why not just use VS Code with a terminal?</strong></summary>
<br>
VS Code is a code editor that happens to have a terminal. VibeConsole is a terminal that happens to have project management tools. When you're using AI to write code, you spend 90% of your time in the terminal — VibeConsole is designed for that workflow.
</details>

<details>
<summary><strong>Does it work on Windows/Linux?</strong></summary>
<br>
Currently macOS only. Windows and Linux support is on the roadmap. The codebase is cross-platform ready (node-pty and xterm.js support all platforms), but we haven't tested and polished the experience yet.
</details>

<details>
<summary><strong>What shells are supported?</strong></summary>
<br>
Any shell on your system — zsh, bash, fish, etc. VibeConsole uses your default <code>$SHELL</code>.
</details>

---

## 🤝 Contributing

We love contributions! Whether it's a bug fix, new feature, or documentation improvement.

1. Fork the repository
2. Create your branch (`git checkout -b feat/amazing-feature`)
3. Make your changes and run `npm run lint`
4. Commit (`git commit -m 'Add amazing feature'`)
5. Push (`git push origin feat/amazing-feature`)
6. Open a Pull Request

See [**CONTRIBUTING.md**](CONTRIBUTING.md) for detailed guidelines.

| Type | Link |
|------|------|
| 🐛 Bug Report | [Open an issue](https://github.com/nesdesignco/vibeconsole/issues/new?template=bug_report.md) |
| 💡 Feature Request | [Open an issue](https://github.com/nesdesignco/vibeconsole/issues/new?template=feature_request.md) |
| 📖 Docs | [CONTRIBUTING.md](CONTRIBUTING.md) |

---

## Contributors

Thanks to everyone who has contributed to VibeConsole.

<p>
  <a href="https://github.com/nesdesignco/vibeconsole/graphs/contributors">
    <img src="docs/assets/github-mark.svg" alt="GitHub" style="width: 16px; height: 16px; vertical-align: -2px;" />
    <strong>View contributors on GitHub</strong>
  </a>
</p>

## 📄 License

[MIT](LICENSE) © 2026 [nesdesignco](https://github.com/nesdesignco)
