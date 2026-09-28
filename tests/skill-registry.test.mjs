import test from "node:test";
import assert from "node:assert/strict";
import {
  agentSkillInstructions,
  listAgentSkills,
  parseAgentSkill,
} from "../server/skill-registry.mjs";

test("only application-authored allowlisted Agent Skills enter model context", () => {
  const entries = listAgentSkills();
  assert.deepEqual(entries.map((entry) => entry.name), [
    "event-brief-evidence",
    "event-space-experiments",
    "event-crm-execution",
    "event-operations-replanning",
  ]);
  assert.ok(entries.every((entry) => entry.source === "event-twin-local"));
  const context = agentSkillInstructions();
  assert.match(context, /NVIDIA Skill API의 실행 또는 인증을 뜻하지 않는다/);
  for (const { name } of entries) assert.match(context, new RegExp(`## ${name}\\n`));
  assert.match(context, /오너.*승인/);
  assert.match(context, /실제 현장 결과/);
  assert.equal(context, agentSkillInstructions());
});

test("skill parser rejects malformed, substituted, or oversized instructions", () => {
  const good = "---\nname: event-test\ndescription: Test skill\n---\n\n# Guidance";
  assert.equal(parseAgentSkill(good, "event-test").instructions, "# Guidance");
  assert.throws(() => parseAgentSkill(good, "other-name"), /Invalid Agent Skill contents/);
  assert.throws(() => parseAgentSkill("# Missing frontmatter", "event-test"), /frontmatter/);
  assert.throws(() => parseAgentSkill(good.replace("description:", "script:"), "event-test"), /metadata/);
  assert.throws(() => parseAgentSkill(good + "x".repeat(8192), "event-test"), /size/);
});
