import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_ROLES,
  REQUIRED_SKILLS,
  RESET_CLIENTS,
  ROLE_REFERENCES,
  validateAgentSkills,
} from "./validate-agent-skills.mjs";

const scriptPath = fileURLToPath(new URL("./validate-agent-skills.mjs", import.meta.url));

function write(root, relativePath, source) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

function skill(name, body = "Follow the portable workflow.") {
  return `---
name: ${name}
description: Use when a user requests the ${name} workflow for a Haven task.
---

# ${name}

${body}
`;
}

function makeValidFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "haven-agent-skills-"));

  for (const name of REQUIRED_SKILLS) {
    write(root, `.agents/skills/${name}/SKILL.md`, skill(name));
  }

  for (const role of REQUIRED_ROLES) {
    write(
      root,
      `.agents/skills/haven-agent-workflow/references/${ROLE_REFERENCES[role]}.md`,
      `# ${role}\n\nUse available repository capabilities for this role.\n`,
    );
    write(
      root,
      `.claude/agents/${role}.md`,
      `---\nname: ${role}\n---\n\nRead and follow \`.agents/skills/haven-agent-workflow/references/${ROLE_REFERENCES[role]}.md\`.\n`,
    );
  }

  for (const client of RESET_CLIENTS) {
    write(
      root,
      `.agents/skills/haven-reset/references/${client}.md`,
      `# ${client}\n\nClient adapter instructions.\n`,
    );
  }

  for (const command of ["new-task", "ship-next", "haven-reset"]) {
    const suffix =
      command === "ship-next"
        ? " When invoked through /loop, complete exactly one issue and stop."
        : command === "haven-reset"
          ? " Always select the Claude Code client procedure."
          : "";
    write(
      root,
      `.claude/commands/${command}.md`,
      `Read and follow [the canonical skill](../../.agents/skills/${command}/SKILL.md). Treat $ARGUMENTS as input.${suffix}\n`,
    );
  }

  return root;
}

test("accepts a complete portable skill layout", () => {
  const root = makeValidFixture();
  assert.deepEqual(validateAgentSkills(root), []);
});

test("reports invalid frontmatter and unresolved local links", () => {
  const root = makeValidFixture();
  write(
    root,
    ".agents/skills/new-task/SKILL.md",
    `---
name: wrong-name
description: TODO
vendor: claude
---

See [missing guidance](./references/missing.md).
`,
  );

  const errors = validateAgentSkills(root).join("\n");
  assert.match(errors, /name "wrong-name" must match folder "new-task"/);
  assert.match(errors, /unsupported frontmatter key "vendor"/);
  assert.match(errors, /description still contains placeholder text/);
  assert.match(errors, /relative Markdown link does not resolve/);
});

test("requires every wrapper to link to its canonical target", () => {
  const root = makeValidFixture();
  write(root, ".claude/commands/ship-next.md", "Run the old embedded workflow.\n");
  write(
    root,
    ".claude/agents/haven-reviewer.md",
    "Follow [the wrong role](../../.agents/skills/haven-agent-workflow/references/explorer.md).\n",
  );

  const errors = validateAgentSkills(root).join("\n");
  assert.match(errors, /\.claude\/commands\/ship-next\.md: must link to canonical target/);
  assert.match(errors, /\.claude\/agents\/haven-reviewer\.md: must link to canonical target/);
});

test("requires wrappers to read and follow canonical targets and forward command arguments", () => {
  const root = makeValidFixture();
  write(
    root,
    ".claude/commands/new-task.md",
    "Do not read `.agents/skills/new-task/SKILL.md`; use the old embedded workflow.\n",
  );
  write(
    root,
    ".claude/commands/ship-next.md",
    "Read and follow `.agents/skills/ship-next/SKILL.md`. Run one item and stop.\n",
  );
  write(
    root,
    ".claude/agents/haven-reviewer.md",
    "Use `.agents/skills/haven-agent-workflow/references/reviewer.md`.\n",
  );

  const errors = validateAgentSkills(root).join("\n");
  assert.match(errors, /new-task\.md: wrapper must not negate canonical read\/follow/);
  assert.match(errors, /new-task\.md: command wrapper must forward \$ARGUMENTS/);
  assert.match(errors, /ship-next\.md: command wrapper must forward \$ARGUMENTS/);
  assert.match(errors, /ship-next\.md: ship-next wrapper must preserve the \/loop one-item-and-stop contract/);
  assert.match(errors, /haven-reviewer\.md: wrapper must explicitly read and follow/);
});

test("requires the haven-reset wrapper to select the Claude Code adapter", () => {
  const root = makeValidFixture();
  write(
    root,
    ".claude/commands/haven-reset.md",
    "Read and follow `.agents/skills/haven-reset/SKILL.md`. Treat $ARGUMENTS as input.\n",
  );

  const errors = validateAgentSkills(root).join("\n");
  assert.match(errors, /haven-reset\.md: haven-reset wrapper must select the Claude Code client procedure/);
});

test("requires role and reset client references", () => {
  const root = makeValidFixture();
  const missingRole = path.join(
    root,
    ".agents/skills/haven-agent-workflow/references/doc-reviewer.md",
  );
  const missingClient = path.join(
    root,
    ".agents/skills/haven-reset/references/codex.md",
  );
  unlinkSync(missingRole);
  unlinkSync(missingClient);

  const errors = validateAgentSkills(root).join("\n");
  assert.match(errors, /doc-reviewer\.md: required canonical reference is missing/);
  assert.match(errors, /codex\.md: required canonical reference is missing/);
  assert.match(errors, /canonical target is missing/);
});

test("rejects vendor identifiers in portable text but permits the Claude reset adapter", () => {
  const root = makeValidFixture();
  write(
    root,
    ".agents/skills/ship-next/SKILL.md",
    skill(
      "ship-next",
      "Call AskUserQuestion before using mcp__github__issue_write, then invoke Read.",
    ),
  );
  write(
    root,
    ".agents/skills/haven-reset/references/claude-code.md",
    "# Claude Code\n\nUse AskUserQuestion and mcp__github__ only in this vendor adapter.\n",
  );

  const errors = validateAgentSkills(root).join("\n");
  assert.match(errors, /ship-next\/SKILL\.md:.*"AskUserQuestion"/);
  assert.match(errors, /ship-next\/SKILL\.md:.*"mcp__github__"/);
  assert.match(errors, /ship-next\/SKILL\.md:.*"Read"/);
  assert.doesNotMatch(errors, /claude-code\.md: portable workflow/);
});

test("CLI exits nonzero and prints actionable errors", () => {
  const root = makeValidFixture();
  write(root, ".claude/commands/new-task.md", "No canonical link.\n");

  const result = spawnSync(process.execPath, [scriptPath, root], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Agent skill validation failed/);
  assert.match(result.stderr, /\.claude\/commands\/new-task\.md/);
  assert.match(result.stderr, /must link to canonical target/);
});
