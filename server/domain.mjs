import { randomUUID } from "node:crypto";
import { AppError } from "./store.mjs";

const uuid = (prefix) => `${prefix}-${randomUUID()}`;
const now = () => new Date().toISOString();
const fail = (message, code = "INVALID_INPUT", status = 400) => {
  throw new AppError(message, status, code);
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const text = (value, label, maximum = 500, required = false) => {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (required && !value.trim())
  )
    fail(`${label}을 확인해 주세요.`);
  return value.trim();
};
const number = (value, label, low, high, integer = false) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < low ||
    value > high ||
    (integer && !Number.isInteger(value))
  )
    fail(
      `${label}: ${low}–${high} 범위의 ${integer ? "정수" : "수"}가 필요합니다.`,
    );
  return value;
};
const boolean = (value, label) => {
  if (typeof value !== "boolean")
    fail(`${label}은 true 또는 false여야 합니다.`);
  return value;
};
const allowed = (payload, fields) => {
  if (
    !object(payload) ||
    Object.keys(payload).some((key) => !fields.includes(key))
  )
    fail("지원하지 않는 입력 필드입니다.");
};
export function audit(project, action, detail = {}, actor = "owner") {
  project.audit.push({ id: uuid("AUD"), at: now(), actor, action, detail });
}

export function createProject(name = "새 오프라인 행사") {
  const time = now();
  return {
    id: uuid("EVT"),
    name: text(name, "프로젝트 이름", 120, true),
    version: 1,
    inputRevision: 1,
    createdAt: time,
    updatedAt: time,
    brief: {
      goal: "방문자의 체험 완료와 유효한 동의를 높이는 행사",
      location: "성수동",
      lat: 37.5445,
      lng: 127.052,
    },
    space: {
      width: 24,
      depth: 18,
      height: 3.4,
      family: "gallery",
      variant: 0,
      booths: 3,
      staff: 6,
      confirmed: false,
    },
    assumptions: {
      visitors: 1200,
      durationMinutes: 360,
      serviceMinutes: 4,
      arrivalPeak: 1.5,
      patienceMinutes: 20,
      consentRate: 0.55,
      budget: 60000000,
      minCompletionRate: 40,
      maxWaitMinutes: 12,
      minConsent: 240,
      seed: 42,
      replications: 12,
    },
    candidates: [],
    simulation: null,
    selectedId: null,
    approval: null,
    crm: {
      schema: null,
      deployment: null,
      people: [],
      registrations: [],
      consents: [],
      tasks: [],
      activities: [],
    },
    observations: [],
    research: null,
    loop: {
      enabled: false,
      intervalMinutes: 60,
      lastRunAt: null,
      proposals: [],
    },
    attachments: [],
    messages: [],
    audit: [],
  };
}

