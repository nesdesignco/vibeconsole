# Contributing to VibeConsole

Thanks for your interest in contributing to VibeConsole! This guide will help you get started.

## Development Setup

### Prerequisites

- **Node.js** 18+
- **macOS** (Electron builds are currently macOS-only)
- **Git**

### Getting Started

```bash
git clone https://github.com/nesdesignco/vibeconsole.git
cd vibeconsole
npm install
npm run dev
```

`npm run dev` starts esbuild in watch mode and launches the Electron app.

### Useful Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Watch mode + launch app |
| `npm start` | Build renderer + launch app |
| `npm run build:renderer` | Bundle renderer with esbuild |
| `npm run lint` | Run ESLint |
| `npm test` | Run tests |

## Project Structure

```
src/
  main/           # Main process (Node.js)
  renderer/       # Renderer process (bundled by esbuild)
  shared/         # Shared constants (IPC channels)
vendor/           # Vendored assets (fonts)
dist/             # Build output (gitignored)
```

- **IPC channels** are defined in `src/shared/ipcChannels.js` — always add new channels there.
- **Renderer** is bundled by esbuild into `dist/renderer.js`.
- See `STRUCTURE.json` for a detailed module map.

## Making Changes

### Branch Naming

Use descriptive branch names:

- `feat/description` — new features
- `fix/description` — bug fixes
- `refactor/description` — code refactoring

### Code Style

- Run `npm run lint` before committing — the project uses ESLint.
- Follow existing patterns in the codebase.
- Keep changes focused — one feature or fix per PR.

### Commits

Write clear, concise commit messages that describe what changed and why.

## Pull Requests

1. Fork the repo and create your branch from `main`.
2. Make your changes and ensure `npm run lint` passes.
3. Test your changes by running the app with `npm run dev`.
4. Open a PR with a clear title and description of your changes.
5. Link any related issues.

## Reporting Bugs

Open an issue at [github.com/nesdesignco/vibeconsole/issues](https://github.com/nesdesignco/vibeconsole/issues) with:

- Steps to reproduce
- Expected vs actual behavior
- macOS version and app version
- Console output if relevant (View > Toggle Developer Tools)

## Feature Requests

Open an issue with the `enhancement` label describing:

- What you'd like to see
- Why it would be useful
- Any ideas on implementation (optional)

## Security

If you discover a security vulnerability, please follow the instructions in [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
