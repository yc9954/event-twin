import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../server/http.mjs";

test("read-only NAT audit API returns a version-bound receipt and fails closed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "event-twin-nat-api-"));
  let mode = "ready";
  let project;
  const app = await createAppServer({
    dataDir: dir, port: 0, scheduler: false,
    dependencies: {
      getNatExperimentAudit: async (id) => {
        assert.equal(id, project.id);
        if (mode === "offline") throw Object.assign(new Error("offline"), { status: 503 });
        return {
          projectId: id,
          projectVersion: project.version - (mode === "stale" ? 1 : 0),
          inputRevision: project.inputRevision,
          status: "not_run", issueCodes: ["NO_SIMULATION"],
        };
      },
    },
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const created = await fetch(base + "/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "NAT endpoint QA" }),
  });
  project = (await created.json()).project;
  const path = `/api/projects/${project.id}/nat-audit`;

  const ok = await fetch(base + path);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).natAudit.issueCodes, ["NO_SIMULATION"]);
  assert.equal((await (await fetch(base + `/api/projects/${project.id}`)).json()).project.version,
    project.version);

  mode = "stale";
  const stale = await fetch(base + path);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "NAT_AUDIT_STALE");

  mode = "offline";
  const unavailable = await fetch(base + path);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "NAT_UNAVAILABLE_OR_INVALID");
});
