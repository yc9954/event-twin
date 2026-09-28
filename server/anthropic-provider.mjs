import Anthropic from '@anthropic-ai/sdk';
import { AppError } from './store.mjs';

// Native Messages API. Keys, thinking blocks and raw provider errors never
// enter the browser transcript. The existing domain still validates all tools.
export function anthropicInput(input, instructions) {
  const system = [], messages = [];
  const append = (role, blocks) => {
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const item of input) {
    if (item.type === 'function_call') {
      append('assistant', [{ type: 'tool_use', id: item.call_id, name: item.name, input: JSON.parse(item.arguments) }]);
    } else if (item.type === 'function_call_output') {
      append('user', [{ type: 'tool_result', tool_use_id: item.call_id, content: item.output }]);
    } else {
      const parts = Array.isArray(item.content) ? item.content : [{ type: 'text', text: item.content }];
      if (!parts.every(part => ['input_text', 'output_text', 'text'].includes(part.type) && typeof part.text === 'string'))
        throw new AppError('Claude fallback은 현재 텍스트와 도구 결과만 전달합니다.', 400, 'MODEL_IMAGE_UNSUPPORTED');
      if (['system', 'developer'].includes(item.role)) system.push(...parts.map(part => part.text));
      else if (['user', 'assistant'].includes(item.role)) append(item.role, parts.map(part => ({ type: 'text', text: part.text })));
      else throw new AppError('모델 메시지 형식이 올바르지 않습니다.', 400, 'MODEL_INVALID_INPUT');
    }
  }
  return { system: system.join('\n') || instructions || '', messages };
}

export function createAnthropicAdapter({ apiKey, model, client }) {
  const sdk = client || new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com',
    maxRetries: 0, timeout: 60000,
    fetch: (url, init) => globalThis.fetch(url, { ...init, redirect: 'error' }) });
  return async request => {
    const payload = { ...anthropicInput(request.input, request.instructions), model,
      max_tokens: request.max_output_tokens || 3000, thinking: { type: 'disabled' },
      tools: (request.tools || []).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
      tool_choice: request.tool_choice?.type === 'function'
        ? { type: 'tool', name: request.tool_choice.name || request.tool_choice.function?.name }
        : { type: 'auto' } };
    let message;
    if (request.onTextDelta) {
      const stream = sdk.messages.stream(payload, { signal: request.signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
          await request.onTextDelta(event.delta.text);
      }
      message = await stream.finalMessage();
    } else message = await sdk.messages.create(payload, { signal: request.signal });
    if (!Array.isArray(message?.content)) throw new AppError('Claude 응답 형식이 올바르지 않습니다.', 502, 'MODEL_INVALID_RESPONSE');
    return { choices: [{ finish_reason: ({ end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'content_filter' })[message.stop_reason] || 'unknown',
      message: { role: 'assistant', content: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
        tool_calls: message.content.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } })) } }] };
  };
}