const assumptionLimits = {
  visitors: [1, 10000, true],
  durationMinutes: [30, 1440, true],
  serviceMinutes: [0.5, 60],
  arrivalPeak: [0.1, 5],
  patienceMinutes: [1, 180],
  consentRate: [0, 1],
  budget: [1, 10000000000, true],
  minCompletionRate: [0, 100],
  maxWaitMinutes: [0, 180],
  minConsent: [0, 10000, true],
  seed: [0, 2147483647, true],
  replications: [2, 30, true],
};
function validateAssumptions(values) {
  allowed(values, Object.keys(assumptionLimits));
  for (const [key, value] of Object.entries(values))
    number(value, key, ...assumptionLimits[key]);
}
function invalidate(project, reason) {
  project.inputRevision += 1;
  project.candidates = [];
  project.simulation = null;
  project.selectedId = null;
  project.approval = null;
  project.crm.schema = null;
  // Research includes area, budget and experiment assumptions, not just map data.
  // A new input revision must not keep those old numbers looking current.
  project.research = null;
  for (const proposal of project.loop.proposals)
    if (proposal.status === "pending") proposal.status = "stale";
  audit(project, "INPUT_INVALIDATED", {
    reason,
    inputRevision: project.inputRevision,
  });
}
function ensureApproval(project) {
  if (
    !project.approval ||
    project.approval.inputRevision !== project.inputRevision ||
    project.approval.candidateId !== project.selectedId
  )
    fail(
      "현재 입력에 대한 승인된 계획이 필요합니다.",
      "APPROVAL_REQUIRED",
      409,
    );
  return project.approval;
}
function isCurrentDeployment(project) {
  const approval = project.approval;
  const schema = project.crm.schema;
  const deployment = project.crm.deployment;
  return Boolean(
    approval && schema && deployment &&
    approval.inputRevision === project.inputRevision &&
    approval.candidateId === project.selectedId &&
    schema.inputRevision === project.inputRevision &&
    schema.approvalId === approval.id &&
    deployment.inputRevision === project.inputRevision &&
    deployment.approvalId === approval.id &&
    deployment.candidateId === project.selectedId &&
    deployment.schema?.id === schema.id
  );
}
function ensureDeployed(project) {
  if (!project.crm.deployment)
    fail("먼저 CRM을 로컬에 적용해 주세요.", "CRM_REQUIRED", 409);
}
function latestConsent(project, personId) {
  return (
    project.crm.consents.filter((event) => event.personId === personId).at(-1)
      ?.granted === true
  );
}
function recordActivity(project, type, detail) {
  project.crm.activities.push({ id: uuid("ACT"), type, at: now(), ...detail });
}
function addPerson(project, row, sample = false) {
  allowed(row, ["name", "email", "phone", "marketingConsent"]);
  const name = text(row.name, "참가자 이름", 120, true);
  const email = row.email ? text(row.email, "이메일", 254).toLowerCase() : "";
  const phone = row.phone ? text(row.phone, "전화번호", 40) : "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fail("이메일 형식을 확인해 주세요.");
  if (phone && !/^[+()\d\s.-]{5,40}$/.test(phone))
    fail("전화번호 형식을 확인해 주세요.");
  const granted =
    row.marketingConsent === undefined
      ? false
      : boolean(row.marketingConsent, "마케팅 동의");
  const normalizedPhone = phone.replace(/[^\d+]/g, "");
  const duplicate = project.crm.people.find(
    (person) =>
      (email && person.email === email) ||
      (normalizedPhone &&
        person.phone.replace(/[^\d+]/g, "") === normalizedPhone),
  );
  if (duplicate) return { person: duplicate, duplicate: true };
  const person = {
    id: uuid("PER"),
    name,
    email,
    phone,
    sample,
    createdAt: now(),
  };
  const registration = {
    id: uuid("REG"),
    personId: person.id,
    status: "registered",
    zoneId: null,
    deploymentId: project.crm.deployment.id,
    sample,
    createdAt: now(),
    updatedAt: now(),
  };
  project.crm.people.push(person);
  project.crm.registrations.push(registration);
  project.crm.consents.push({
    id: uuid("CON"),
    personId: person.id,
    granted,
    at: now(),
    purpose: "marketing",
    source: sample ? "explicit-sample-import" : "owner-recorded",
    sample,
  });
  recordActivity(project, "person_added", { personId: person.id, sample });
  return { person, registration, duplicate: false };
}

