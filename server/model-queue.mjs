// Throughput protection, not a daily/per-visitor quota. A busy provider gets a
// bounded FIFO queue; admitted requests retain their existing transaction lock.
export function createModelQueue(concurrency=3, waitMs=20_000){
  let active=0;const waiting=[];
  return async operation=>{
    if(active>=concurrency)await new Promise((resolve,reject)=>{
      const item={resolve:()=>{clearTimeout(item.timer);resolve();}};
      item.timer=setTimeout(()=>{const i=waiting.indexOf(item);if(i>=0)waiting.splice(i,1);reject(Object.assign(new Error('모델 요청이 많습니다. 잠시 후 다시 시도해주세요.'),{status:503,code:'MODEL_BUSY'}));},waitMs);
      waiting.push(item);
    });else active++;
    try{return await operation();}finally{const next=waiting.shift();if(next)next.resolve();else active--;}
  };
}
