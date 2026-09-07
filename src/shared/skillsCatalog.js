/** Reviewed, opt-in tools. Installation never runs on app startup or update. */
const SKILLS = [
  { id: 'rtk', category: 'token-saver', name: 'RTK', logo: 'rtk.png', title: 'Compress tool output', repo: 'rtk-ai/rtk',
    description: 'Trim noisy git, search, file listings and build logs before they reach the model.', kind: 'cli' },
  { id: 'headroom', category: 'token-saver', name: 'Headroom', logo: 'headroom.svg', title: 'Compress context', repo: 'headroomlabs-ai/headroom',
    description: 'Run your coding agent through a local context-compression proxy.', kind: 'cli' },
  { id: 'caveman', category: 'token-saver', modes: true, name: 'Caveman', logo: 'caveman.svg', title: 'Compress replies', repo: 'JuliusBrussee/caveman',
    description: 'Shorter replies while keeping code and commands intact.', kind: 'skill' },
  { id: 'ponytail', category: 'token-saver', modes: true, name: 'Ponytail', logo: 'ponytail.svg', title: 'Write less code', repo: 'DietrichGebert/ponytail',
    description: 'Reuse existing solutions and avoid over-engineering.', kind: 'skill' },
  { id: 'impeccable', category: 'ui', name: 'Impeccable', logo: 'impeccable.svg', title: 'Polish your interface', repo: 'pbakaus/impeccable',
    description: 'Shape, critique, audit and refine interfaces with typography, color, layout and accessibility guidance.', kind: 'skill' },
  { id: 'design-dna', category: 'ui', installation: 'skill', name: 'Design DNA', logo: 'dna.svg', title: 'Extract a design language', repo: 'zanwei/design-dna',
    description: 'Turn screenshots and reference sites into design tokens, style and visual effects, then build from that profile.', kind: 'skill' },
  { id: 'frontend-design', category: 'ui', installation: 'skill', name: 'Frontend Design', logo: 'palette.svg', title: 'Create distinctive UI', repo: 'anthropics/skills',
    description: 'Anthropic’s guidance for intentional visual direction, typography and polished frontend implementation.', kind: 'skill' },
  { id: 'web-design-guidelines', category: 'ui', installation: 'skill', name: 'Web Design Guidelines', logo: 'scan-eye.svg', title: 'Review interface quality', repo: 'vercel-labs/agent-skills',
    description: 'Check UI code against Vercel’s guidelines for accessibility, focus, forms, motion and responsive behavior.', kind: 'skill' }
];

function getSkill(id) { return SKILLS.find(skill => skill.id === id); }
module.exports = { SKILLS, getSkill };
