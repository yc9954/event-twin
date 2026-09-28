import OpenAI from "openai";
import { withProviderRetry } from './provider-retry.mjs';
import { AppError } from "./store.mjs";
import { agentBlueprint } from "../shared/agent-blueprint.mjs";
import { createHmac, randomBytes } from "node:crypto";
import { createAnthropicAdapter } from './anthropic-provider.mjs';

// Connection settings only. A configured endpoint is never a verified service.
// Docs: https://docs.api.nvidia.com/nim/reference/llm-apis
// https://docs.nvidia.com/nim/large-language-models/latest/advanced-use-cases/tool-calling-and-mcp.html
const providers = {
  openai: {
    label: "OpenAI",
    modelKey: "OPENAI_MODEL",
    key: "OPENAI_API_KEY",
    base: "https://api.openai.com/v1",
    api: "responses",
  },
  nvidia: {
    label: "NVIDIA Hosted API",
    modelKey: "NVIDIA_MODEL",
    key: "NVIDIA_API_KEY",
    baseKey: "NVIDIA_BASE_URL",
    base: "https://integrate.api.nvidia.com/v1",
    api: "chat-completions",
  },
  nim: {
    label: "Self-hosted NVIDIA NIM",
    modelKey: "NIM_MODEL",
    key: "NIM_API_KEY",
    baseKey: "NIM_BASE_URL",
    api: "chat-completions",
  },
  anthropic: {
    label: 'Claude API', modelKey: 'ANTHROPIC_MODEL', key: 'ANTHROPIC_API_KEY',
    base: 'https://api.anthropic.com/v1', api: 'anthropic-messages',
  },
};
const value = (env, key) =>
  typeof env[key] === "string" ? env[key].trim() : "";

// Public consent identity, not an authentication token. A process-local secret
// keeps even a short optional NIM key from becoming an offline dictionary
// target in the browser-visible ID. Restarting the server renews consent.
const consentSecret = randomBytes(32);
export function modelConnectionId(configuration, credential = "") {
  const { provider, model, baseURL, capabilities = {}, fallback } = configuration;
  return `model-v1-${createHmac("sha256", consentSecret)
    .update(
      JSON.stringify([
        provider,
        model,
        baseURL,
        capabilities.api,
        capabilities.toolCalling === true,
        capabilities.images === true,
        fallback?.connectionId || null,
      ]),
    )
    .update("\0")
    .update(credential)
    .digest("hex")}`;
}
const identified = (configuration, credential = "") => ({
  ...configuration,
  connectionId: modelConnectionId(configuration, credential),
});

export function getModelConfiguration(env = process.env) {
  const primary = primaryConfiguration(env);
  if (!['nvidia', 'nim'].includes(primary.provider) || value(env, 'MODEL_FALLBACK_PROVIDER') !== 'anthropic') return primary;
  const fallback = primaryConfiguration({ ...env, MODEL_PROVIDER: 'anthropic' });
  return identified({ ...primary, fallback }, value(env, providers[primary.provider].key));
}

function primaryConfiguration(env) {
  const requested = value(env, "MODEL_PROVIDER") || "openai";
  const spec = Object.hasOwn(providers, requested)
    ? providers[requested]
    : null;
  if (!spec)
    return identified({
      provider: "invalid",
      label: "Invalid provider",
      model: null,
      baseURL: null,
      configured: false,
      missing: ["MODEL_PROVIDER"],
      supportsImages: false,
      capabilities: { api: null, toolCalling: false, images: false },
      verified: false,
      configurationError:
        "MODEL_PROVIDER는 openai, nvidia, nim, anthropic 중 하나여야 합니다.",
    });
  const missing = [];
  let model =
    value(env, spec.modelKey) || (requested === "openai" ? "gpt-6-astra" : requested === 'anthropic' ? 'claude-sonnet-4-6' : "");
  let baseURL = (spec.baseKey && value(env, spec.baseKey)) || spec.base || "";
  let configurationError = null;
  if (!model) missing.push(spec.modelKey);
  else if (model.length > 200 || /[\s\x00-\x1f]/.test(model)) {
    model = null;
    configurationError = `${spec.modelKey}에 유효한 모델 ID를 설정해주세요.`;
  }
  if (!baseURL) missing.push(spec.baseKey);
  else {
    try {
      const url = new URL(baseURL);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
        url.hostname,
      );
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (requested === "nim" && url.protocol === "http:" && loopback)
        ) ||
        !url.pathname.replace(/\/$/, "").endsWith("/v1")
      )
        throw new Error();
      baseURL = url.href.replace(/\/$/, "");
    } catch {
      baseURL = null;
      configurationError = `${spec.baseKey || "OPENAI_BASE_URL"}: 인증정보·쿼리 없는 HTTPS /v1 URL이 필요합니다. NIM의 HTTP는 localhost만 허용합니다.`;
    }
  }
  const credential = value(env, spec.key);
  if (requested !== "nim" && !credential) missing.push(spec.key);
  if (!configurationError && missing.length)
    configurationError = `모델 연결 설정이 필요합니다: ${missing.join(", ")}`;
  // The app has not verified any NVIDIA/NIM model's image + tool-call support.
  const supportsImages = requested === "openai";
  return identified({
    provider: requested,
    label: spec.label,
    model: model || null,
    baseURL: baseURL || null,
    configured: !configurationError,
    missing,
    supportsImages,
    capabilities: { api: spec.api, toolCalling: true, images: supportsImages },
    configurationError,
    verified: false,
  }, credential);
}

