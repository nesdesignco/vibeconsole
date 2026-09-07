// Saved palettes contain their values so app updates cannot replace a user's colors.
const dark = {
  'bg-deep': '#0a0a0f', 'bg-primary': '#101018', 'bg-secondary': '#16161e',
  'bg-tertiary': '#1e1e28', 'bg-elevated': '#242430', 'bg-hover': '#2a2a38',
  'text-primary': '#e4e4ed', 'text-secondary': '#c0bccb', 'text-tertiary': '#b1aebe', 'text-muted': '#aba7ba',
  'accent-primary': '#a78bfa', 'folder-icon': '#a78bfa',
  success: '#5bb8a9', warning: '#e0a458', error: '#e18c8c', info: '#78a5d4',
  'git-green': '#7cb382', 'diff-add': '#98c379', 'diff-remove': '#e06c75',
  'icon-js': '#f0db4f', 'icon-json': '#8bc34a', 'icon-md': '#42a5f5',
  'terminal-bg': '#12121a', 'terminal-fg': '#d4d4e4',
  'ansi-black': '#16161e', 'ansi-red': '#f47067', 'ansi-green': '#57cc99', 'ansi-yellow': '#e0a458',
  'ansi-blue': '#78a5d4', 'ansi-magenta': '#c4b5fd', 'ansi-cyan': '#56d4dd', 'ansi-white': '#e4e4ed',
  'ansi-brightBlack': '#9b97ad', 'ansi-brightRed': '#ff8080', 'ansi-brightGreen': '#7ee8b0',
  'ansi-brightYellow': '#ffd580', 'ansi-brightBlue': '#a0c4f0', 'ansi-brightMagenta': '#ddd6fe',
  'ansi-brightCyan': '#80e8f0', 'ansi-brightWhite': '#f0f0f8'
};
const light = {
  ...dark, 'bg-deep': '#eef0f4', 'bg-primary': '#ffffff', 'bg-secondary': '#f5f6f9',
  'bg-tertiary': '#eceef3', 'bg-elevated': '#ffffff', 'bg-hover': '#e2e5ed',
  'text-primary': '#202431', 'text-secondary': '#485064', 'text-tertiary': '#535b6f', 'text-muted': '#555d6f',
  'accent-primary': '#6240bd', 'folder-icon': '#6240bd',
  success: '#1b7060', warning: '#8a570b', error: '#b2313f', info: '#285ca2',
  'git-green': '#28713c', 'diff-add': '#28713c', 'diff-remove': '#b2313f',
  'icon-js': '#806400', 'icon-json': '#407123', 'icon-md': '#285ca2',
  'terminal-bg': '#ffffff', 'terminal-fg': '#202431',
  'ansi-black': '#202431', 'ansi-red': '#b2313f', 'ansi-green': '#28713c', 'ansi-yellow': '#8a570b',
  'ansi-blue': '#285ca2', 'ansi-magenta': '#7840a0', 'ansi-cyan': '#006c78', 'ansi-white': '#535b6f',
  'ansi-brightBlack': '#5b6375', 'ansi-brightRed': '#a82030', 'ansi-brightGreen': '#17632c',
  'ansi-brightYellow': '#785000', 'ansi-brightBlue': '#174ca0', 'ansi-brightMagenta': '#663090',
  'ansi-brightCyan': '#005c68', 'ansi-brightWhite': '#202431'
};

