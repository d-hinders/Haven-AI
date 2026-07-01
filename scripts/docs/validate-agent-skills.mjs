#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_SKILLS = [
  "new-task",
  "ship-next",
  "haven-reset",
  "haven-agent-workflow",
];

export const REQUIRED_ROLES = [
  "haven-workflow-coordinator",
  "haven-explorer",
  "haven-ui-worker",
  "haven-backend-worker",
  "haven-reviewer",
  "haven-doc-reviewer",
];

export const ROLE_REFERENCES = {
  "haven-workflow-coordinator": "workflow-coordinator",
  "haven-explorer": "explorer",
  "haven-ui-worker": "ui-worker",
  "haven-backend-worker": "backend-worker",
  "haven-reviewer": "reviewer",
  "haven-doc-reviewer": "doc-reviewer",
};

export const RESET_CLIENTS = ["claude-code", "codex"];

const COMMAND_TARGETS = Object.fromEntries(
  ["new-task", "ship-next", "haven-reset"].map((name) => [
    `.claude/commands/${name}.md`,
    `.agents/skills/${name}/SKILL.md`,
  ]),
);

const AGENT_TARGETS = Object.fromEntries(
  REQUIRED_ROLES.map((name) => [
    `.claude/agents/${name}.md`,
    `.agents/skills/haven-agent-workflow/references/${ROLE_REFERENCES[name]}.md`,
  ]),
);

const FORBIDDEN_PORTABLE_PATTERNS = [
  ["AskUserQuestion", /\bAskUserQuestion\b/],
  ["mcp__github__", /\bmcp__github__/],
  ["Grep", /\bGrep\b/],
  ["Glob", /\bGlob\b/],
  [
    "Read",
    /(?:`Read`|\btools\s*:[^\n]*\bRead\b|\b(?:use|call|invoke)\s+(?:the\s+)?Read\b|\b(?:Grep|Glob)\s*[/,]\s*Read\b)/i,
  ],
  ["claude/issue-", /\bclaude\/issue-/i],
  ["Claude-Session", /\bClaude-Session\b/i],
];

function displayPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isFile(filePath) {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function parseFrontmatter(source, relativePath) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    return { errors: [`${relativePath}: missing opening frontmatter delimiter`], data: {} };
  }

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    return { errors: [`${relativePath}: missing closing frontmatter delimiter`], data: {} };
  }

  const data = {};
  const errors = [];
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) {
      errors.push(`${relativePath}:${index + 1}: unsupported frontmatter syntax`);
      continue;
    }

    const [, key, rawValue] = match;
    if (Object.hasOwn(data, key)) {
      errors.push(`${relativePath}:${index + 1}: duplicate frontmatter key "${key}"`);
      continue;
    }

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return { data, errors };
}

