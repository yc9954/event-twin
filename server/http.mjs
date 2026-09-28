import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { createStore, AppError } from "./store.mjs";
import { createDomain, createProject, audit } from "./domain.mjs";
import { initializeDemoProject } from "./demo-project.mjs";
import { sanitizeAgentEvent } from "./agent.mjs";
import { runtimeDescriptor } from "./agent-runtime.mjs";
import { assertGatewayAccess } from './gateway-auth.mjs';
import { createDemoAccess } from './demo-access.mjs';
import { createModelQueue } from './model-queue.mjs';
import { getModelConfiguration } from "./model-provider.mjs";
import { createIntegrationChecks } from "./integration-checks.mjs";
import {
  createMapService,
  validateMapRequest,
  MapDataError,
} from "./map-service.mjs";
import { checkNatBridge, getNatExperimentAudit } from "./nat-bridge.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SCENE_VIDEO_BYTES = 64 * 1024 * 1024;
const MAX_TAB_VIDEO_BYTES = 256 * 1024 * 1024;
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function imageDimensions(bytes, mime) {
  if (mime === "image/png")
    return bytes.length >= 24
      ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
      : null;
  if (mime === "image/webp") {
    const type = bytes.toString("ascii", 12, 16);
    if (bytes.length < 30) return null;
    const chunkLength = bytes.readUInt32LE(16);
    if (20 + chunkLength > bytes.length) return null;
    if (type === "VP8X" && chunkLength >= 10)
      return [
        1 + bytes.readUIntLE(24, 3),
        1 + bytes.readUIntLE(27, 3),
      ];
    if (type === "VP8L" && chunkLength >= 5 && bytes[20] === 0x2f)
      return [
        1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      ];
    if (
      type === "VP8 " && chunkLength >= 10 &&
      bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
    )
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    return null;
  }
  // JPEG dimensions appear in a Start Of Frame segment before image data.
  // Do not scan compressed data for incidental marker-shaped bytes.
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    )
      return length >= 7
        ? [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]
        : null;
    offset += length;
  }
  return null;
}

export function validateUpload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AppError("업로드 입력을 확인해 주세요.");
  if (
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 180 ||
    /[\0-\x1f]/.test(body.name)
  )
    throw new AppError("파일 이름이 잘못되었습니다.");
  if (!["image/png", "image/jpeg", "image/webp"].includes(body.mime))
    throw new AppError(
      "PNG, JPEG, WebP 이미지만 지원합니다.",
      415,
      "UNSUPPORTED_MEDIA",
    );
  if (
    typeof body.data !== "string" ||
    body.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      body.data,
    )
  )
    throw new AppError("올바른 5MB 이하 Base64 이미지가 필요합니다.");
  const bytes = Buffer.from(body.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new AppError(
      "이미지는 5MB 이하여야 합니다.",
      413,
      "UPLOAD_TOO_LARGE",
    );
  let valid = false;
  if (body.mime === "image/png") {
    valid =
      bytes.length >= 33 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString("ascii", 12, 16) === "IHDR";
  } else if (body.mime === "image/jpeg")
    valid =
      bytes.length >= 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255 &&
      bytes.at(-2) === 255 &&
      bytes.at(-1) === 217;
  else
    valid =
      bytes.length >= 20 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP" &&
      bytes.readUInt32LE(4) === bytes.length - 8 &&
      ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16));
  const dimensions = valid ? imageDimensions(bytes, body.mime) : null;
  valid = Boolean(
    dimensions &&
    dimensions[0] > 0 && dimensions[1] > 0 &&
    dimensions[0] <= 12000 && dimensions[1] <= 12000 &&
    dimensions[0] * dimensions[1] <= 64000000,
  );
  if (!valid)
    throw new AppError(
      "파일의 실제 이미지 서명이 MIME 유형과 일치하지 않습니다.",
      415,
      "INVALID_IMAGE",
    );
  return {
    name: body.name.trim().replace(/[\\/]/g, "_"),
    mime: body.mime,
    bytes,
  };
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || ""))
    throw new AppError(
      "application/json 형식이 필요합니다.",
      415,
      "UNSUPPORTED_MEDIA",
    );
  const declared = Number(request.headers["content-length"]);
  if (declared > MAX_JSON_BYTES)
    throw new AppError("요청이 너무 큽니다.", 413, "BODY_TOO_LARGE");
  let count = 0;
  const chunks = [];
  for await (const chunk of request) {
    count += chunk.length;
    if (count > MAX_JSON_BYTES)
      throw new AppError("요청이 너무 큽니다.", 413, "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("유효한 JSON 객체가 필요합니다.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AppError("JSON 객체가 필요합니다.");
  return body;
}
async function readDemoVideo(request, maxBytes) {
  const mime = (request.headers["content-type"] || "").split(";")[0].toLowerCase();
  if (!["video/webm", "video/mp4"].includes(mime))
    throw new AppError("WebM 또는 MP4 영상만 저장할 수 있습니다.", 415, "UNSUPPORTED_MEDIA");
  if (Number(request.headers["content-length"]) > maxBytes)
    throw new AppError("영상 파일이 저장 한도를 초과했습니다.", 413, "VIDEO_TOO_LARGE");
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes)
      throw new AppError("영상 파일이 저장 한도를 초과했습니다.", 413, "VIDEO_TOO_LARGE");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const valid = mime === "video/webm"
    ? bytes.length > 32 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : bytes.length > 32 && bytes.toString("ascii", 4, 8) === "ftyp";
  if (!valid) throw new AppError("영상 파일 서명이 올바르지 않습니다.", 415, "INVALID_VIDEO");
  return { mime, bytes, extension: mime === "video/mp4" ? "mp4" : "webm" };
}
function json(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  response.end(data);
}