export function assertImageCapability(configuration, imageIds = []) {
  if (imageIds.length && !configuration.supportsImages)
    throw new AppError(
      "선택한 NVIDIA/NIM 연결의 이미지·도구 호출 지원이 검증되지 않았습니다. 사진을 제외하고 요청해주세요.",
      400,
      "MODEL_IMAGE_UNSUPPORTED",
    );
}

function malformed() {
  return new AppError(
    "모델의 도구 호출 응답 형식을 확인할 수 없습니다. 작업을 저장하지 않았습니다.",
    502,
    "MODEL_INVALID_RESPONSE",
  );
}

function chatMessages(input) {
  const messages = [];
  for (const item of input) {
    if (item.type === "function_call") {
      let message = messages.at(-1);
      if (!message || message.role !== "assistant") {
        message = { role: "assistant", content: null };
        messages.push(message);
      }
      (message.tool_calls ||= []).push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output,
      });
    } else if (
      ["developer", "system", "user", "assistant"].includes(item.role)
    ) {
      let content = item.content;
      if (Array.isArray(content)) {
        if (
          content.some(
            (part) =>
              !["input_text", "output_text", "text"].includes(part.type),
          )
        )
          throw new AppError(
            "이 모델 연결에는 텍스트만 전송할 수 있습니다.",
            400,
            "MODEL_IMAGE_UNSUPPORTED",
          );
        content = content.map((part) => part.text).join("\n");
      }
      if (typeof content !== "string") throw malformed();
      messages.push({
        role: item.role === "developer" ? "system" : item.role,
        content,
      });
    } else throw malformed();
  }
  return messages;
}