const THEMES = [
  { id: 'violet', name: 'Violet', mode: 'dark', colors: dark },
  { id: 'charcoal', name: 'Charcoal', mode: 'dark', colors: { ...dark,
    'bg-deep': '#0e1012', 'bg-primary': '#151719', 'bg-secondary': '#1b1e21', 'bg-tertiary': '#23272b',
    'bg-elevated': '#292e33', 'bg-hover': '#32383e', 'accent-primary': '#79b8d9', 'folder-icon': '#79b8d9', 'terminal-bg': '#151719' } },
  { id: 'midnight', name: 'Midnight', mode: 'dark', colors: { ...dark,
    'bg-deep': '#090f1b', 'bg-primary': '#101a2c', 'bg-secondary': '#15223a', 'bg-tertiary': '#1c2b45',
    'bg-elevated': '#223350', 'bg-hover': '#293d5c', 'accent-primary': '#80c4dc', 'folder-icon': '#80c4dc', 'terminal-bg': '#101a2c' } },
  { id: 'black', name: 'Black', mode: 'dark', colors: { ...dark,
    'bg-deep': '#000000', 'bg-primary': '#000000', 'bg-secondary': '#000000', 'bg-tertiary': '#0a0a0a',
    'bg-elevated': '#111111', 'bg-hover': '#181818', 'terminal-bg': '#000000', 'terminal-fg': '#dcdcdc',
    'text-primary': '#eeeeee', 'text-secondary': '#cccccc', 'text-tertiary': '#bbbbbb', 'text-muted': '#aaaaaa',
    'accent-primary': '#b6b6b6', 'folder-icon': '#b6b6b6' } },
  { id: 'paper', name: 'Paper', mode: 'light', colors: light },
  { id: 'ivory', name: 'Ivory', mode: 'light', colors: { ...light,
    'bg-deep': '#eee9de', 'bg-primary': '#fffdf7', 'bg-secondary': '#f6f2e8', 'bg-tertiary': '#eee8dc',
    'bg-elevated': '#fffdf7', 'bg-hover': '#e6decf', 'accent-primary': '#805321', 'folder-icon': '#805321', 'terminal-bg': '#fffdf7' } },
  { id: 'mist', name: 'Mist', mode: 'light', colors: { ...light,
    'bg-deep': '#e3e8eb', 'bg-primary': '#f4f7f8', 'bg-secondary': '#eaf0f2', 'bg-tertiary': '#e1e9ed',
    'bg-elevated': '#ffffff', 'bg-hover': '#d5e0e5', 'accent-primary': '#256779', 'folder-icon': '#256779', 'terminal-bg': '#f4f7f8' } },
  { id: 'linen', name: 'Linen', mode: 'light', colors: { ...light,
    'bg-deep': '#eae3df', 'bg-primary': '#faf6f4', 'bg-secondary': '#f2ede9', 'bg-tertiary': '#eae3df',
    'bg-elevated': '#fffaf7', 'bg-hover': '#e1d7d1', 'accent-primary': '#92514e', 'folder-icon': '#92514e', 'terminal-bg': '#faf6f4' } }
];
const STYLES = [
  { id: 'classic', name: 'Classic', description: 'Familiar spacing and subtle depth.', radius: 6, spacing: 8, shadow: 0.3 },
  { id: 'flat', name: 'Flat', description: 'Square corners, compact controls, no shadows.', radius: 0, spacing: 6, shadow: 0 },
  { id: 'soft', name: 'Soft', description: 'Rounder corners and relaxed controls.', radius: 10, spacing: 10, shadow: 0.18 }
];
const COLOR_LABELS = {
  'accent-primary': 'Accent', 'folder-icon': 'Folders', 'bg-primary': 'Background', 'bg-secondary': 'Panels',
  'bg-deep': 'Deep background', 'bg-tertiary': 'Cards', 'bg-elevated': 'Menus', 'bg-hover': 'Hover',
  'text-primary': 'Text', 'text-secondary': 'Secondary text', 'text-tertiary': 'Labels', 'text-muted': 'Muted text',
  'terminal-bg': 'Terminal background', 'terminal-fg': 'Terminal text',
  success: 'Success', warning: 'Warning', error: 'Error', info: 'Information',
  'git-green': 'Git branches', 'diff-add': 'Added lines', 'diff-remove': 'Removed lines',
  'icon-js': 'JavaScript files', 'icon-json': 'JSON files', 'icon-md': 'Markdown files'
};
const HEX = /^#[\da-f]{6}$/i;
const clone = value => JSON.parse(JSON.stringify(value));
function defaults() {
  return { version: 1, mode: /** @type {'dark'|'light'|'system'} */ ('dark'), dark: clone(THEMES.find(theme => theme.id === 'violet')), light: clone(THEMES.find(theme => theme.id === 'paper')), style: clone(STYLES[0]) };
}
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw new Error('Unsupported appearance settings. The saved file was preserved.');
  const result = defaults();
  if (!['dark', 'light', 'system'].includes(value.mode)) throw new Error('Invalid appearance mode.');
  result.mode = value.mode;
  for (const mode of ['dark', 'light']) {
    const saved = value[mode];
    if (!saved || !saved.colors || typeof saved.colors !== 'object' || Array.isArray(saved.colors)) throw new Error('Invalid saved palette.');
    result[mode].id = typeof saved.id === 'string' ? saved.id.slice(0, 80) : 'custom';
    result[mode].name = THEMES.find(theme => theme.id === result[mode].id)?.name || 'Custom';
    for (const key of Object.keys(result[mode].colors)) {
      if (saved.colors[key] === undefined) continue;
      if (typeof saved.colors[key] !== 'string' || !HEX.test(saved.colors[key])) throw new Error('Use six-digit HEX colors.');
      result[mode].colors[key] = saved.colors[key].toLowerCase();
    }
  }
  if (!value.style || !STYLES.some(style => style.id === value.style.id)) throw new Error('Invalid theme style.');
  result.style = { ...STYLES.find(style => style.id === value.style.id) };
  for (const [key, max] of Object.entries({ radius: 16, spacing: 16, shadow: 0.5 })) {
    const number = value.style[key];
    if (number !== undefined) {
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > max) throw new Error('Invalid theme style value.');
      result.style[key] = number;
    }
  }
  return result;
}
const alpha = (hex, opacity) => hex + Math.round(opacity * 255).toString(16).padStart(2, '0');
function contrast(first, second) {
  const luminance = hex => hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function variables(settings, systemDark = true) {
  const mode = settings.mode === 'system' ? (systemDark ? 'dark' : 'light') : settings.mode;
  const c = settings[mode].colors;
  const result = { ...c };
  const accent = c['accent-primary'];
  Object.assign(result, { 'accent-light': accent, 'accent-secondary': accent,
    'accent-subtle': alpha(accent, 0.15), 'accent-glow': alpha(accent, 0.08), 'accent-bg': alpha(accent, 0.1),
    'accent-shadow': alpha(accent, 0.3), 'accent-shadow-hover': alpha(accent, 0.4),
    'success-hover': c.success, 'grid-gap-bg': c['bg-hover'], white: '#ffffff',
    'neutral-subtle': alpha(c['text-primary'], 0.12),
    'border-subtle': alpha(c['text-primary'], 0.12), 'border-default': alpha(c['text-primary'], 0.2), 'border-strong': alpha(c['text-primary'], 0.3)
  });
  for (const key of ['success', 'warning', 'error', 'info', 'git-green', 'diff-add', 'diff-remove']) {
    for (const [suffix, opacity] of [['subtle', 0.15], ['bg', 0.1], ['glow', 0.2], ['border', 0.5]]) result[`${key}-${suffix}`] = alpha(c[key], opacity);
  }
  for (const [suffix, opacity] of [['heavy', 0.8], ['medium', 0.6], ['light', 0.4], ['subtle', 0.3]]) result[`overlay-${suffix}`] = alpha('#000000', opacity);
  const style = settings.style;
  for (const [suffix, scale] of Object.entries({ xs: 0.5, sm: 1, md: 4 / 3, lg: 2, xl: 8 / 3 })) result[`radius-${suffix}`] = `${style.radius * scale}px`;
  result['radius-pill'] = style.radius === 0 ? '0px' : '999px';
  result['space-xs'] = `${style.spacing / 2}px`;
  result['space-sm'] = `${style.spacing}px`;
  result['btn-height-sm'] = `${16 + style.spacing}px`;
  result['btn-height-md'] = `${20 + style.spacing}px`;
  result['btn-height-lg'] = `${24 + style.spacing}px`;
  for (const [suffix, geometry] of [['sm', '0 1px 2px'], ['md', '0 4px 12px'], ['lg', '0 8px 32px']]) {
    result[`shadow-${suffix}`] = `${geometry} ${alpha('#000000', mode === 'light' ? style.shadow / 2 : style.shadow)}`;
  }
  result['shadow-glow'] = 'var(--shadow-md)';
  return { mode, values: result };
}
function terminalTheme(values) {
  const result = { background: values['terminal-bg'], foreground: values['terminal-fg'],
    cursor: values['accent-primary'], cursorAccent: values['terminal-bg'], selectionBackground: alpha(values['accent-primary'], 0.25) };
  for (const [key, value] of Object.entries(values)) if (key.startsWith('ansi-')) result[key.slice(5)] = value;
  return result;
}
module.exports = { THEMES, STYLES, COLOR_LABELS, HEX, defaults, normalize, variables, terminalTheme, alpha, contrast };