function validateSkillFrontmatter(repoRoot, skillName) {
  const relativePath = `.agents/skills/${skillName}/SKILL.md`;
  const filePath = path.join(repoRoot, relativePath);
  if (!isFile(filePath)) return [`${relativePath}: required skill file is missing`];

  const { data, errors } = parseFrontmatter(readFileSync(filePath, "utf8"), relativePath);
  const allowedKeys = new Set(["name", "description"]);
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${relativePath}: unsupported frontmatter key "${key}"`);
    }
  }

  if (!data.name) {
    errors.push(`${relativePath}: frontmatter "name" is required`);
  } else {
    if (data.name.length > 64) {
      errors.push(`${relativePath}: frontmatter "name" must be at most 64 characters`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)) {
      errors.push(`${relativePath}: frontmatter "name" must use lowercase kebab-case`);
    }
    if (data.name !== skillName) {
      errors.push(
        `${relativePath}: frontmatter name "${data.name}" must match folder "${skillName}"`,
      );
    }
  }

  const description = data.description ?? "";
  if (!description) {
    errors.push(`${relativePath}: frontmatter "description" is required`);
  } else {
    if (description.length < 24) {
      errors.push(`${relativePath}: description is too short to explain when the skill applies`);
    }
    if (description.length > 1024) {
      errors.push(`${relativePath}: description must be at most 1024 characters`);
    }
    if (/\b(?:todo|tbd|placeholder|complete and informative)\b/i.test(description)) {
      errors.push(`${relativePath}: description still contains placeholder text`);
    }
    if (!/\b(?:use|when|trigger|request|ask|task|workflow|ship|capture|reset)\w*\b/i.test(description)) {
      errors.push(`${relativePath}: description must explain when or why the skill is triggered`);
    }
  }

  return errors;
}

function markdownLinkTargets(source) {
  const targets = [];
  const linkPattern = /!?\[[^\]]*]\(([^)\n]+)\)/g;
  for (const match of source.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.includes(">")) {
      target = target.slice(1, target.indexOf(">"));
    } else {
      target = target.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, "");
    }
    targets.push(target);
  }
  return targets;
}

function localLinkPath(sourceFile, target) {
  if (
    !target ||
    target.startsWith("#") ||
    target.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    return null;
  }

  const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
  if (!withoutFragment) return null;
  try {
    return path.resolve(path.dirname(sourceFile), decodeURIComponent(withoutFragment));
  } catch {
    return path.resolve(path.dirname(sourceFile), withoutFragment);
  }
}

function validateRelativeLinks(repoRoot, filePath) {
  const relativePath = displayPath(repoRoot, filePath);
  const source = readFileSync(filePath, "utf8");
  const errors = [];
  for (const target of markdownLinkTargets(source)) {
    const resolved = localLinkPath(filePath, target);
    if (resolved && !existsSync(resolved)) {
      errors.push(`${relativePath}: relative Markdown link does not resolve: ${target}`);
    }
  }
  return errors;
}

function validateWrapperTarget(repoRoot, wrapperRelativePath, targetRelativePath) {
  const wrapperPath = path.join(repoRoot, wrapperRelativePath);
  const targetPath = path.resolve(repoRoot, targetRelativePath);
  if (!isFile(wrapperPath)) return [`${wrapperRelativePath}: required wrapper is missing`];
  if (!isFile(targetPath)) {
    return [`${wrapperRelativePath}: canonical target is missing: ${targetRelativePath}`];
  }

  const source = readFileSync(wrapperPath, "utf8");
  const links = markdownLinkTargets(source);
  const pointsToTarget =
    source.includes(targetRelativePath) ||
    links.some((link) => localLinkPath(wrapperPath, link) === targetPath);
  return pointsToTarget
    ? []
    : [`${wrapperRelativePath}: must link to canonical target ${targetRelativePath}`];
}

function validateWrapperInstructions(repoRoot, wrapperRelativePath) {
  const wrapperPath = path.join(repoRoot, wrapperRelativePath);
  if (!isFile(wrapperPath)) return [];

  const source = readFileSync(wrapperPath, "utf8");
  const errors = [];
  if (/\b(?:do not|don't|never)\s+(?:read|follow)\b/i.test(source)) {
    errors.push(`${wrapperRelativePath}: wrapper must not negate canonical read/follow`);
  }
  if (!/\bread\b/i.test(source) || !/\bfollow\b/i.test(source)) {
    errors.push(`${wrapperRelativePath}: wrapper must explicitly read and follow its canonical target`);
  }

  if (wrapperRelativePath.startsWith(".claude/commands/")) {
    if (!source.includes("$ARGUMENTS")) {
      errors.push(`${wrapperRelativePath}: command wrapper must forward $ARGUMENTS`);
    }
    if (wrapperRelativePath === ".claude/commands/ship-next.md") {
      if (!source.includes("/loop") || !/\b(?:one|exactly one)\b/i.test(source) || !/\bstop\b/i.test(source)) {
        errors.push(`${wrapperRelativePath}: ship-next wrapper must preserve the /loop one-item-and-stop contract`);
      }
    }
    if (
      wrapperRelativePath === ".claude/commands/haven-reset.md" &&
      !/select the Claude Code client procedure/i.test(source)
    ) {
      errors.push(`${wrapperRelativePath}: haven-reset wrapper must select the Claude Code client procedure`);
    }
  }

  return errors;
}

function requiredReferenceErrors(repoRoot) {
  const required = [
    ...REQUIRED_ROLES.map(
      (name) =>
        `.agents/skills/haven-agent-workflow/references/${ROLE_REFERENCES[name]}.md`,
    ),
    ...RESET_CLIENTS.map((name) => `.agents/skills/haven-reset/references/${name}.md`),
  ];
  return required.flatMap((relativePath) =>
    isFile(path.join(repoRoot, relativePath))
      ? []
      : [`${relativePath}: required canonical reference is missing`],
  );
}

function markdownFilesBelow(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFilesBelow(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

function portableMarkdownFiles(repoRoot) {
  const claudeResetAdapter = path.resolve(
    repoRoot,
    ".agents/skills/haven-reset/references/claude-code.md",
  );
  return markdownFilesBelow(path.join(repoRoot, ".agents/skills")).filter(
    (filePath) => path.resolve(filePath) !== claudeResetAdapter,
  );
}

function validatePortableLanguage(repoRoot, filePath) {
  const relativePath = displayPath(repoRoot, filePath);
  const source = readFileSync(filePath, "utf8");
  return FORBIDDEN_PORTABLE_PATTERNS.flatMap(([label, pattern]) =>
    pattern.test(source)
      ? [`${relativePath}: portable workflow contains vendor-specific identifier "${label}"`]
      : [],
  );
}

/**
 * Validate the portable Haven agent skills rooted at `repoRoot`.
 *
 * Returns actionable error strings and never exits the process, so callers can
 * use the validator from tests or other repository checks.
 */
export function validateAgentSkills(repoRoot = process.cwd()) {
  const absoluteRoot = path.resolve(repoRoot);
  const errors = [];

  for (const skillName of REQUIRED_SKILLS) {
    errors.push(...validateSkillFrontmatter(absoluteRoot, skillName));
  }
  errors.push(...requiredReferenceErrors(absoluteRoot));

  const targets = { ...COMMAND_TARGETS, ...AGENT_TARGETS };
  for (const [wrapper, target] of Object.entries(targets)) {
    errors.push(...validateWrapperTarget(absoluteRoot, wrapper, target));
    errors.push(...validateWrapperInstructions(absoluteRoot, wrapper));
  }

  const markdownFiles = [
    ...markdownFilesBelow(path.join(absoluteRoot, ".agents/skills")),
    ...Object.keys(targets)
      .map((relativePath) => path.join(absoluteRoot, relativePath))
      .filter(isFile),
  ];

  for (const filePath of new Set(markdownFiles)) {
    errors.push(...validateRelativeLinks(absoluteRoot, filePath));
  }
  for (const filePath of portableMarkdownFiles(absoluteRoot)) {
    errors.push(...validatePortableLanguage(absoluteRoot, filePath));
  }

  return errors;
}

export function runCli(repoRoot = process.cwd()) {
  const errors = validateAgentSkills(repoRoot);
  if (errors.length === 0) {
    console.log("Agent skill validation passed.");
    return 0;
  }

  console.error(`Agent skill validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  process.exitCode = runCli(process.argv[2] ?? process.cwd());
}
