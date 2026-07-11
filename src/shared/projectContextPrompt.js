/**
 * Provider-neutral prompt for initializing or auditing VibeConsole project context.
 * The workflow requires evidence, preview, and explicit approval before writes.
 */

const CORE_CONTEXT_FILES = ['STRUCTURE.json', 'PROJECT_NOTES.md', 'tasks.json'];

function formatFileStatus(status = {}) {
  const files = status.files || {};
  const rows = [
    ['STRUCTURE.json', files.structureJson],
    ['PROJECT_NOTES.md', files.projectNotesMd],
    ['tasks.json', files.tasksJson],
    ['AGENTS.md', files.agentsMd],
    ['CLAUDE.md', files.claudeMd]
  ];
  return rows.map(([name, exists]) => `- ${name}: ${exists === true ? 'present' : 'missing'}`).join('\n');
}

function buildProjectContextPrompt(status = {}) {
  const mode = status.mode === 'audit' ? 'Audit' : 'Initialize';
  const action = mode === 'Audit'
    ? 'audit and refresh the existing VibeConsole project context'
    : 'initialize the missing VibeConsole project context files';

  return `You are running the VibeConsole Project Context ${mode} workflow.

Your task is to ${action}. Work only inside the current project. All analysis, proposed documentation, questions, and status messages must be in English.

VibeConsole detected this root-file status:
${formatFileStatus(status)}

The canonical VibeConsole context package is:
- STRUCTURE.json: a factual, machine-readable map of the project architecture and important modules.
- PROJECT_NOTES.md: durable project knowledge, verified technical decisions, and chronological session notes.
- tasks.json: the agreed project-task tracker.

Safety and evidence rules:
1. Begin with read-only inspection. Do not create, edit, rename, move, or delete any file during the analysis phase.
2. Inspect relevant root documentation, AGENTS.md or CLAUDE.md when present, README files, manifests, lockfiles, CI and test configuration, source layout, entry points, and architecture-defining files. Do not follow symlinks that resolve outside the project.
3. Exclude dependency directories, vendor code, generated/build output, binaries, caches, coverage output, VCS internals, and secret-bearing files. Never print or copy secret values, credentials, private keys, tokens, or .env contents.
4. Include commands, architecture claims, conventions, decisions, and warnings only when supported by repository evidence. Clearly label unresolved facts instead of guessing.
5. Preserve existing human-authored content and unrelated working-tree changes. Never replace an existing context or instruction file wholesale when a focused diff is sufficient.
6. If AGENTS.md or CLAUDE.md exists, treat it as human-owned input. Propose only the smallest integration diff needed to tell future agents to read the three canonical context files at session start and keep them current. If CLAUDE.md is a symlink to AGENTS.md, modify only the canonical target. If neither instruction file exists, report that fact but do not create one as part of this workflow.

File requirements:

STRUCTURE.json
- Produce valid JSON with a stable top-level shape containing version, description, lastUpdated, architecture, and modules.
- Describe verified project type, entry points, subsystem boundaries, important relative paths, responsibilities, and dependencies at a useful high level.
- Adapt module details to the project's language and architecture. Do not inventory dependencies, generated files, or every trivial source file.
- Preserve compatible existing fields and update only stale or missing facts.

PROJECT_NOTES.md
- Produce concise English Markdown for durable knowledge, not a transcript.
- Preserve existing notes and decisions.
- Add verified project overview or technical decisions only when evidence exists.
- Keep chronological session entries in the format: "### [YYYY-MM-DD] Title".
- For a new file, create a minimal baseline and an initialization entry; do not fabricate historical decisions.

tasks.json
- Produce a valid JSON array.
- Preserve every existing task, its identifier, status, timestamps, and user-authored context.
- Do not turn TODO comments, guesses, or possible improvements into agreed tasks.
- If no confirmed tasks exist and the file is missing, propose an empty array: [].

Required approval flow:
1. First provide an evidence summary listing important files inspected, detected project type, verified commands, architectural findings, existing context quality, conflicts, and unknowns.
2. Provide a file-by-file action plan for ${CORE_CONTEXT_FILES.join(', ')} and any existing AGENTS.md/CLAUDE.md integration diff.
3. For every missing file, show its complete proposed content. For every existing file that needs changes, show a focused unified diff. Explicitly say when a file needs no change.
4. End the preview with exactly: "No files have been changed. Approve this proposal?"
5. Stop and wait for an explicit affirmative response from the user.
6. Only after explicit approval, apply exactly the approved changes. Before writing, re-check that every target is unchanged since the preview; if any target changed, stop and show refreshed diffs.
7. After writing, validate JSON files, report every changed file, and summarize the result. If no change is required, report that the project context is current and do not write anything.

Start with the read-only evidence inspection now.`;
}

module.exports = {
  CORE_CONTEXT_FILES,
  formatFileStatus,
  buildProjectContextPrompt
};