function chatEventStream(response) {
  const requestId = randomUUID(),
    events = [];
  let sequence = 0,
    ended = false;
  function write(type, fields = {}, status = 200) {
    if (ended || response.destroyed || response.writableEnded) return;
    if (!response.headersSent) {
      response.writeHead(status, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
    }
    const event = {
      ...fields,
      type,
      requestId,
      sequence: ++sequence,
      at: fields.at || new Date().toISOString(),
    };
    response.write(JSON.stringify(event) + "\n");
    return event;
  }
  return {
    async onEvent(event) {
      if (event?.type !== "response.delta" && events.length >= 64) return;
      const safe = sanitizeAgentEvent(event);
      if (!safe) return;
      const delivered = write(safe.type, { ...safe, committed: false });
      if (delivered && safe.type !== "response.delta") events.push(delivered);
      // Yield before synchronous local tools so their start is observable now.
      await new Promise((resolveEvent) => setImmediate(resolveEvent));
    },
    complete(data) {
      write("response.completed", { status: 200, committed: true, data });
      ended = true;
      response.end();
    },
    fail(status, body) {
      // Headers may already be 200; retain the real error status in-band.
      // Earlier tool receipts describe a draft that was NOT committed.
      write(
        "response.failed",
        { ...body, status, committed: false, events },
        status,
      );
      ended = true;
      response.end();
    },
  };
}

export async function createAppServer({
  dataDir = resolve(rootDir, "data"),
  port = 4180,
  staticDir = resolve(rootDir, "dist"),
  dependencies = {},
  scheduler = true,
  model,
  modelConfigured,
} = {}) {
  // Keep health, consent checks and the actual request on one startup snapshot.
  // .env/provider changes require restart; never silently change a recipient.
  const modelEnvironment = Object.fromEntries(
    [
      "MODEL_PROVIDER",
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
      "NVIDIA_API_KEY",
      "NVIDIA_MODEL",
      "NVIDIA_BASE_URL",
      "NIM_BASE_URL",
      "NIM_MODEL",
      "NIM_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_MODEL",
      "MODEL_FALLBACK_PROVIDER",
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  if (model !== undefined) {
    const modelKey = {
      openai: "OPENAI_MODEL",
      nvidia: "NVIDIA_MODEL",
      nim: "NIM_MODEL",
      anthropic: "ANTHROPIC_MODEL",
    }[modelEnvironment.MODEL_PROVIDER || "openai"];
    if (modelKey) modelEnvironment[modelKey] = model;
  }
  Object.freeze(modelEnvironment);
  const configuration = getModelConfiguration(modelEnvironment);
  const inferenceRoute = configuration.provider === 'nim' ? 'self-hosted-endpoint'
    : configuration.provider === 'nvidia' && configuration.baseURL === 'https://inference.local/v1'
      ? 'openshell-managed-inference' : 'hosted-api';
  model ??= configuration.model;
  modelConfigured ??= configuration.configured;
  const engine =
    dependencies.generateCandidates && dependencies.runBatch
      ? dependencies
      : await import("../shared/simulation.mjs");
  const research =
    dependencies.analyzeArea || (await import("./research.mjs")).analyzeArea;
  const auditExperiment = dependencies.getNatExperimentAudit || getNatExperimentAudit;
  const runAgent =
    dependencies.runAgent || (await import("./agent.mjs")).runAgent;
  const queueModel = createModelQueue();
  const configuredAgent = args => args.useModel ? queueModel(()=>runAgent({ ...args, env: modelEnvironment })) : runAgent({ ...args, env: modelEnvironment });
  const checks = createIntegrationChecks({
    runAgent: configuredAgent,
    getConfiguration: () => ({
      ...configuration,
      model,
      configured: modelConfigured,
    }),
  });
  function assertModelConsent(expectedConnectionId) {
    if (
      typeof expectedConnectionId !== "string" ||
      expectedConnectionId !== configuration.connectionId
    )
      throw new AppError(
        "모델 연결이 변경되었거나 전송 대상 동의가 없습니다. 연결 정보를 새로 확인하고 모델 사용에 다시 동의해주세요. 이번 요청은 전송하지 않았습니다.",
        409,
        "MODEL_CONNECTION_CHANGED",
      );
  }
  let natCheck = null,
    natChecking = false,
    natCheckedAt = 0;
  const mapService = dependencies.fetchMapContext
    ? { fetchMapContext: dependencies.fetchMapContext }
    : createMapService({ cacheDir: resolve(dataDir, "map-cache") });
  const domain = createDomain({
    generateCandidates: engine.generateCandidates,
    runBatch: engine.runBatch,
    analyzeArea: research,
  });
  const store = createStore(dataDir);
  const demoAccess = createDemoAccess(dataDir);
  let closing = false,
    schedulerRunning = false;
  const allowedHost = () => `127.0.0.1:${server.address()?.port || port}`;
  function secureRequest(request) {
    assertGatewayAccess(request.headers, process.env.EVENT_TWIN_GATEWAY_KEY);
    const localPort = server.address()?.port || port;
    const hosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    if (!hosts.includes(request.headers.host))
      throw new AppError("허용되지 않은 Host입니다.", 403, "HOST_REJECTED");
    if (
      request.headers.origin &&
      !hosts.map((host) => `http://${host}`).includes(request.headers.origin)
    )
      throw new AppError("허용되지 않은 Origin입니다.", 403, "ORIGIN_REJECTED");
    if (request.headers["sec-fetch-site"] === "cross-site")
      throw new AppError(
        "교차 사이트 요청은 허용되지 않습니다.",
        403,
        "ORIGIN_REJECTED",
      );
  }
  async function staticResponse(pathname, response, method) {
    if (!["GET", "HEAD"].includes(method))
      throw new AppError(
        "지원하지 않는 요청입니다.",
        405,
        "METHOD_NOT_ALLOWED",
      );
    const decoded = decodeURIComponent(pathname);
    if (
      decoded.includes("\0") ||
      decoded.includes("\\") ||
      decoded.split("/").includes("..")
    )
      throw new AppError("잘못된 경로입니다.", 400, "INVALID_PATH");
    let file = resolve(
      staticDir,
      `.${decoded === "/" ? "/index.html" : decoded}`,
    );
    const staticRoot = await realpath(staticDir).catch(() => null);
    if (!staticRoot || !file.startsWith(resolve(staticDir) + sep))
      throw new AppError(
        "먼저 npm run build를 실행해 주세요.",
        404,
        "NOT_FOUND",
      );
    let physical = await realpath(file).catch(() => null);
    if (!physical && !decoded.split("/").at(-1).includes("."))
      physical = await realpath(resolve(staticDir, "index.html")).catch(
        () => null,
      );
    if (!physical || !physical.startsWith(staticRoot + sep))
      throw new AppError("파일을 찾을 수 없습니다.", 404, "NOT_FOUND");
    const extension = physical.slice(physical.lastIndexOf("."));
    if (!MIME_TYPES[extension] || !(await stat(physical)).isFile())
      throw new AppError("파일을 찾을 수 없습니다.", 404, "NOT_FOUND");
    const bytes = await readFile(physical);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension],
      "Content-Length": bytes.length,
      "Cache-Control":
        extension === ".html" ? "no-cache" : "public, max-age=60",
    });
    response.end(method === "HEAD" ? undefined : bytes);
  }
  const server = http.createServer(async (request, response) => {
    let chatStream;
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      secureRequest(request);
      if (closing)
        throw new AppError("서버를 종료하고 있습니다.", 503, "SHUTTING_DOWN");
      const pathname = new URL(request.url, `http://${allowedHost()}`).pathname;
      const method = request.method;
      const demoOwner = demoAccess.owner(request.headers);
      if(demoOwner && pathname.startsWith('/api/demo/'))throw new AppError('공개 데모에서는 녹화 저장을 지원하지 않습니다.',403,'DEMO_DISABLED');
      if (pathname === "/api/health" && method === "GET")
        return json(response, 200, {
          ok: true,
          modelConfigured,
          model,
          provider: {
            ...configuration,
            model,
            configured: modelConfigured,
            protocol: configuration.capabilities.api,
            route: inferenceRoute,
          },
          integrationCheck: checks.snapshot(),
          natCheck,
          runtime: runtimeDescriptor({
            modelConfigured,
            model,
            provider: configuration.provider,
            connectionId: configuration.connectionId,
            route: inferenceRoute,
            check: checks.snapshot(),
          }),
          mode: "local-single-owner",
          version: 1,
        });
      if (["/api/demo/scene-video", "/api/demo/tab-video"].includes(pathname) && method === "POST") {
        const isTab = pathname.endsWith("tab-video");
        const video = await readDemoVideo(request, isTab ? MAX_TAB_VIDEO_BYTES : MAX_SCENE_VIDEO_BYTES);
        const directory = resolve(dataDir, "demo-recordings");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${isTab ? "tab" : "scene"}-${randomUUID()}.${video.extension}`);
        await writeFile(path, video.bytes, { flag: "wx", mode: 0o600 });
        return json(response, 201, { path, bytes: video.bytes.length, mime: video.mime });
      }
      if (pathname === "/api/integrations/check" && method === "POST") {
        const body = await readJson(request);
        if (
          body.confirm !== true ||
          Object.keys(body).some(
            (key) => !["confirm", "expectedConnectionId"].includes(key),
          )
        )
          throw new AppError(
            "임시 테스트 요청 전송 동의가 필요합니다.",
            400,
            "CHECK_CONSENT_REQUIRED",
          );
        assertModelConsent(body.expectedConnectionId);
        try {
          return json(response, 200, { check: await checks.check() });
        } catch (error) {
          throw new AppError(
            error.message,
            error.status || 502,
            error.code || "CHECK_FAILED",
          );
        }
      }
      if (pathname === "/api/integrations/nat-check" && method === "POST") {
        const body = await readJson(request);
        if (Object.keys(body).length)
          throw new AppError("NAT 검사는 입력 데이터를 받지 않습니다.");
        if (natChecking || Date.now() - natCheckedAt < 5000)
          throw new AppError("잠시 후 다시 확인하세요.", 429, "NAT_CHECK_BUSY");
        natChecking = true;
        try {
          natCheck = await checkNatBridge();
          natCheckedAt = Date.now();
        } finally {
          natChecking = false;
        }
        return json(response, 200, { natCheck });
      }
      if (pathname === "/api/projects" && method === "GET")
        return json(response, 200, { projects: store.list().filter(p=>!demoOwner||demoAccess.owns(demoOwner,p.id)) });
      if (pathname === "/api/projects" && method === "POST") {
        const body = await readJson(request);
        if (Object.keys(body).some((key) => !["name", "template"].includes(key)) ||
            (body.template !== undefined && !["blank", "demo"].includes(body.template)))
          throw new AppError("프로젝트 이름과 지원되는 시작 방식만 지정할 수 있습니다.");
        const next=createProject(body.name);
        if (body.template === "demo") initializeDemoProject(next, domain);
        if(demoOwner)demoAccess.register(demoOwner,next.id);
        return json(response, 201, { project: store.create(next) });
      }
      const match = pathname.match(
        /^\/api\/projects\/([A-Za-z0-9-]+)(?:\/(actions|chat|uploads|export|map-refresh|nat-audit))?(?:\/([A-Za-z0-9-]+))?$/,
      );
      if (!match) {
        if (pathname.startsWith("/api/"))
          throw new AppError("API를 찾을 수 없습니다.", 404, "NOT_FOUND");
        return await staticResponse(pathname, response, method);
      }
      const [, id, endpoint, attachmentId] = match;
      if(demoOwner&&!demoAccess.owns(demoOwner,id))throw new AppError('프로젝트를 찾을 수 없습니다.',404,'NOT_FOUND');
      if (!endpoint && !attachmentId && method === "GET")
        return json(response, 200, { project: store.get(id) });
      if (endpoint === "nat-audit" && !attachmentId && method === "GET") {
        const before = store.get(id);
        let natAudit;
        try {
          natAudit = await auditExperiment(id);
        } catch (error) {
          throw new AppError(
            "NeMo Agent Toolkit 실험 검수에 연결할 수 없습니다. 저장된 결과는 변경되지 않았습니다.",
            error?.status === 400 ? 400 : 503,
            error?.code === "INVALID_PROJECT_ID" ? "INVALID_PROJECT_ID" : "NAT_UNAVAILABLE_OR_INVALID",
          );
        }
        const after = store.get(id);
        if (before.version !== after.version ||
            natAudit.projectVersion !== after.version ||
            natAudit.inputRevision !== after.inputRevision)
          throw new AppError(
            "검수 중 프로젝트가 변경되었습니다. 최신 결과로 다시 검수해 주세요.",
            409, "NAT_AUDIT_STALE",
          );
        return json(response, 200, { natAudit });
      }
      if (endpoint === "export" && !attachmentId && method === "GET") {
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${id}.json"`,
        );
        return json(response, 200, {
          exportedAt: new Date().toISOString(),
          mode: "local-private-export",
          project: store.get(id),
        });
      }
      if (endpoint === "uploads" && attachmentId && method === "GET") {
        const upload = store.upload(id, attachmentId);
        response.writeHead(200, {
          "Content-Type": upload.mime,
          "Content-Length": upload.bytes.length,
          "Cache-Control": "private, no-store",
          "Content-Disposition": "inline",
        });
        return response.end(upload.bytes);
      }
      if (method !== "POST" || attachmentId)
        throw new AppError(
          "지원하지 않는 요청입니다.",
          405,
          "METHOD_NOT_ALLOWED",
        );
      const body = await readJson(request);
      if (endpoint === "map-refresh") {
        if (
          Object.keys(body).some(
            (key) =>
              ![
                "expectedVersion",
                "latitude",
                "longitude",
                "radiusMeters",
              ].includes(key),
          )
        )
          throw new AppError("좌표와 반경만 지정할 수 있습니다.");
        let location;
        try {
          location = validateMapRequest(body);
        } catch (error) {
          throw new AppError(error.message, error.status || 400, error.code);
        }
        const output = await store.mutate(
          id,
          body.expectedVersion,
          async (project) => {
            let mapContext;
            try {
              mapContext = await mapService.fetchMapContext(location);
            } catch (error) {
              if (error instanceof MapDataError)
                throw new AppError(error.message, error.status, error.code);
              throw new AppError(
                "지도 서비스 요청에 실패했습니다. 이전 저장 데이터를 최신 데이터로 대체하지 않았습니다.",
                502,
                "MAP_UPSTREAM_UNAVAILABLE",
              );
            }
            if (
              project.brief.lat !== location.latitude ||
              project.brief.lng !== location.longitude
            )
              domain.applyAction(project, "UPDATE_BRIEF", {
                lat: location.latitude,
                lng: location.longitude,
              });
            project.mapContext = mapContext;
            domain.applyAction(project, "RUN_RESEARCH", {});
            audit(project, "REFRESH_MAP", {
              provider: mapContext.source.provider,
              collectedAt: mapContext.collectedAt,
              querySha256: mapContext.source.querySha256,
              cacheHit: mapContext.cache?.hit === true,
            });
            return { result: project.research };
          },
        );
        return json(response, 200, output);
      }
      if (endpoint === "actions") {
        const output = await store.mutate(
          id,
          body.expectedVersion,
          (project) => {
            const sameDeployment =
              body.type === "DEPLOY_CRM" && domain.isCurrentDeployment(project);
            const result = domain.applyAction(project, body.type, body.payload ?? {});
            return { result, ...(sameDeployment ? { noChange: true } : {}) };
          },
        );
        return json(response, 200, output);
      }
      if (endpoint === "uploads") {
        const upload = validateUpload(body);
        const output = await store.mutate(
          id,
          body.expectedVersion,
          (project) => {
            if (project.attachments.length >= 30)
              throw new AppError(
                "프로젝트당 최대 30개 이미지를 저장할 수 있습니다.",
              );
            const attachment = {
              id: `IMG-${randomUUID()}`,
              name: upload.name,
              mime: upload.mime,
              size: upload.bytes.length,
              createdAt: new Date().toISOString(),
            };
            attachment.url = `/api/projects/${id}/uploads/${attachment.id}`;
            project.attachments.push(attachment);
            audit(project, "UPLOAD_IMAGE", {
              attachmentId: attachment.id,
              size: attachment.size,
            });
            return {
              attachment,
              upload: {
                id: attachment.id,
                mime: attachment.mime,
                bytes: upload.bytes,
              },
            };
          },
        );
        return json(response, 201, output);
      }
      if (endpoint === "chat") {
        if (/\bapplication\/x-ndjson\b/i.test(request.headers.accept || ""))
          chatStream = chatEventStream(response);
        if (
          typeof body.message !== "string" ||
          !body.message.trim() ||
          body.message.length > 6000 ||
          typeof body.useModel !== "boolean"
        )
          throw new AppError("메시지와 useModel 설정을 확인해 주세요.");
        if (
          body.imageIds !== undefined &&
          (!Array.isArray(body.imageIds) ||
            body.imageIds.length > 3 ||
            body.imageIds.some((item) => typeof item !== "string"))
        )
          throw new AppError("최대 3개의 선택한 이미지를 첨부할 수 있습니다.");
        if (body.useModel) assertModelConsent(body.expectedConnectionId);
        if (body.useModel && !modelConfigured)
          throw new AppError(
            configuration.configurationError ||
              "서버 모델 연결 설정이 완료되지 않았습니다.",
            503,
            "MODEL_NOT_CONFIGURED",
          );
        const output = await store.mutate(
          id,
          body.expectedVersion,
          async (project) => {
            const imageIds = [...new Set(body.imageIds || [])];
            if (
              imageIds.some(
                (imageId) =>
                  !project.attachments.some((item) => item.id === imageId),
              )
            )
              throw new AppError("이 프로젝트의 첨부 이미지를 선택해 주세요.");
            const agentProject = structuredClone(domain.context(project));
            let agentResult;
            try {
              agentResult = await configuredAgent({
                project: agentProject,
                message: body.message.trim(),
                useModel: body.useModel,
                imageIds,
                onEvent: chatStream?.onEvent,
                executeTool: async (name, args) =>
                  structuredClone(domain.executeTool(project, name, args)),
                loadImage: async (imageId) => {
                  if (!body.useModel || !imageIds.includes(imageId))
                    throw new AppError(
                      "선택한 이미지만 모델에 전달할 수 있습니다.",
                      403,
                      "IMAGE_NOT_AUTHORIZED",
                    );
                  const file = store.upload(id, imageId);
                  return {
                    mime: file.mime,
                    data: file.bytes.toString("base64"),
                  };
                },
              });
            } catch (error) {
              if (error instanceof AppError) throw error;
              const providerCode = String(
                error.code || error.error?.code || "",
              );
              const creditFailure =
                /credit_balance_exhausted|insufficient_quota|billing_hard_limit_reached/.test(
                  providerCode,
                ) ||
                (error.status === 429 &&
                  /credit.?balance|insufficient.?quota|credits?.?(?:exhausted|insufficient)/i.test(
                    String(error.message),
                  ));
              if (body.useModel && creditFailure)
                throw new AppError(
                  "모델 API 크레딧이 부족합니다. 이번 대화의 변경은 저장하지 않았습니다. API 계정의 잔액을 확인하거나 로컬 명령 모드를 사용해 주세요.",
                  429,
                  "MODEL_CREDITS_EXHAUSTED",
                );
              if (body.useModel && error.status === 429)
                throw new AppError(
                  "모델 API 요청 한도에 도달했습니다. 이번 변경은 저장하지 않았습니다. 잠시 후 다시 요청해 주세요.",
                  429,
                  "MODEL_RATE_LIMITED",
                );
              throw new AppError(
                body.useModel
                  ? "모델 요청에 실패했습니다. 이번 대화의 변경은 저장하지 않았습니다. 서버 모델·연결 설정을 확인해 주세요."
                  : "로컬 도구 요청에 실패했습니다. 변경은 저장하지 않았습니다.",
                502,
                body.useModel ? "MODEL_REQUEST_FAILED" : "LOCAL_AGENT_FAILED",
              );
            }
            if (
              !agentResult ||
              typeof agentResult.reply !== "string" ||
              !Array.isArray(agentResult.steps)
            )
              throw new AppError(
                "에이전트 결과 형식이 잘못되었습니다.",
                502,
                "AGENT_RESULT_INVALID",
              );
            const time = new Date().toISOString();
            project.messages.push(
              {
                id: `MSG-${randomUUID()}`,
                role: "user",
                content: body.message.trim(),
                imageIds,
                useModel: body.useModel,
                connectionId: body.useModel ? configuration.connectionId : null,
                provider: body.useModel
                  ? agentResult.provider || configuration.provider
                  : null,
                at: time,
              },
              {
                id: `MSG-${randomUUID()}`,
                role: "assistant",
                content: agentResult.reply,
                steps: agentResult.steps,
                mode: body.useModel ? "model" : "local",
                connectionId: body.useModel ? configuration.connectionId : null,
                provider: body.useModel
                  ? agentResult.provider || configuration.provider
                  : null,
                model: body.useModel ? agentResult.model || model : null,
                modelContext: body.useModel ? agentResult.modelContext || null : null,
                modelActivity: body.useModel ? agentResult.modelActivity || [] : [],
                at: time,
              },
            );
            audit(project, "CHAT", {
              mode: body.useModel ? "model" : "local",
              toolCount: agentResult.steps.length,
            });
            return { reply: agentResult.reply, steps: agentResult.steps };
          },
        );
        if (chatStream) return chatStream.complete(output);
        return json(response, 200, output);
      }
      throw new AppError("API를 찾을 수 없습니다.", 404, "NOT_FOUND");
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const body = {
        error:
          error instanceof AppError
            ? error.message
            : "서버 처리에 실패했습니다. 입력과 로컬 저장소를 확인해 주세요.",
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      };
      if (chatStream) chatStream.fail(status, body);
      else if (!response.headersSent) json(response, status, body);
      else response.destroy();
    }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 60;
  async function runScheduler() {
    if (closing || schedulerRunning) return;
    schedulerRunning = true;
    try {
      for (const { id } of store.list()) {
        if (closing) break;
        await store.mutate(
          id,
          undefined,
          (project) => {
            const loop = project.loop;
            if (
              !loop.enabled ||
              (loop.lastRunAt &&
                Date.now() - Date.parse(loop.lastRunAt) <
                  loop.intervalMinutes * 60000)
            )
              return { noChange: true };
            try {
              const result = domain.applyAction(
                project,
                "RUN_LOOP",
                {},
                { actor: "scheduler" },
              );
              return { result };
            } catch (error) {
              project.loop.lastRunAt = new Date().toISOString();
              project.loop.lastError =
                error instanceof AppError
                  ? error.message
                  : "자동 연구 계산에 실패했습니다.";
              audit(
                project,
                "SCHEDULER_SKIPPED",
                {
                  code: error instanceof AppError ? error.code : "LOOP_FAILED",
                },
                "scheduler",
              );
              return { result: { skipped: true } };
            }
          },
          { internal: true },
        );
      }
    } finally {
      schedulerRunning = false;
    }
  }
  const timer = scheduler
    ? setInterval(() => {
        runScheduler().catch(() => {});
      }, 60000)
    : null;
  timer?.unref();
  return {
    server,
    store,
    domain,
    runScheduler,
    listen: async () => {
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolveListen();
        });
      });
      return server.address();
    },
    close: async () => {
      closing = true;
      if (timer) clearInterval(timer);
      if (server.listening)
        await new Promise((resolveClose) => server.close(resolveClose));
      await store.close();
      demoAccess.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = await createAppServer({
    dataDir: process.env.EVENT_TWIN_DATA_DIR || resolve(rootDir, "data"),
    port: Number(process.env.PORT || 4180),
  });
  const address = await app.listen();
  console.log(`Event Twin local pilot: http://127.0.0.1:${address.port}`);
  console.log("Local single-owner only. Do not expose this port publicly.");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
