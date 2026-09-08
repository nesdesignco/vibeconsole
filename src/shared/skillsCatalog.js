/** Reviewed, opt-in tools. Installation never runs on app startup or update. */
/**
 * @typedef {Object} Skill
 * @property {string} id
 * @property {string} category
 * @property {string} name
 * @property {string} title
 * @property {string} repo
 * @property {string} description
 * @property {'cli'|'skill'|'repository'|'service'} kind
 * @property {string} [logo]
 * @property {boolean} [custom]
 * @property {boolean} [modes]
 * @property {string} [installation]
 * @property {string} [sourcePath] Canonical skill directory within the repository.
 * @property {string[]} [aliases]
 * @property {string[]} [installCommand]
 * @property {string} [setupUrl]
 * @property {string} [setupNote]
 */
/** @type {Skill[]} */
const SKILLS = [
  { id: 'rtk', category: 'token-saver', name: 'RTK', logo: 'rtk.png', title: 'Compress tool output', repo: 'rtk-ai/rtk',
    description: 'Trim noisy git, search, file listings and build logs before they reach the model.', kind: 'cli' },
  { id: 'headroom', category: 'token-saver', name: 'Headroom', logo: 'headroom.svg', title: 'Compress context', repo: 'headroomlabs-ai/headroom',
    description: 'Run your coding agent through a local context-compression proxy.', kind: 'cli' },
  { id: 'caveman', category: 'token-saver', modes: true, name: 'Caveman', logo: 'caveman.svg', title: 'Compress replies', repo: 'JuliusBrussee/caveman',
    description: 'Shorter replies while keeping code and commands intact.', kind: 'skill' },
  { id: 'ponytail', category: 'token-saver', modes: true, name: 'Ponytail', logo: 'ponytail.svg', title: 'Write less code', repo: 'DietrichGebert/ponytail',
    description: 'Reuse existing solutions and avoid over-engineering.', kind: 'skill' },
  { id: 'design-taste-frontend', category: 'ui', installation: 'skill', name: 'Taste Skill', logo: 'taste-skill.webp', title: 'Give your UI a clear direction', repo: 'Leonxlnx/taste-skill',
    description: 'Design distinctive landing pages and portfolios with intentional typography, layout, motion and visual style.', kind: 'skill' },
  { id: 'impeccable', category: 'ui', name: 'Impeccable', logo: 'impeccable.svg', title: 'Polish your interface', repo: 'pbakaus/impeccable',
    description: 'Shape, critique, audit and refine interfaces with typography, color, layout and accessibility guidance.', kind: 'skill' },
  { id: 'scroll-craft', aliases: ['scrollcraft'], category: 'ui', installation: 'skill', name: 'Scrollcraft', logo: 'scrollcraft.png', title: 'Build scroll-driven websites', repo: 'nateherkai/scroll-craft',
    description: 'Plan and build interactive landing pages with scroll-driven video, layered scenes and responsive motion.', kind: 'skill' },
  { id: 'design-dna', category: 'ui', installation: 'skill', name: 'Design DNA', logo: 'design-dna.jpg', title: 'Extract a design language', repo: 'zanwei/design-dna',
    description: 'Turn screenshots and reference sites into design tokens, style and visual effects, then build from that profile.', kind: 'skill' },
  { id: 'security-review', category: 'security', installation: 'skill', sourcePath: 'skills/security-review', name: 'ECC Security Review', logo: 'ecc-security-review.svg', title: 'Review application security', repo: 'affaan-m/ECC',
    description: 'Review authentication, API endpoints, input validation, secrets and sensitive data handling. Installs only the Security Review skill from ECC.', kind: 'skill' },
  { id: 'superpowers', category: 'development', name: 'Superpowers', logo: 'superpowers.png', title: 'Plan, test and review your work', repo: 'obra/superpowers', kind: 'repository',
    description: 'Choose skills for planning, test-driven development, systematic debugging and code review.',
    setupNote: 'Choose the skills you want to install. Start a new agent session and invoke using-superpowers to begin the workflow. This installs skill files; automatic session-start hooks are not included.' },
  { id: 'obsidian-skills', category: 'brain', name: 'Obsidian Skills', logo: 'obsidian-skills.png', title: 'Work with your Obsidian vault', repo: 'kepano/obsidian-skills', kind: 'repository',
    description: 'A complete skill pack for Obsidian Markdown, Bases, Canvas, the Obsidian CLI and clean web-page extraction.' },
  { id: 'qmd', category: 'brain', name: 'QMD', logo: 'qmd.png', title: 'Search your local knowledge', repo: 'tobi/qmd', kind: 'cli',
    description: 'Search notes and documents with keywords, semantic search and local model reranking.',
    installCommand: ['npm', 'install', '--global', '@tobilu/qmd'], setupUrl: 'https://github.com/tobi/qmd#quick-start',
    setupNote: 'Add your own document collections, then connect the MCP server or use the CLI from your agent.' },
  { id: 'basic-memory', category: 'brain', name: 'Basic Memory', logo: 'basic-memory.png', title: 'Keep memory across sessions', repo: 'basicmachines-co/basic-memory', kind: 'cli',
    description: 'Store reusable knowledge in local Markdown files that your agents and Obsidian can share.',
    installCommand: ['uv', 'tool', 'install', 'basic-memory'], setupUrl: 'https://github.com/basicmachines-co/basic-memory#connect-your-ai-client',
    setupNote: 'Connect Basic Memory to Claude or Codex through MCP and choose which note project to use.' },
  { id: 'obsidian-wiki', category: 'brain', name: 'Obsidian Wiki', logo: 'obsidian-wiki.png', title: 'Build a linked digital brain', repo: 'Ar9av/obsidian-wiki', kind: 'cli',
    description: 'Turn documents, research and agent conversations into a maintained, cross-linked Obsidian wiki.',
    installCommand: ['uv', 'tool', 'install', 'obsidian-wiki'], setupUrl: 'https://github.com/Ar9av/obsidian-wiki/blob/main/SETUP.md',
    setupNote: 'Choose a vault and agent targets in the setup guide. Installing the CLI does not import conversations or change agent configuration.' },
  { id: 'graphiti', category: 'brain', name: 'Graphiti', logo: 'graphiti.png', title: 'Connect facts over time', repo: 'getzep/graphiti', kind: 'service',
    description: 'Build a searchable knowledge graph of facts, relationships and how they change over time.',
    setupUrl: 'https://github.com/getzep/graphiti/tree/main/mcp_server',
    setupNote: 'Requires a graph database, an LLM provider and MCP connection setup. Follow the project’s setup guide.' },
  { id: 'cognee', category: 'brain', name: 'Cognee', logo: 'cognee.png', title: 'Give agents long-term memory', repo: 'topoteretes/cognee', kind: 'service',
    description: 'Extract connected knowledge from your data and recall it across coding-agent sessions.',
    setupUrl: 'https://github.com/topoteretes/cognee-integrations',
    setupNote: 'Set up the memory service and its Claude or Codex integration. The project’s guide covers local and hosted configurations.' }
];

function getSkill(id) { return SKILLS.find(skill => skill.id === id); }
module.exports = { SKILLS, getSkill };
