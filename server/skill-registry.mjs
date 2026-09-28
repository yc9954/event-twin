import { readFileSync } from "node:fs";

// Application-authored Agent Skills, not build.nvidia.com Skill APIs. Paths are
// fixed at build time; project data and model output cannot select a file.
const specs = Object.freeze([
  ["event-brief-evidence", new URL("../skills/event-brief-evidence/SKILL.md", import.meta.url)],
  ["event-space-experiments", new URL("../skills/event-space-experiments/SKILL.md", import.meta.url)],
  ["event-crm-execution", new URL("../skills/event-crm-execution/SKILL.md", import.meta.url)],
  ["event-operations-replanning", new URL("../skills/event-operations-replanning/SKILL.md", import.meta.url)],
]);

const MAX_SKILL_BYTES = 8192;

export function parseAgentSkill(source, expectedName) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_SKILL_BYTES)
    throw new Error(`Invalid Agent Skill size: ${expectedName}`);
  const normalized = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error(`Invalid Agent Skill frontmatter: ${expectedName}`);
  const fields = new Map();
  for (const line of match[1].split("\n")) {
    const pair = /^(name|description): ([^\n]+)$/.exec(line);
    if (!pair || fields.has(pair[1]))
      throw new Error(`Invalid Agent Skill metadata: ${expectedName}`);
    fields.set(pair[1], pair[2].trim());
  }
  const name = fields.get("name");
  const description = fields.get("description");
  const instructions = match[2].trim();
  if (
    name !== expectedName ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    !description || description.length > 240 ||
    !instructions
  ) throw new Error(`Invalid Agent Skill contents: ${expectedName}`);
  return Object.freeze({ name, description, instructions, source: "event-twin-local" });
}

const skills = Object.freeze(specs.map(([name, url]) =>
  parseAgentSkill(readFileSync(url, "utf8"), name),
));

export function listAgentSkills() {
  return skills.map(({ name, description, source }) => ({ name, description, source }));
}

export function agentSkillInstructions() {
  return [
    "# Event Twin 로컬 Agent Skills",
    "아래 지침은 앱에 포함된 행사 도메인 스킬이며 NVIDIA Skill API의 실행 또는 인증을 뜻하지 않는다. 서버의 도구 권한과 오너 승인 규칙이 우선한다.",
    ...skills.map(({ name, instructions }) => `## ${name}\n${instructions}`),
  ].join("\n\n");
}
