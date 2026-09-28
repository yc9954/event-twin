export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
function requireLogin(response, value) {
  if(response.status===401&&value?.code==='AUTH_REQUIRED'&&typeof window!=='undefined')window.location.assign('/api/auth');
}

let demoSession;
async function ensureDemoSession(){
  demoSession ||= fetch('/api/demo-session',{credentials:'same-origin'}).then(r=>{if(!r.ok)throw new Error('데모 세션을 시작하지 못했습니다.');}).finally(()=>{demoSession=null;});
  return demoSession;
}
export async function request(path, options = {}, sessionRetry = false) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(
      "서버 응답을 읽지 못했습니다. 연결 상태를 확인해 주세요.",
      response.status,
    );
  }
  if (!response.ok)
    requireLogin(response, value);
  if(response.status===409&&value?.code==='DEMO_SESSION_REQUIRED'&&!sessionRetry){await ensureDemoSession();return request(path,options,true);}
  if (!response.ok)
    throw new ApiError(
      value.error || `요청 실패 (${response.status})`,
      response.status,
      value.code,
    );
  return value;
}

async function streamChat(path, options, onEvent, sessionRetry=false) {
  const events = [];
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
    });
  } catch {
    throw new ApiError(
      "서버에 연결하지 못했습니다. 상태를 새로고침한 뒤 확인해 주세요.",
      0,
      "NETWORK_ERROR",
    );
  }
  // Validation failures before streaming remain ordinary HTTP JSON responses.
  if (
    !/application\/x-ndjson/i.test(response.headers.get("content-type") || "")
  ) {
    let value;
    try {
      value = await response.json();
    } catch {
      throw new ApiError(
        "서버 응답을 읽지 못했습니다.",
        response.status,
        "INVALID_RESPONSE",
      );
    }
    if (!response.ok) requireLogin(response,value);
    if(response.status===409&&value?.code==='DEMO_SESSION_REQUIRED'&&!sessionRetry){await ensureDemoSession();return streamChat(path,options,onEvent,true);}
    if (!response.ok)
      throw new ApiError(
        value.error || "요청에 실패했습니다.",
        response.status,
        value.code,
      );
    return value;
  }
  let buffer = "",
    result,
    terminal = false;
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  const interrupted = () => {
    const error = new ApiError(
      "실행 연결이 끊겼습니다. 서버에서 작업이 계속되었을 수 있으므로 새로고침해 결과를 확인하세요. 자동 재실행하지 않습니다.",
      0,
      "STREAM_INTERRUPTED",
    );
    error.events = events;
    error.committed = null;
    return error;
  };
  if (!reader) throw interrupted();
  function receive(line) {
    if (!line.trim() || terminal) return;
    const event = JSON.parse(line);
    if (!event || typeof event.type !== "string")
      throw new Error("Invalid stream event");
    if (event.type !== "response.delta" && events.length < 66) events.push(event);
    // UI observers are not part of the transaction or transport contract.
    try {
      const notification = onEvent(event);
      notification?.catch?.(() => {});
    } catch {}
    if (event.type === "response.failed") {
      terminal = true;
      const error = new ApiError(
        event.error || "실행에 실패했습니다.",
        event.status || response.status,
        event.code,
      );
      error.events = events;
      error.committed = false;
      error.event = event;
      error.requestId = event.requestId;
      throw error;
    }
    if (event.type === "response.completed") {
      if (
        event.committed !== true ||
        !event.data?.project ||
        !Array.isArray(event.data.steps)
      )
        throw new Error("Invalid completion");
      terminal = true;
      result = event.data;
    }
  }
  try {
    while (!terminal) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        receive(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 1);
      }
      if (done) {
        if (buffer.trim()) receive(buffer);
        break;
      }
    }
    if (!terminal) throw interrupted();
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw interrupted();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const api = {
  checkIntegration: (expectedConnectionId) =>
    request("/api/integrations/check", {
      method: "POST",
      body: JSON.stringify({ confirm: true, expectedConnectionId }),
    }),
  checkNat: () =>
    request("/api/integrations/nat-check", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  refreshMap: (id, values, expectedVersion) =>
    request(`/api/projects/${id}/map-refresh`, {
      method: "POST",
      body: JSON.stringify({ ...values, expectedVersion }),
    }),
  health: () => request("/api/health"),
  projects: () => request("/api/projects"),
  create: (name) =>
    request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  project: (id) => request(`/api/projects/${encodeURIComponent(id)}`),
  natAudit: (id) => request(`/api/projects/${encodeURIComponent(id)}/nat-audit`),
  action: (id, type, payload, expectedVersion) =>
    request(`/api/projects/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ type, payload, expectedVersion }),
    }),
  chat: (
    id,
    message,
    expectedVersion,
    useModel,
    imageIds,
    onEvent,
    expectedConnectionId,
  ) => {
    const path = `/api/projects/${encodeURIComponent(id)}/chat`;
    const options = {
      method: "POST",
      body: JSON.stringify({
        message,
        expectedVersion,
        useModel,
        imageIds,
        expectedConnectionId,
      }),
    };
    return typeof onEvent === "function"
      ? streamChat(path, options, onEvent)
      : request(path, options);
  },
  upload: (id, attachment, expectedVersion) =>
    request(`/api/projects/${encodeURIComponent(id)}/uploads`, {
      method: "POST",
      body: JSON.stringify({ ...attachment, expectedVersion }),
    }),
};

export function parsePeopleCSV(text) {
  const table = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((x) => x.trim())) table.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("CSV의 따옴표가 닫히지 않았습니다.");
  row.push(field);
  if (row.some((x) => x.trim())) table.push(row);
  if (table.length < 2)
    throw new Error("헤더와 참가자 데이터가 있는 CSV를 선택해 주세요.");
  const aliases = {
    name: "name",
    이름: "name",
    email: "email",
    이메일: "email",
    phone: "phone",
    전화번호: "phone",
    marketingconsent: "marketingConsent",
    마케팅동의: "marketingConsent",
  };
  const headers = table.shift().map(
    (x) =>
      aliases[
        x
          .replace(/^\uFEFF/, "")
          .trim()
          .toLowerCase()
      ],
  );
  if (!headers.includes("name"))
    throw new Error("CSV 헤더에 name 또는 이름이 필요합니다.");
  if (table.length > 500)
    throw new Error("한 번에 최대 500명을 가져올 수 있습니다.");
  return table.map((values, i) => {
    const person = { marketingConsent: false };
    headers.forEach((key, j) => {
      if (key)
        person[key] =
          key === "marketingConsent"
            ? ["true", "1", "yes", "동의"].includes(
                (values[j] || "").trim().toLowerCase(),
              )
            : (values[j] || "").trim();
    });
    if (!person.name) throw new Error(`${i + 2}행에 이름이 없습니다.`);
    return person;
  });
}