export function createDomain({ generateCandidates, runBatch, analyzeArea }) {
  if (
    ![generateCandidates, runBatch, analyzeArea].every(
      (value) => typeof value === "function",
    )
  )
    throw new Error("Domain engine dependencies are required.");
  function runSimulation(project) {
    if (!project.space.confirmed || project.candidates.length !== 16)
      fail(
        "확인된 공간에서 16개 후보를 먼저 생성해 주세요.",
        "CANDIDATES_REQUIRED",
        409,
      );
    const batch = runBatch(project.candidates, project.assumptions);
    if (
      !object(batch) ||
      !Array.isArray(batch.results) ||
      batch.results.length !== 16
    )
      throw new Error("Simulation engine returned an invalid batch.");
    const candidateIds = new Set(project.candidates.map((candidate) => candidate.id));
    const resultIds = new Set(batch.results.map((result) => result?.candidateId));
    if (
      resultIds.size !== candidateIds.size ||
      [...resultIds].some((id) => !candidateIds.has(id)) ||
      batch.results.some((result) =>
        !object(result) ||
        (result.feasible !== true && result.feasible !== false) ||
        !Array.isArray(result.reasons) ||
        ["completed", "rate", "waitP90", "cost", "consents", "abandoned"].some(
          (key) => !Number.isFinite(result[key]) || result[key] < 0,
        ) ||
        result.rate > 100 || result.completed > project.assumptions.visitors ||
        result.consents > project.assumptions.visitors
      ) ||
      (batch.recommendedId != null &&
        (!candidateIds.has(batch.recommendedId) ||
          !batch.results.find((result) => result.candidateId === batch.recommendedId)?.feasible))
    )
      throw new Error("Simulation engine returned mismatched candidate results.");
    project.simulation = {
      ...batch,
      id: batch.id || uuid("SIM"),
      inputRevision: project.inputRevision,
      createdAt: now(),
      assumptions: structuredClone(project.assumptions),
    };
    project.selectedId = batch.recommendedId || project.candidates[0].id;
    project.approval = null;
    project.crm.schema = null;
    return project.simulation;
  }
  function runLoop(project, actor) {
    ensureDeployed(project);
    const observation = project.observations.at(-1);
    if (
      !observation ||
      observation.completeness < 0.95 ||
      observation.visitors < 30
    )
      fail(
        "개선 연구에는 완전성 95% 이상·방문자 30명 이상의 관측이 필요합니다.",
        "DATA_QUALITY_GATE",
        409,
      );
    if (
      !project.simulation ||
      project.simulation.inputRevision !== project.inputRevision ||
      project.candidates.length !== 16
    )
      fail("현재 입력의 비교 실험이 필요합니다.", "SIMULATION_REQUIRED", 409);
    if (
      project.crm.deployment.inputRevision !== project.inputRevision ||
      observation.inputRevision !== project.inputRevision ||
      project.crm.deployment.candidateId !== project.selectedId ||
      observation.deploymentId !== project.crm.deployment.id ||
      observation.candidateId !== project.crm.deployment.candidateId ||
      Date.parse(observation.windowStart) < Date.parse(project.crm.deployment.appliedAt) ||
      !project.approval ||
      project.approval.inputRevision !== project.inputRevision ||
      project.approval.candidateId !== project.selectedId ||
      project.approval.simulationId !== project.simulation.id ||
      project.crm.deployment.approvalId !== project.approval.id ||
      !project.crm.schema ||
      project.crm.schema.approvalId !== project.approval.id ||
      project.crm.schema.id !== project.crm.deployment.schema.id
    )
      fail(
        "적용된 CRM·관측과 현재 실험 입력이 다릅니다. 현재 적용된 운영안의 새 관측이 필요합니다.",
        "STALE_DEPLOYMENT",
        409,
      );
    const completionRate = (observation.completed / observation.visitors) * 100;
    const waitIssue = observation.waitP90 > project.assumptions.maxWaitMinutes;
    const completionIssue =
      completionRate < project.assumptions.minCompletionRate;
    project.loop.lastRunAt = now();
    project.loop.lastError = null;
    if (!waitIssue && !completionIssue)
      return {
        skipped: true,
        reason:
          "관측 대기·완료율이 설정된 목표 범위입니다. 개선안을 임의로 생성하지 않습니다.",
      };
    const prior = project.loop.proposals.find(
      (proposal) =>
        proposal.observationId === observation.id &&
        proposal.inputRevision === project.inputRevision &&
        proposal.status === "pending",
    );
    if (prior) return { proposal: prior, duplicate: true };
    project.research = {
      ...analyzeArea(project),
      id: uuid("RES"),
      inputRevision: project.inputRevision,
      createdAt: now(),
    };
    const changed = waitIssue
      ? {
          serviceMinutes: Math.max(
            0.5,
            Math.round(project.assumptions.serviceMinutes * 0.85 * 100) / 100,
          ),
        }
      : {
          arrivalPeak: Math.max(
            0.1,
            Math.round(project.assumptions.arrivalPeak * 0.75 * 100) / 100,
          ),
        };
    if (
      Object.entries(changed).every(
        ([key, value]) => project.assumptions[key] === value,
      )
    )
      return {
        skipped: true,
        reason:
          "변경할 매개변수가 허용 하한에 있어 추가 개선 실험을 생성하지 않았습니다.",
      };
    const revisedAssumptions = { ...project.assumptions, ...changed };
    const comparison = runBatch(project.candidates, revisedAssumptions);
    const baseline = project.simulation.results.find(
      (result) => result.candidateId === project.selectedId,
    );
    const alternative = comparison.results.find(
      (result) => result.candidateId === project.selectedId,
    );
    const proposal = {
      id: uuid("PROP"),
      status: "pending",
      createdAt: now(),
      inputRevision: project.inputRevision,
      observationId: observation.id,
      deploymentId: project.crm.deployment.id,
      candidateId: project.selectedId,
      title: waitIssue
        ? "체험 시간 단축 가설 검토"
        : "집중 도착 분산 가설 검토",
      hypothesis: waitIssue
        ? `관측 대기 P90 ${observation.waitP90}분이 목표 ${project.assumptions.maxWaitMinutes}분을 초과했습니다. 안내·운영 절차로 서비스 시간을 15% 줄일 수 있다는 가정을 검토합니다.`
        : `관측 완료율 ${completionRate.toFixed(1)}%가 목표 ${project.assumptions.minCompletionRate}%에 못 미칩니다. 예약 슬롯으로 피크 도착 집중도를 25% 줄일 수 있다는 가정을 검토합니다.`,
      signal: {
        kind: waitIssue ? "wait" : "completion",
        observed: waitIssue ? observation.waitP90 : completionRate,
        target: waitIssue
          ? project.assumptions.maxWaitMinutes
          : project.assumptions.minCompletionRate,
      },
      assumptions: changed,
      baseline: structuredClone(baseline),
      alternative: structuredClone(alternative),
      observation: structuredClone(observation),
      method: comparison.method,
      requiresOwnerApproval: true,
      applied: false,
      calibrated: false,
      note: "관측에서 원인을 확정한 것이 아닌 변경 가정의 계산 실험입니다. 실제 운영 변경·CRM 배포는 별도 승인합니다.",
      actor,
    };
    project.loop.proposals.push(proposal);
    project.crm.tasks.push({
      id: uuid("TASK"),
      title: "개선 연구 제안 검토",
      status: "open",
      proposalId: proposal.id,
      createdAt: now(),
    });
    return { proposal };
  }
  function performAction(
    project,
    type,
    payload = {},
    { actor = "owner" } = {},
  ) {
    if (!object(payload)) fail("payload 객체가 필요합니다.");
    let result;
    switch (type) {
      case "UPDATE_BRIEF": {
        allowed(payload, ["name", "goal", "location", "lat", "lng"]);
        let briefChanged = false;
        if (payload.name !== undefined)
          project.name = text(payload.name, "프로젝트 이름", 120, true);
        for (const key of ["goal", "location"])
          if (payload[key] !== undefined) {
            const value = text(
              payload[key],
              key,
              key === "goal" ? 4000 : 120,
              true,
            );
            if (project.brief[key] !== value) briefChanged = true;
            project.brief[key] = value;
          }
        for (const key of ["lat", "lng"])
          if (payload[key] !== undefined) {
            const value = number(
              payload[key],
              key,
              key === "lat" ? -85 : -180,
              key === "lat" ? 85 : 180,
            );
            if (project.brief[key] !== value) briefChanged = true;
            project.brief[key] = value;
          }
        if (briefChanged) {
          project.research = null;
          invalidate(project, "brief");
        }
        break;
      }
      case "UPDATE_SPACE": {
        allowed(payload, [
          "width",
          "depth",
          "height",
          "family",
          "variant",
          "booths",
          "staff",
          "confirmed",
        ]);
        const next = { ...project.space };
        for (const key of ["width", "depth"])
          if (payload[key] !== undefined)
            next[key] = number(payload[key], key, 8, 100);
        if (payload.height !== undefined)
          next.height = number(payload.height, "height", 2, 12);
        if (payload.booths !== undefined)
          next.booths = number(payload.booths, "booths", 1, 12, true);
        if (payload.staff !== undefined)
          next.staff = number(payload.staff, "staff", 1, 40, true);
        if (payload.variant !== undefined)
          next.variant = number(payload.variant, "variant", 0, 3, true);
        if (payload.family !== undefined) {
          if (
            ![
              "gallery",
              "courtyard",
              "forum",
              "festival",
              "outdoor",
              "atrium",
              "pavilion",
            ].includes(payload.family)
          )
            fail("지원하지 않는 공간 유형입니다.");
          next.family =
            { outdoor: "festival", atrium: "forum", pavilion: "courtyard" }[
              payload.family
            ] || payload.family;
        }
        if (payload.confirmed !== undefined)
          next.confirmed = boolean(payload.confirmed, "치수 확인");
        if (actor !== "owner") next.confirmed = false;
        else if (
          ["width", "depth", "height"].some(
            (key) =>
              payload[key] !== undefined && payload[key] !== project.space[key],
          ) &&
          payload.confirmed !== true
        )
          next.confirmed = false;
        if (JSON.stringify(next) !== JSON.stringify(project.space)) {
          project.space = next;
          invalidate(project, "space");
        }
        break;
      }
      case "UPDATE_ASSUMPTIONS": {
        validateAssumptions(payload);
        const next = { ...project.assumptions, ...payload };
        if (next.minConsent > next.visitors)
          fail("동의 목표는 방문자 수보다 클 수 없습니다.");
        if (JSON.stringify(next) !== JSON.stringify(project.assumptions)) {
          project.assumptions = next;
          invalidate(project, "assumptions");
        }
        break;
      }
      case "GENERATE_CANDIDATES": {
        allowed(payload, []);
        if (!project.space.confirmed)
          fail(
            "실제 공간 치수를 사용자 확인 후 후보를 생성합니다.",
            "DIMENSIONS_UNCONFIRMED",
            409,
          );
        const candidates = generateCandidates(project.space);
        if (
          !Array.isArray(candidates) ||
          candidates.length !== 16 ||
          new Set(candidates.map((candidate) => candidate.id)).size !== 16
        )
          throw new Error("Candidate engine returned invalid candidates.");
        project.candidates = candidates;
        project.simulation = null;
        project.selectedId = null;
        project.approval = null;
        project.crm.schema = null;
        result = { count: candidates.length };
        break;
      }
      case "RUN_SIMULATION":
        allowed(payload, []);
        result = runSimulation(project);
        break;
      case "SELECT_CANDIDATE": {
        allowed(payload, ["candidateId"]);
        if (
          !project.candidates.some(
            (candidate) => candidate.id === payload.candidateId,
          )
        )
          fail("후보를 찾을 수 없습니다.");
        if (project.selectedId !== payload.candidateId) {
          project.selectedId = payload.candidateId;
          project.approval = null;
          project.crm.schema = null;
        }
        break;
      }
      case "APPROVE_PLAN": {
        allowed(payload, ["candidateId"]);
        if (actor !== "owner")
          fail("에이전트는 계획을 승인할 수 없습니다.", "OWNER_REQUIRED", 403);
        if (
          !project.simulation ||
          project.simulation.inputRevision !== project.inputRevision
        )
          fail(
            "현재 입력의 실험이 완료되어야 합니다.",
            "SIMULATION_REQUIRED",
            409,
          );
        const candidate = project.candidates.find(
          (item) => item.id === payload.candidateId,
        );
        const metrics = project.simulation.results.find(
          (item) => item.candidateId === payload.candidateId,
        );
        if (!candidate || !metrics) fail("후보를 찾을 수 없습니다.");
        if (
          !metrics.feasible ||
          metrics.cost > project.assumptions.budget ||
          metrics.rate < project.assumptions.minCompletionRate ||
          metrics.waitP90 > project.assumptions.maxWaitMinutes ||
          metrics.consents < project.assumptions.minConsent
        )
          fail(
            "모든 제약을 통과한 후보만 승인할 수 있습니다.",
            "CONSTRAINT_FAILED",
            409,
          );
        project.selectedId = candidate.id;
        project.approval = {
          id: uuid("APP"),
          candidateId: candidate.id,
          inputRevision: project.inputRevision,
          simulationId: project.simulation.id,
          approvedAt: now(),
          candidate: structuredClone(candidate),
          metrics: structuredClone(metrics),
          assumptions: structuredClone(project.assumptions),
          research:
            project.research?.inputRevision === project.inputRevision
              ? structuredClone(project.research)
              : null,
        };
        project.crm.schema = null;
        result = project.approval;
        break;
      }
      case "BUILD_CRM": {
        allowed(payload, []);
        const approval = ensureApproval(project),
          candidate = approval.candidate;
        const geometry = approval.metrics.geometry;
        if (
          !geometry ||
          !Array.isArray(geometry.zoneCapacities) ||
          geometry.zoneCapacities.length !== candidate.booths ||
          !Number.isInteger(geometry.checkInStaff) ||
          !Number.isInteger(geometry.serviceStaff) ||
          geometry.checkInStaff + geometry.serviceStaff !== candidate.staff ||
          geometry.zoneCapacities.some(
            (zone) => !Number.isInteger(zone.capacity) || zone.capacity < 0,
          )
        )
          fail(
            "승인된 실험의 구역별 처리 용량·인력 정보가 필요합니다. 실험을 다시 실행해 주세요.",
            "CAPACITY_REQUIRED",
            409,
          );
        const zones = geometry.zoneCapacities.map((zone, index) => ({
          id: `${candidate.id}-ZONE-${zone.zone}`,
          name: `체험 ${zone.zone}`,
          sceneNodeId: `${candidate.id}-booth-${zone.zone}`,
          capacity: zone.capacity,
          staff:
            Math.floor(geometry.serviceStaff / candidate.booths) +
            (index < geometry.serviceStaff % candidate.booths ? 1 : 0),
        }));
        const slots = [];
        const slotDuration = approval.assumptions.serviceMinutes;
        const slotCount = Math.floor(
          approval.assumptions.durationMinutes / slotDuration,
        );
        for (const zone of zones)
          if (zone.capacity > 0)
            for (let index = 0; index < slotCount; index++)
              slots.push({
                id: `${zone.id}-SLOT-${index}`,
                zoneId: zone.id,
                startMinute: Number((index * slotDuration).toFixed(6)),
                endMinute: Number(((index + 1) * slotDuration).toFixed(6)),
                capacity: zone.capacity,
              });
        project.crm.schema = {
          id: uuid("SCHEMA"),
          approvalId: approval.id,
          inputRevision: approval.inputRevision,
          candidateId: candidate.id,
          createdAt: now(),
          zones,
          slots,
          staff: candidate.staff,
          checkInStaff: geometry.checkInStaff,
          serviceStaff: geometry.serviceStaff,
          serviceStations: geometry.serviceStations,
          staffAllocationMode: "shared-facilitator-pool",
          slotDurationMinutes: slotDuration,
          capacityBasis:
            "승인 실험의 구역별 동시 처리 용량과 평균 서비스 시간 기준. 예약 가능 용량이며 실제 완료 예측과 같지 않습니다.",
          objects: [
            "Event",
            "Zone",
            "Person",
            "Registration",
            "ConsentEvent",
            "Task",
            "Activity",
            "ExperienceSlot",
          ],
          views: ["등록자", "현장 체크인", "대기", "체험 완료"],
          automation: [
            { trigger: "waiting", action: "internal-task" },
            { trigger: "completed", action: "feedback-draft" },
            { trigger: "marketing", action: "consent-and-owner-gate" },
          ],
        };
        result = project.crm.schema;
        break;
      }
      case "DEPLOY_CRM": {
        allowed(payload, []);
        if (actor !== "owner")
          fail("사용자만 CRM을 적용할 수 있습니다.", "OWNER_REQUIRED", 403);
        const approval = ensureApproval(project),
          schema = project.crm.schema;
        if (
          !schema ||
          schema.approvalId !== approval.id ||
          schema.inputRevision !== project.inputRevision
        )
          fail(
            "현재 승인에서 CRM을 먼저 빌드해 주세요.",
            "SCHEMA_REQUIRED",
            409,
          );
        // An exact retry must not create a new deployment, rebind people,
        // expire proposals or rewrite an audit event.
        if (isCurrentDeployment(project)) return project.crm.deployment;
        const previousDeploymentId = project.crm.deployment?.id;
        project.crm.deployment = {
          id: uuid("CRM"),
          inputRevision: project.inputRevision,
          approvalId: approval.id,
          candidateId: project.selectedId,
          schema: structuredClone(schema),
          appliedAt: now(),
          mode: "local-only",
          externallyDeployed: false,
        };
        // A redeployment changes the active operating schema, not the event's
        // people. Keep their status and consent while rebinding registrations
        // to the current deployment; old candidate zone IDs cannot carry over.
        if (previousDeploymentId) {
          const validZones = new Set(schema.zones.map((zone) => zone.id));
          for (const registration of project.crm.registrations) {
            registration.deploymentId = project.crm.deployment.id;
            if (!validZones.has(registration.zoneId)) registration.zoneId = null;
            registration.updatedAt = now();
          }
          recordActivity(project, "registrations_rebound", {
            previousDeploymentId,
            deploymentId: project.crm.deployment.id,
            count: project.crm.registrations.length,
          });
        }
        for (const proposal of project.loop.proposals)
          if (proposal.status === "pending") {
            proposal.status = "stale";
            proposal.staleReason = "deployment_changed";
          }
        recordActivity(project, "crm_deployed", {
          deploymentId: project.crm.deployment.id,
        });
        result = project.crm.deployment;
        break;
      }
      case "ADD_PERSON":
        ensureDeployed(project);
        result = addPerson(project, payload);
        break;
      case "IMPORT_PEOPLE": {
        allowed(payload, ["rows", "sample"]);
        ensureDeployed(project);
        if (
          !Array.isArray(payload.rows) ||
          payload.rows.length < 1 ||
          payload.rows.length > 500
        )
          fail("1–500명의 참가자 행을 입력해 주세요.");
        if (payload.sample !== undefined) boolean(payload.sample, "sample");
        let added = 0,
          duplicates = 0;
        for (const row of payload.rows) {
          const item = addPerson(project, row, payload.sample === true);
          if (item.duplicate) duplicates++;
          else added++;
        }
        result = { added, duplicates };
        break;
      }
      case "UPDATE_REGISTRATION": {
        allowed(payload, ["registrationId", "status", "zoneId"]);
        ensureDeployed(project);
        const registration = project.crm.registrations.find(
          (item) => item.id === payload.registrationId,
        );
        if (!registration)
          fail("등록 정보를 찾을 수 없습니다.", "NOT_FOUND", 404);
        if (
          ![
            "registered",
            "checked_in",
            "waiting",
            "active",
            "completed",
          ].includes(payload.status)
        )
          fail("등록 상태를 확인해 주세요.");
        if (
          payload.zoneId !== undefined &&
          payload.zoneId !== null &&
          !project.crm.deployment.schema.zones.some(
            (zone) => zone.id === payload.zoneId,
          )
        )
          fail("적용된 CRM의 구역을 선택해 주세요.");
        const changed = registration.status !== payload.status;
        registration.status = payload.status;
        registration.updatedAt = now();
        if (payload.zoneId !== undefined) registration.zoneId = payload.zoneId;
        if (changed) {
          recordActivity(project, "registration_updated", {
            registrationId: registration.id,
            status: registration.status,
            sample: registration.sample,
          });
          const trigger = registration.status;
          if (
            ["waiting", "completed"].includes(trigger) &&
            !project.crm.tasks.some(
              (task) =>
                task.registrationId === registration.id &&
                task.trigger === trigger &&
                task.status === "open",
            )
          )
            project.crm.tasks.push({
              id: uuid("TASK"),
              personId: registration.personId,
              registrationId: registration.id,
              title:
                trigger === "waiting"
                  ? "참가자 대기 확인"
                  : "피드백 요청 초안 검토",
              status: "open",
              kind: "internal-only",
              trigger,
              createdAt: now(),
              sample: registration.sample,
            });
        }
        result = registration;
        break;
      }
      case "SET_CONSENT": {
        allowed(payload, ["personId", "granted"]);
        ensureDeployed(project);
        if (
          !project.crm.people.some((person) => person.id === payload.personId)
        )
          fail("참가자를 찾을 수 없습니다.", "NOT_FOUND", 404);
        boolean(payload.granted, "동의");
        const event = {
          id: uuid("CON"),
          personId: payload.personId,
          granted: payload.granted,
          at: now(),
          purpose: "marketing",
          source: "owner-recorded",
        };
        project.crm.consents.push(event);
        recordActivity(project, "consent_changed", {
          personId: payload.personId,
          granted: payload.granted,
        });
        result = event;
        break;
      }
      case "UPDATE_TASK": {
        allowed(payload, ["taskId", "status"]);
        const task = project.crm.tasks.find(
          (item) => item.id === payload.taskId,
        );
        if (!task) fail("업무를 찾을 수 없습니다.", "NOT_FOUND", 404);
        if (!["open", "done"].includes(payload.status))
          fail("업무 상태가 잘못되었습니다.");
        task.status = payload.status;
        task.updatedAt = now();
        result = task;
        break;
      }
      case "ADD_OBSERVATION": {
        allowed(payload, [
          "visitors",
          "completed",
          "waitP90",
          "consents",
          "cost",
          "completeness",
          "notes",
          "windowStart",
          "windowEnd",
        ]);
        const deployment = project.crm.deployment;
        const observation = {
          id: uuid("OBS"),
          recordedAt: now(),
          source: "owner-entered",
          inputRevision: deployment?.inputRevision ?? null,
          deploymentId: deployment?.id ?? null,
          candidateId: deployment?.candidateId ?? null,
        };
        for (const key of ["visitors", "completed", "consents"])
          observation[key] = number(payload[key], key, 0, 10000000, true);
        if (
          observation.completed > observation.visitors ||
          observation.consents > observation.visitors
        )
          fail("완료·동의 수는 방문 수를 초과할 수 없습니다.");
        observation.waitP90 = number(payload.waitP90, "waitP90", 0, 1440);
        observation.cost = number(payload.cost, "cost", 0, 10000000000, true);
        observation.completeness = number(
          payload.completeness,
          "completeness",
          0,
          1,
        );
        observation.notes = text(payload.notes ?? "", "notes", 4000);
        for (const key of ["windowStart", "windowEnd"]) {
          if (
            typeof payload[key] !== "string" ||
            !Number.isFinite(Date.parse(payload[key]))
          )
            fail("유효한 관측 시작·종료 시간이 필요합니다.");
          observation[key] = new Date(payload[key]).toISOString();
        }
        if (observation.windowEnd <= observation.windowStart)
          fail("종료 시간은 시작 시간 이후여야 합니다.");
        if (Date.parse(observation.windowEnd) > Date.now() + 5 * 60000)
          fail("미래 시점의 관측을 실제 결과로 저장할 수 없습니다.");
        // A historical window may still be recorded, but it cannot be
        // attributed to a deployment that did not exist when it began.
        if (
          deployment &&
          Date.parse(observation.windowStart) < Date.parse(deployment.appliedAt)
        ) {
          observation.inputRevision = null;
          observation.deploymentId = null;
          observation.candidateId = null;
        }
        project.observations.push(observation);
        for (const proposal of project.loop.proposals)
          if (proposal.status === "pending") {
            proposal.status = "stale";
            proposal.staleReason = "new_observation";
          }
        result = observation;
        break;
      }
      case "RUN_RESEARCH":
        allowed(payload, []);
        project.research = {
          ...analyzeArea(project),
          id: uuid("RES"),
          inputRevision: project.inputRevision,
          createdAt: now(),
        };
        result = project.research;
        break;
      case "RUN_LOOP":
        allowed(payload, []);
        result = runLoop(project, actor);
        break;
      case "SET_LOOP_POLICY": {
        allowed(payload, ["enabled", "intervalMinutes"]);
        if (payload.enabled !== undefined)
          project.loop.enabled = boolean(payload.enabled, "enabled");
        if (payload.intervalMinutes !== undefined)
          project.loop.intervalMinutes = number(
            payload.intervalMinutes,
            "intervalMinutes",
            5,
            1440,
            true,
          );
        if (project.loop.enabled) ensureDeployed(project);
        break;
      }
      case "APPLY_PROPOSAL": {
        allowed(payload, ["proposalId"]);
        if (actor !== "owner")
          fail(
            "개선안 적용에는 사용자의 승인이 필요합니다.",
            "OWNER_REQUIRED",
            403,
          );
        const proposal = project.loop.proposals.find(
          (item) => item.id === payload.proposalId,
        );
        if (
          !proposal ||
          proposal.status !== "pending" ||
          proposal.inputRevision !== project.inputRevision
        )
          fail(
            "현재 입력에 대한 미적용 개선안이 필요합니다.",
            "STALE_PROPOSAL",
            409,
          );
        const deployment = project.crm.deployment;
        if (
          !deployment ||
          deployment.inputRevision !== project.inputRevision ||
          proposal.candidateId !== deployment.candidateId ||
          project.selectedId !== proposal.candidateId ||
          (proposal.deploymentId ?? proposal.observation?.deploymentId) !==
            deployment.id ||
          proposal.observation?.deploymentId !== deployment.id ||
          proposal.observation?.candidateId !== deployment.candidateId ||
          proposal.observation?.inputRevision !== project.inputRevision ||
          proposal.observationId !== project.observations.at(-1)?.id ||
          !project.approval ||
          project.approval.id !== deployment.approvalId ||
          project.approval.simulationId !== project.simulation?.id ||
          !project.crm.schema ||
          project.crm.schema.id !== deployment.schema.id ||
          project.crm.schema.approvalId !== project.approval.id
        )
          fail(
            "현재 적용된 CRM과 같은 운영안·관측에서 만든 제안만 채택할 수 있습니다. 현재 배포의 관측으로 다시 연구해 주세요.",
            "STALE_PROPOSAL",
            409,
          );
        validateAssumptions(proposal.assumptions);
        proposal.status = "applied";
        proposal.applied = true;
        proposal.appliedAt = now();
        project.assumptions = {
          ...project.assumptions,
          ...proposal.assumptions,
        };
        invalidate(project, "proposal");
        result = proposal;
        break;
      }
      default:
        fail("지원하지 않는 작업입니다.", "UNKNOWN_ACTION");
    }
    audit(project, type, { inputRevision: project.inputRevision }, actor);
    return result ?? { ok: true };
  }
  function applyAction(project, type, payload = {}, options = {}) {
    const draft = structuredClone(project);
    const result = performAction(draft, type, payload, options);
    Object.assign(project, draft);
    return result;
  }
  const agentActions = new Set([
    "UPDATE_BRIEF",
    "UPDATE_SPACE",
    "UPDATE_ASSUMPTIONS",
    "GENERATE_CANDIDATES",
    "RUN_SIMULATION",
    "SELECT_CANDIDATE",
    "BUILD_CRM",
    "RUN_RESEARCH",
    "RUN_LOOP",
  ]);
  function context(project) {
    const observations = project.observations
      .slice(-20)
      .map(({ notes, ...observation }) => observation);
    const loop = {
      ...project.loop,
      proposals: project.loop.proposals.map(({ observation, ...proposal }) => ({
        ...proposal,
        observation: observation
          ? Object.fromEntries(
              Object.entries(observation).filter(([key]) => key !== "notes"),
            )
          : null,
      })),
    };
    return {
      id: project.id,
      name: project.name,
      version: project.version,
      inputRevision: project.inputRevision,
      brief: project.brief,
      space: project.space,
      assumptions: project.assumptions,
      candidates: project.candidates,
      simulation: project.simulation,
      selectedId: project.selectedId,
      approval: project.approval,
      research: project.research,
      observations,
      crm: {
        schema: project.crm.schema,
        deployment: project.crm.deployment,
        people: Array.from({ length: project.crm.people.length }, () => ({})),
        peopleCount: project.crm.people.length,
        registrations: [],
        tasks: [],
        registrationCounts: Object.fromEntries(
          ["registered", "checked_in", "waiting", "active", "completed"].map(
            (status) => [
              status,
              project.crm.registrations.filter((item) => item.status === status)
                .length,
            ],
          ),
        ),
        consentCount: project.crm.people.filter((person) =>
          latestConsent(project, person.id),
        ).length,
        taskCount: project.crm.tasks.filter((task) => task.status === "open")
          .length,
      },
      loop,
      attachments: project.attachments.map(({ id, mime, name }) => ({
        id,
        mime,
        name,
      })),
      messages: project.messages
        // Local and legacy chat text must not leak via the initial model context
        // or a later get_project tool call. Preserve the opt-in metadata so the
        // agent can enforce the same rule independently at its SDK boundary.
        .filter(
          (message) =>
            typeof message.content === "string" &&
            typeof message.connectionId === "string" &&
            /^model-v1-[0-9a-f]{64}$/.test(message.connectionId) &&
            message.useModel !== false &&
            message.mode !== "local" &&
            ((message.role === "user" && message.useModel === true) ||
              (message.role === "assistant" &&
                ["model", "openai"].includes(message.mode))),
        )
        .slice(-8)
        .map(({ role, content, provider, connectionId }) => ({
          role,
          content,
          ...(provider !== undefined ? { provider } : {}),
          connectionId,
          useModel: true,
          mode: "model",
        })),
    };
  }
  function executeTool(project, name, args = {}) {
    if (!object(args)) fail("도구 인수는 객체여야 합니다.");
    if (name === "review_operations") {
      const snapshot = context(project);
      return {
        crm: snapshot.crm,
        observations: snapshot.observations,
        loop: snapshot.loop,
      };
    }
    const aliases = {
      analyze_area: "RUN_RESEARCH",
      propose_space: "UPDATE_SPACE",
    };
    const normalized = aliases[name] || String(name).toUpperCase();
    if (["GET_PROJECT", "GET_CONTEXT", "GET_STATUS"].includes(normalized))
      return structuredClone(context(project));
    if (!agentActions.has(normalized))
      fail("에이전트에게 허용되지 않은 도구입니다.", "TOOL_FORBIDDEN", 403);
    const clean = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== null),
    );
    if (normalized === "UPDATE_SPACE") clean.confirmed = false;
    return applyAction(project, normalized, clean, { actor: "agent" });
  }
  return { applyAction, executeTool, context, isCurrentDeployment };
}
