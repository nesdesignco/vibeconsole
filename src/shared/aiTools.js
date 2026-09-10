// Built-in CLI integrations. Commands run in the user's project shell;
// installation and authentication remain with each provider's CLI.
const AI_TOOLS = {
  claude: {
    id: 'claude', name: 'Claude Code', shortName: 'Claude', command: 'claude',
    description: 'Anthropic Claude Code CLI', menuLabel: 'Claude Commands',
    commands: { init: '/init', commit: '/commit', review: '/review-pr', help: '/help' },
    usageTracking: true,
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    installNote: 'macOS / Linux / WSL',
    docsUrl: 'https://code.claude.com/docs/en/setup'
  },
  codex: {
    id: 'codex', name: 'Codex CLI', shortName: 'Codex', command: 'codex',
    description: 'OpenAI Codex CLI', menuLabel: 'Codex Commands',
    commands: { review: '/review', model: '/model', permissions: '/permissions', help: '/help' },
    usageTracking: true,
    installCommand: 'npm install -g @openai/codex',
    installNote: 'Requires Node.js and npm',
    docsUrl: 'https://developers.openai.com/codex/cli'
  },
  grok: {
    id: 'grok', name: 'Grok Build', shortName: 'Grok', command: 'grok',
    description: 'xAI Grok Build CLI', menuLabel: 'Grok Commands',
    commands: { model: '/model', help: '/help' },
    installCommand: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    installNote: 'macOS / Linux',
    docsUrl: 'https://docs.x.ai/build/overview'
  },
  gemini: {
    id: 'gemini', name: 'Gemini CLI', shortName: 'Gemini', command: 'gemini',
    description: 'Google Gemini CLI', menuLabel: 'Gemini Commands',
    commands: { model: '/model', help: '/help' },
    installCommand: 'npm install -g @google/gemini-cli',
    installNote: 'Requires Node.js 20+ and npm',
    docsUrl: 'https://geminicli.com/docs/get-started/installation/'
  },
  copilot: {
    id: 'copilot', name: 'GitHub Copilot CLI', shortName: 'Copilot', command: 'copilot',
    description: 'GitHub Copilot CLI', menuLabel: 'Copilot Commands',
    commands: { model: '/model', help: '/help' },
    installCommand: 'npm install -g @github/copilot',
    installNote: 'Requires Node.js 22+ and npm',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli'
  },
  cursor: {
    // Both Cursor and Grok install `agent`; use Cursor's unambiguous command.
    id: 'cursor', name: 'Cursor CLI', shortName: 'Cursor', command: 'cursor-agent',
    description: 'Cursor terminal agent', menuLabel: 'Cursor Commands',
    commands: { model: '/model', help: '/help' },
    installCommand: 'curl -fsSL https://cursor.com/install | bash',
    installNote: 'macOS / Linux / WSL',
    docsUrl: 'https://cursor.com/docs/cli/installation'
  },
  qwen: {
    id: 'qwen', name: 'Qwen Code', shortName: 'Qwen', command: 'qwen',
    description: 'Qwen Code CLI', menuLabel: 'Qwen Commands',
    commands: { model: '/model', help: '/help' },
    installCommand: 'npm install -g @qwen-code/qwen-code@latest',
    installNote: 'Requires Node.js 22+ and npm',
    docsUrl: 'https://github.com/QwenLM/qwen-code#installation'
  },
  kimi: {
    id: 'kimi', name: 'Kimi Code', shortName: 'Kimi', command: 'kimi',
    aliases: ['kimi-cli'],
    description: 'Moonshot AI Kimi Code CLI', menuLabel: 'Kimi Commands',
    commands: { model: '/model', help: '/help' },
    installCommand: 'npm install -g @moonshot-ai/kimi-code',
    installNote: 'Requires Node.js 22.19+ and npm',
    docsUrl: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started'
  }
};

module.exports = { AI_TOOLS };
