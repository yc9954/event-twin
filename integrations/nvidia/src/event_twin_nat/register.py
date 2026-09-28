"""Real NAT function registration; no language model or mock inference involved.

The input selects an allowlisted read operation, never an arbitrary HTTP URL.
No mutation/approval/deployment route is exposed by this bridge.
"""
import json
import math
import re
from importlib.metadata import version
from urllib.parse import urlsplit

import httpx
from pydantic import Field, field_validator
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig


class EventTwinConfig(FunctionBaseConfig, name="event_twin_readonly"):
    app_base_url: str = "http://127.0.0.1:4180"
    timeout_seconds: float = Field(default=5, ge=0.1, le=15)

    @field_validator("app_base_url")
    @classmethod
    def loopback_only(cls, value):
        parsed = urlsplit(value)
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/") or not parsed.port):
            raise ValueError("app_base_url must be an explicit http://127.0.0.1:PORT origin")
        return value.rstrip("/")


def parse_request(message: str):
    if not isinstance(message, str) or len(message) > 300:
        raise ValueError("Expected health or a bounded JSON read request")
    if message.strip() == "health":
        return "health", "/api/health"
    try:
        request = json.loads(message)
    except (ValueError, TypeError):
        raise ValueError("Use health or a project_summary/experiment_audit JSON read request") from None
    if (not isinstance(request, dict) or set(request) != {"tool", "projectId"}
            or request["tool"] not in ("project_summary", "experiment_audit")
            or not isinstance(request["projectId"], str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", request["projectId"])):
        raise ValueError("Only allowlisted read tools with a valid projectId are allowed")
    return request["tool"], "/api/projects/" + request["projectId"]


def project_summary(data):
    """Structural allowlist: never forward chat, images, contact fields or notes."""
    project = data.get("project", data)
    space = project.get("space", {})
    batch = project.get("simulation") or {}
    crm = project.get("crm") or {}
    numeric = lambda obj, keys: {k: obj[k] for k in keys
                                if isinstance(obj.get(k), (int, float)) and not isinstance(obj[k], bool)}
    return {
        "id": project.get("id"),
        "version": project.get("version"),
        "inputRevision": project.get("inputRevision"),
        "space": numeric(space, ("width", "depth", "height")),
        "candidateCount": len(project.get("candidates") or []),
        "batchId": batch.get("id"),
        "selection": project.get("selectedId"),
        "approvalPresent": bool(project.get("approval")),
        "deploymentPresent": bool(crm.get("deployment")),
        "crmRecordCount": len(crm.get("people") or []),
    }


AUDIT_METHOD = "paired-seeded-discrete-event-v1 (uncalibrated)"
CONSTRAINT_FIELDS = ("budget", "minCompletionRate", "maxWaitMinutes", "minConsent")
REASON_CODES = {
    "공간 내 체험 지점 접근 불가 또는 부스 배치 부족": "GEOMETRY_INACCESSIBLE",
    "체험 운영 인력 부족": "STAFF_CAPACITY",
    "체험 완료 인원 없음": "NO_COMPLETIONS",
    "예산 초과": "BUDGET_EXCEEDED",
    "완료율 목표 미달": "COMPLETION_BELOW_MINIMUM",
    "P90 대기 한도 초과": "WAIT_ABOVE_MAXIMUM",
    "명시 동의 목표 미달": "CONSENT_BELOW_MINIMUM",
}


def _finite_number(value, *, nonnegative=True):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and (not nonnegative or value >= 0))


def experiment_audit(data):
    """Audit stored outcomes, never rerun the simulation or make a forecast.

    Only numeric scenario outputs and fixed reason codes leave this boundary.
    Candidate names, CRM records, chat, photos, notes and sample trajectories do not.
    """
    project = data.get("project", data)
    if (not isinstance(project, dict) or not isinstance(project.get("id"), str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", project["id"])):
        raise ValueError("Invalid project response")
    if (not isinstance(project.get("version"), int)
            or isinstance(project["version"], bool)
            or not isinstance(project.get("inputRevision"), int)
            or isinstance(project["inputRevision"], bool)):
        raise ValueError("Invalid project revision")
    base = {
        "projectId": project["id"],
        "projectVersion": project.get("version"),
        "inputRevision": project.get("inputRevision"),
    }
    batch = project.get("simulation")
    if batch is None:
        return {**base, "status": "not_run", "issueCodes": ["NO_SIMULATION"]}
    if not isinstance(batch, dict):
        return {**base, "status": "invalid", "issueCodes": ["MALFORMED_SIMULATION"]}
    if batch.get("inputRevision") != project.get("inputRevision"):
        return {**base, "status": "stale", "issueCodes": ["INPUT_REVISION_CHANGED"]}

    candidates, results = project.get("candidates"), batch.get("results")
    assumptions = batch.get("assumptions")
    if (not isinstance(candidates, list) or not isinstance(results, list)
            or len(candidates) != 16 or len(results) != 16
            or not isinstance(assumptions, dict)
            or batch.get("method") != AUDIT_METHOD
            or (not isinstance(batch.get("policy"), dict)
                or batch["policy"].get("calibration") != "uncalibrated")
            or batch.get("pairedSamples") is not True
            or not isinstance(batch.get("replications"), int)
            or isinstance(batch["replications"], bool)
            or not 2 <= batch["replications"] <= 40
            or not isinstance(batch.get("seed"), int)
            or isinstance(batch["seed"], bool)
            or not all(_finite_number(assumptions.get(key)) for key in CONSTRAINT_FIELDS)
            or assumptions.get("seed") != batch.get("seed")
            or assumptions.get("replications") != batch.get("replications")):
        return {**base, "status": "invalid", "issueCodes": ["UNSUPPORTED_OR_MALFORMED_BATCH"]}
    current_assumptions = project.get("assumptions")
    if not isinstance(current_assumptions, dict) or any(current_assumptions.get(key) != assumptions[key]
           for key in CONSTRAINT_FIELDS):
        return {**base, "status": "stale", "issueCodes": ["ASSUMPTIONS_CHANGED"]}
    candidate_ids = [candidate.get("id") if isinstance(candidate, dict) else None
                     for candidate in candidates]
    result_ids = [result.get("candidateId") if isinstance(result, dict) else None
                  for result in results]
    if (any(not isinstance(candidate_id, str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", candidate_id)
            for candidate_id in candidate_ids)
            or len(set(candidate_ids)) != 16
            or any(not isinstance(result_id, str) for result_id in result_ids)
            or set(result_ids) != set(candidate_ids)):
        return {**base, "status": "invalid", "issueCodes": ["CANDIDATE_RESULT_MISMATCH"]}

    rows = []
    for index, result in enumerate(results):
        if not isinstance(result, dict):
            return {**base, "status": "invalid", "issueCodes": ["MALFORMED_RESULT"]}
        keys = ("completed", "rate", "waitP90", "cost", "consents")
        if (any(not _finite_number(result.get(key)) for key in keys)
                or result["rate"] > 100
                or not isinstance(result.get("feasible"), bool)
                or not isinstance(result.get("reasons"), list)
                or any(not isinstance(reason, str) or reason not in REASON_CODES
                       for reason in result["reasons"])
                or not isinstance(result.get("range"), dict)
                or any(not _finite_number(result["range"].get(key))
                       for key in ("low", "high"))
                or result["range"]["low"] > result["range"]["high"]
                or result["range"]["high"] > 100):
            return {**base, "status": "invalid", "issueCodes": ["MALFORMED_RESULT"]}
        # The simulation already classified feasibility with unrounded replicate
        # means. Do not silently replace that classification using rounded display
        # metrics at a threshold boundary; instead flag clear contradictions.
        visible_failures = [
            result["cost"] > assumptions["budget"],
            result["rate"] + 0.01 < assumptions["minCompletionRate"],
            result["waitP90"] - 0.01 > assumptions["maxWaitMinutes"],
            result["consents"] < assumptions["minConsent"],
        ]
        if (result["feasible"] != (not result["reasons"])
                or (result["feasible"] and any(visible_failures))):
            return {**base, "status": "invalid", "issueCodes": ["FEASIBILITY_CONTRADICTION"]}
        rows.append({
            "candidateId": result["candidateId"],
            "sourcePath": f"simulation.results[{index}]",
            "feasible": result["feasible"],
            "completed": result["completed"],
            "completionRate": result["rate"],
            "waitP90Minutes": result["waitP90"],
            "costKRW": result["cost"],
            "scenarioConsents": result["consents"],
            "completionRateReplicateP10P90": [result["range"]["low"], result["range"]["high"]],
            "reasonCodes": [REASON_CODES[reason] for reason in result["reasons"]],
            "constraintChecks": {
                "budget": not visible_failures[0],
                "completionRate": not visible_failures[1],
                "waitP90": not visible_failures[2],
                "consents": not visible_failures[3],
            },
        })

    ordered = sorted((row for row in rows if row["feasible"]),
                     key=lambda row: (-row["completed"], row["costKRW"],
                                      result_ids.index(row["candidateId"])))
    computed = ordered[0]["candidateId"] if ordered else None
    declared = batch.get("recommendedId")
    if declared != computed:
        return {**base, "status": "invalid", "issueCodes": ["RECOMMENDATION_MISMATCH"]}
    return {
        **base,
        "status": "audited",
        "batchId": batch.get("id") if isinstance(batch.get("id"), str)
                    and re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", batch["id"]) else None,
        "method": AUDIT_METHOD,
        "calibration": "uncalibrated",
        "pairedSamples": True,
        "seed": batch["seed"],
        "replications": batch["replications"],
        "constraints": {key: assumptions[key] for key in CONSTRAINT_FIELDS},
        "candidateCount": 16,
        "feasibleCount": len(ordered),
        "rankedFeasibleIds": [row["candidateId"] for row in ordered],
        "recommendedId": computed,
        "selectedId": project.get("selectedId") if project.get("selectedId") in candidate_ids else None,
        "results": rows,
        "evidence": {
            "source": "persisted-local-project-simulation",
            "scope": "structural-consistency-and-stored-constraint-comparison",
            "replicateRangeMeaning": "10th–90th percentile of seeded scenario replications, not a predictive confidence interval",
            "forecastValidated": False,
            "sameSurveyedFixedBuilding": False,
        },
    }


async def inspect_app(config: EventTwinConfig, message: str) -> str:
    tool, path = parse_request(message)
    # Ambient proxies and redirects must not redirect local project data elsewhere.
    async with httpx.AsyncClient(timeout=config.timeout_seconds, trust_env=False,
                                 follow_redirects=False) as client:
        async with client.stream("GET", config.app_base_url + path,
                                 headers={"Accept": "application/json"}) as response:
            if response.status_code != 200:
                raise ValueError(f"App read failed with HTTP {response.status_code}")
            payload = bytearray()
            async for chunk in response.aiter_bytes():
                payload.extend(chunk)
                if len(payload) > 4 * 1024 * 1024:
                    raise ValueError("App response exceeds bridge limit")
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise ValueError("App response must be a JSON object")
    if tool == "health":
        result = {"ok": data.get("ok") is True,
                  "modelConfigured": data.get("modelConfigured") is True}
    elif tool == "project_summary":
        result = project_summary(data)
    else:
        result = experiment_audit(data)
        if result["projectId"] != path.rsplit("/", 1)[-1]:
            raise ValueError("Project ID does not match the requested project")
    return json.dumps({"framework": "nvidia-nat", "version": version("nvidia-nat"),
                       "bridgeVersion": "0.2.0", "tool": tool,
                       "inferencePerformed": False, "readOnly": True, "result": result},
                      ensure_ascii=False, allow_nan=False)


@register_function(config_type=EventTwinConfig)
async def event_twin_readonly(config: EventTwinConfig, builder: Builder):
    async def run(input_message: str) -> str:
        return await inspect_app(config, input_message)
    yield FunctionInfo.from_fn(run, description="Read local Event Twin health, privacy-reduced project summary, or persisted 16-outcome constraint audit. No inference or writes.")