function normalizeChatResponse(response) {
  if (
    !response ||
    !Array.isArray(response.choices) ||
    response.choices.length !== 1
  )
    throw malformed();
  const choice = response.choices[0],
    message = choice.message;
  if (!message || message.role !== "assistant") throw malformed();
  if (choice.finish_reason === "length")
    throw new AppError(
      "모델 응답이 길이 제한으로 중단되었습니다. 요청을 나눠주세요. 작업은 저장되지 않았습니다.",
      502,
      "MODEL_OUTPUT_LIMIT",
    );
  if (choice.finish_reason === "content_filter" || message.refusal)
    throw new AppError(
      "모델이 이 요청의 처리를 거절했습니다. 작업은 저장되지 않았습니다.",
      422,
      "MODEL_REFUSED",
    );
  if (!["stop", "tool_calls"].includes(choice.finish_reason)) throw malformed();
  const calls = message.tool_calls || [];
  if (
    !Array.isArray(calls) ||
    calls.length > agentBlueprint.limits.toolCalls ||
    (choice.finish_reason === "tool_calls" && !calls.length)
  )
    throw malformed();
  const ids = new Set();
  const output = [];
  if (typeof message.content === "string" && message.content)
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message.content }],
    });
  else if (message.content != null && message.content !== "") throw malformed();
  for (const call of calls) {
    if (
      call.type !== "function" ||
      typeof call.id !== "string" ||
      !call.id ||
      call.id.length > 200 ||
      ids.has(call.id) ||
      typeof call.function?.name !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(call.function.name) ||
      typeof call.function.arguments !== "string" ||
      call.function.arguments.length > 20000
    )
      throw malformed();
    ids.add(call.id);
    output.push({
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }
  if (!output.length) throw malformed();
  // Deliberately omit reasoning_content, vendor extensions and raw HTTP metadata.
  return {
    output,
    output_text: typeof message.content === "string" ? message.content : "",
  };
}

// Reassemble only public assistant text and function-call fragments. Provider
// reasoning fields, vendor extensions, and raw chunks never enter the app log.
async function collectChatStream(stream, onTextDelta) {
  if (!stream?.[Symbol.asyncIterator]) return normalizeChatResponse(stream);
  const calls = new Map();
  let content = "", finishReason = null, totalArgumentLength = 0;
  for await (const chunk of stream) {
    for (const choice of chunk?.choices || []) {
      if (choice.index !== 0) continue;
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        if (content.length > 40000) throw malformed();
        await onTextDelta(delta.content);
      }
      for (const part of delta.tool_calls || []) {
        if (!Number.isInteger(part.index) || part.index < 0 || part.index >= agentBlueprint.limits.toolCalls)
          throw malformed();
        const call = calls.get(part.index) || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (part.id) call.id += part.id;
        if (part.type && part.type !== "function") throw malformed();
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) {
          call.function.arguments += part.function.arguments;
          totalArgumentLength += part.function.arguments.length;
          if (totalArgumentLength > 20000 * agentBlueprint.limits.toolCalls) throw malformed();
        }
        calls.set(part.index, call);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  return normalizeChatResponse({ choices: [{ index: 0, finish_reason: finishReason, message: {
    role: "assistant", content: content || null,
    tool_calls: [...calls].sort(([a], [b]) => a - b).map(([, call]) => call),
  } }] });
}

async function collectResponsesStream(stream, onTextDelta) {
  if (!stream?.[Symbol.asyncIterator]) return stream;
  let completed = null;
  for await (const event of stream) {
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string")
      await onTextDelta(event.delta);
    if (event?.type === "response.completed") completed = event.response;
    if (event?.type === "response.failed" || event?.type === "error") throw malformed();
  }
  if (!completed) throw malformed();
  return completed;
}

function safeProviderError(error, label) {
  if (error instanceof AppError) return error;
  const code = error?.code || error?.error?.code;
  if (code === "credit_balance_exhausted" || code === "insufficient_quota")
    return new AppError(
      `${label} API 크레딧 또는 할당량이 부족합니다.`,
      429,
      "MODEL_CREDITS_EXHAUSTED",
    );
  if (error?.status === 429)
    return new AppError(
      `${label} 요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.`,
      429,
      "MODEL_RATE_LIMITED",
    );
  if ([401, 403].includes(error?.status))
    return new AppError(
      `${label} 인증 또는 모델 접근 권한을 확인해주세요.`,
      502,
      "MODEL_AUTH_FAILED",
    );
  return new AppError(
    `${label} 호출에 실패했습니다. 서버 주소·모델 ID·도구 호출 설정을 확인해주세요. 요청을 완료하지 못했습니다.`,
    502,
    "MODEL_REQUEST_FAILED",
  );
}

// The injected client is solely a unit-test seam; HTTP never accepts it from users.
// No constructor, network probe or provider switch happens in the config getter.
function createSingleModelClient({
  env = process.env,
  client,
  anthropicClient,
  sdkFactory = (options) => new OpenAI(options),
} = {}) {
  const configuration = getModelConfiguration(env);
  const onlyMissingTestCredential =
    client &&
    configuration.missing.length > 0 &&
    configuration.missing.every(
      (key) => key === "OPENAI_API_KEY" || key === "NVIDIA_API_KEY",
    );
  if (!configuration.configured && !onlyMissingTestCredential)
    throw new AppError(
      configuration.configurationError,
      503,
      "MODEL_NOT_CONFIGURED",
    );
  // Invalid URLs/models must never be bypassed by credential-only fixture injection.
  if (!configuration.baseURL || !configuration.model)
    throw new AppError(
      configuration.configurationError,
      503,
      "MODEL_NOT_CONFIGURED",
    );
  const spec = providers[configuration.provider];
  const key = value(env, spec.key);
  const options = {
    apiKey: key || "nim-local-no-auth",
    baseURL: configuration.baseURL,
    timeout: configuration.fallback?.configured ? 20000 : 90000,
    maxRetries: 0,
    // Do not inherit OpenAI project/organization credentials for NVIDIA/NIM.
    organization: configuration.provider === "openai" ? undefined : null,
    project: configuration.provider === "openai" ? undefined : null,
    ...(configuration.provider === "nim" && !key
      ? { defaultHeaders: { Authorization: null } }
      : {}),
    fetch: (url, init) => globalThis.fetch(url, { ...init, redirect: "error" }),
  };
  const sdk = configuration.provider === 'anthropic' ? null : client || sdkFactory(options);
  const anthropic = configuration.provider === 'anthropic'
    ? createAnthropicAdapter({ apiKey: key, model: configuration.model, client: anthropicClient }) : null;
  return {
    configuration,
    async createResponse(request) {
      try {
        const { onTextDelta, signal, ...modelRequest } = request;
        if (anthropic) return normalizeChatResponse(await anthropic(request));
        if (configuration.provider === "openai")
          return await collectResponsesStream(await sdk.responses.create({
            ...modelRequest,
            model: configuration.model,
            store: false,
            ...(onTextDelta ? { stream: true } : {}),
          }, { signal }), onTextDelta);
        const messages = chatMessages(request.input);
        // Agent includes its instructions in the initial developer item. Avoid
        // sending them twice, while supporting a standalone connection probe.
        if (
          request.instructions &&
          !messages.some((message) => message.role === "system")
        )
          messages.unshift({ role: "system", content: request.instructions });
        const response = await withProviderRetry(() => sdk.chat.completions.create({
          model: configuration.model,
          messages,
          tools: (request.tools || []).map(
            ({ name, description, parameters }) => ({
              type: "function",
              function: { name, description, parameters },
            }),
          ),
          tool_choice:
            request.tool_choice?.type === "function"
              ? {
                  type: "function",
                  function: {
                    name:
                      request.tool_choice.name ||
                      request.tool_choice.function?.name,
                  },
                }
              : request.tool_choice || "auto",
          stream: Boolean(onTextDelta),
          max_tokens: request.max_output_tokens || 3000,
          // These hosted models otherwise spend the bounded tool-loop output
          // budget on thinking and can truncate before returning a tool/answer.
          // Keep its interactive mode concise; do not send this vendor option
          // to other models or self-hosted NIM deployments.
          ...(configuration.provider === "nvidia" &&
          ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-super-120b-a12b"].includes(configuration.model)
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
        }, { signal: request.signal }), { signal: request.signal });
        return onTextDelta
          ? await collectChatStream(response, onTextDelta)
          : normalizeChatResponse(response);
      } catch (error) {
        throw safeProviderError(error, configuration.label);
      }
    },
  };
}

const fallbackErrors = new Set(['MODEL_REQUEST_FAILED', 'MODEL_AUTH_FAILED', 'MODEL_RATE_LIMITED', 'MODEL_CREDITS_EXHAUSTED', 'MODEL_INVALID_RESPONSE']);

// One request-scoped adapter, not a replay of the agent or its transaction.
// A later round passes its already-completed tool receipts to Claude as-is.
export function createModelClient(options = {}) {
  const env = options.env || process.env;
  const primary = createSingleModelClient(options);
  let active = primary, fallback = null;
  return {
    configuration: primary.configuration,
    get activeConfiguration() { return active.configuration; },
    async createResponse(request) {
      let emitted = false;
      const { onFallback, ...input } = request;
      const wrapped = { ...input, ...(input.onTextDelta ? { onTextDelta: async text => {
        if (text) emitted = true;
        await input.onTextDelta(text);
      } } : {}) };
      try { return await active.createResponse(wrapped); }
      catch (error) {
        if (active !== primary || !primary.configuration.fallback?.configured || emitted || request.signal?.aborted || !fallbackErrors.has(error.code)) throw error;
        fallback ||= createSingleModelClient({ env: { ...env, MODEL_PROVIDER: 'anthropic', MODEL_FALLBACK_PROVIDER: '' }, anthropicClient: options.anthropicClient });
        active = fallback;
        const receipt = { from: primary.configuration.provider, to: 'anthropic', model: active.configuration.model, reason: error.code };
        await onFallback?.(receipt);
        try { return await active.createResponse(wrapped); }
        catch (fallbackError) {
          if (request.signal?.aborted) throw fallbackError;
          throw new AppError(`기본 모델과 Claude fallback 요청을 완료하지 못했습니다. ${fallbackError.message}`, fallbackError.status || 502, 'MODEL_FALLBACK_FAILED');
        }
      }
    },
  };
}
