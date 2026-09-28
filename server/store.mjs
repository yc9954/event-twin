import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

export class AppError extends Error {
  constructor(message, status = 400, code = "INVALID_INPUT") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = join(dataDir, "event-twin.sqlite");
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, version INTEGER NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), mime TEXT NOT NULL, bytes BLOB NOT NULL);`);
  const queues = new Map();
  function get(id) {
    const row = db
      .prepare("SELECT document FROM projects WHERE id = ?")
      .get(id);
    if (!row)
      throw new AppError("프로젝트를 찾을 수 없습니다.", 404, "NOT_FOUND");
    return JSON.parse(row.document);
  }
  function create(project) {
    db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run(
      project.id,
      project.version,
      project.name,
      project.updatedAt,
      JSON.stringify(project),
    );
    return structuredClone(project);
  }
  async function mutate(
    id,
    expectedVersion,
    operation,
    { internal = false } = {},
  ) {
    if (
      !internal &&
      (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    )
      throw new AppError(
        "expectedVersion이 필요합니다.",
        400,
        "VERSION_REQUIRED",
      );
    const previous = queues.get(id) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        const project = get(id),
          originalVersion = project.version;
        if (!internal && originalVersion !== expectedVersion)
          throw new AppError(
            "다른 작업이 프로젝트를 변경했습니다. 새로 불러와 주세요.",
            409,
            "VERSION_CONFLICT",
          );
        const outcome = (await operation(project)) || {};
        if (outcome.noChange) return { project, ...outcome };
        project.version = originalVersion + 1;
        project.updatedAt = new Date().toISOString();
        db.exec("BEGIN IMMEDIATE");
        try {
          const update = db
            .prepare(
              "UPDATE projects SET version=?, name=?, updated_at=?, document=? WHERE id=? AND version=?",
            )
            .run(
              project.version,
              project.name,
              project.updatedAt,
              JSON.stringify(project),
              id,
              originalVersion,
            );
          if (update.changes !== 1)
            throw new AppError(
              "프로젝트가 변경됐습니다.",
              409,
              "VERSION_CONFLICT",
            );
          if (outcome.upload)
            db.prepare("INSERT INTO uploads VALUES (?, ?, ?, ?)").run(
              outcome.upload.id,
              id,
              outcome.upload.mime,
              outcome.upload.bytes,
            );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        const { upload, ...publicOutcome } = outcome;
        return { project, ...publicOutcome };
      });
    queues.set(id, task);
    try {
      return await task;
    } finally {
      if (queues.get(id) === task) queues.delete(id);
    }
  }
  return {
    get,
    create,
    mutate,
    list: () =>
      db
        .prepare(
          "SELECT id, name, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC",
        )
        .all(),
    upload: (projectId, id) => {
      const row = db
        .prepare("SELECT mime, bytes FROM uploads WHERE project_id=? AND id=?")
        .get(projectId, id);
      if (!row)
        throw new AppError("첨부 파일을 찾을 수 없습니다.", 404, "NOT_FOUND");
      return { mime: row.mime, bytes: Buffer.from(row.bytes) };
    },
    close: async () => {
      await Promise.allSettled([...queues.values()]);
      db.close();
    },
  };
}
