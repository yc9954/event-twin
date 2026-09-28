import { agentBlueprint } from '../shared/agent-blueprint.mjs';
import { registerRuntimeContext } from '../vendor/nemoclaw/runtime-context.mjs';
import { runtimeLocation } from './runtime-location.mjs';

// Both web disclosure and model guidance use this state. Never infer sandbox
// readiness from an installed binary, env flag, cloned repository or API key.
export function runtimeDescriptor({ modelConfigured = false, model = 'gpt-6-astra', provider = 'openai', connectionId = null, route = 'direct-server', check = null } = {}) {
  const matched = Boolean(modelConfigured && connectionId && check?.connectionId === connectionId && check?.provider === provider && check?.model === model);
  return {
    name: 'Event Twin Web Runtime',
    mode: runtimeLocation.mode,
    blueprint: { id: agentBlueprint.id, version: agentBlueprint.version },
    upstream: agentBlueprint.upstream,
    contextHook: 'before_prompt_build',
    sandbox: runtimeLocation,
    inference: { provider: ({openai:'OpenAI',nvidia:'NVIDIA hosted NIM',nim:'Self-hosted NVIDIA NIM'})[provider] || provider, model, configured: Boolean(modelConfigured), verified: Boolean(matched && check?.inferenceVerified), toolCallingVerified: Boolean(matched && check?.toolCallingVerified), lastCheck: matched ? check : null, route, requiresOptIn: true },
    policy: agentBlueprint.policy,
    limits: agentBlueprint.limits,
    tools: agentBlueprint.tools.map(({ name, label, access }) => ({ name, label, access })),
  };
}

export function runtimeContext({ useModel = false, modelConfigured = false, provider = 'openai' } = {}) {
  let hook;
  registerRuntimeContext({ on(name, callback) {
    if (name === 'before_prompt_build') hook = callback;
  } }, {
    runtimeName: runtimeLocation.mode,
    sandboxConnected: runtimeLocation.connected,
    runtimePhase: useModel && modelConfigured ? 'consented model request' : 'local tool mode',
    networkLines: [
      'The server sends only explicitly opted-in model requests to the configured provider. You have no arbitrary fetch or browser tool.',
      'The area tool calculates from sourced OSM data: a packaged snapshot or an explicitly refreshed Overpass query. Check collectedAt, provenance and coverage; do not call saved data real-time. It cannot access live footfall, sales, weather or unrestricted web research.',
    ],
    filesystemLines: [
      'You have no shell or raw filesystem tool. Project persistence is mediated by the application and its SQLite store.',
      'Image uploads stay local unless the owner selects them for a model request. CRM contact fields are excluded from tool context.',
    ],
    behaviorLines: [
      `Available tools: ${agentBlueprint.tools.map(tool => tool.name).join(', ')}.`,
      `At most ${agentBlueprint.limits.rounds} model rounds and ${agentBlueprint.limits.toolCalls} tool calls per request.`,
      'Read current project state, select only relevant tools, inspect their results and explain actual outcomes. Do not claim a tool ran without a result.',
      'Only the owner may confirm measured dimensions, approve an operating plan, deploy CRM or apply a proposed change. Navigate the owner to review; never simulate approval.',
      'Tool execution events are observable actions, not a hidden chain of thought. Distinguish local rules, model choices, assumptions and measured evidence.',
      `Configured inference route: ${['openai','nvidia','nim'].includes(provider) ? provider : 'unknown'}. No automatic fallback to another provider or mock responses is allowed.`,
      runtimeLocation.connected
        ? 'This application process runs inside the NemoClaw OpenShell sandbox. Its Linux restrictions were observed at startup. Network access remains subject to the sandbox policy and actual tool results.'
        : 'The NemoClaw context hook is adapted source code. OpenShell isolation, managed inference and host lifecycle are not connected.',
    ],
  });
  return hook().prependSystemContext;
}
