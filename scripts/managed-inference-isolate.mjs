// One synthetic reproduction. No credentials, prompt content or reasoning are logged.
const nativeFetch = globalThis.fetch;
let captured;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://inference.local/v1/chat/completions')) captured = {url, init};
  return nativeFetch(url, init);
};
try { await import('./nvidia-full-cycle.mjs'); }
catch (error) { console.log(JSON.stringify({baselineError:error.message.slice(0,250)})); }
if (captured) {
  const payload = JSON.parse(captured.init.body);
  console.log(JSON.stringify({model:payload.model,toolChoice:payload.tool_choice,maxTokens:payload.max_tokens,
    tools:payload.tools?.map(t=>t.function.name),messages:payload.messages?.map(m=>({role:m.role,length:JSON.stringify(m.content).length})),
    thinking:payload.chat_template_kwargs}));
  for (const [variant, change] of [['identical',{}], ['required',{tool_choice:'required'}], ['auto-longer',{tool_choice:'auto',max_tokens:3000}]]) {
    const response = await nativeFetch(captured.url,{...captured.init,body:JSON.stringify({...payload,...change})});
    const value=await response.json();
    console.log(JSON.stringify({variant,status:response.status,finish:value.choices?.[0]?.finish_reason,
      toolNames:value.choices?.[0]?.message?.tool_calls?.map(t=>t.function.name),usage:value.usage}));
  }
}
