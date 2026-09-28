import React, { useState } from 'react';
import { api } from './api.js';
import './integration-settings.css';

const labels = {openai:'OpenAI Responses',nvidia:'NVIDIA hosted NIM',nim:'Self-hosted NVIDIA NIM'};
const statuses = {verified:'모델 · 도구 왕복 확인',incomplete:'모델 응답만 확인 · 도구 호출 미확인',failed:'실제 연결 검사 실패','not-configured':'설정 필요'};
export default function IntegrationSettings({health,onHealth}) {
  const [checking,setChecking] = useState(false),[error,setError] = useState(''),[confirmedConnectionId,setConfirmedConnectionId] = useState(null);
  const [natChecking,setNatChecking] = useState(false);
  const provider = health?.provider || {}, receipt = health?.integrationCheck;
  const receiptMatches = !!receipt?.connectionId && receipt.connectionId === provider.connectionId;
  const receiptLabel = !receipt?.connectionId
    ? '최근 검사 기록 · 현재 연결과 동일성 미확인'
    : receiptMatches ? `최근 검사 기록 · ${statuses[receipt.status]||receipt.status}` : '이전 연결 검사 기록 · 현재 설정 재검사 필요';
  const confirmed = !!provider.connectionId && confirmedConnectionId === provider.connectionId;
  async function check() {
    if (!confirmed || checking) return;
    setChecking(true);setError('');
    try { await api.checkIntegration(provider.connectionId); onHealth(await api.health()); }
    catch(e) {
      setError(e.message); setConfirmedConnectionId(null);
      if(e.code==='MODEL_CONNECTION_CHANGED') {
        try { onHealth(await api.health()); } catch { /* Keep the failed check visible if the server is offline. */ }
      }
    }
    finally { setChecking(false); }
  }
  async function checkNat() {
    setNatChecking(true);setError('');
    try { await api.checkNat();onHealth(await api.health()); }
    catch(e) {setError(e.message);}
    finally {setNatChecking(false);}
  }
  return <div className="integration-settings">
    <div className="integration-heading"><span>{labels[provider.provider] || '서버 모델 연결'}</span><strong>{provider.configured ? '설정됨 · 실제 호출은 별도 검증' : '연결 정보 미완성'}</strong></div>
    <dl><div><dt>선택 모델</dt><dd>{provider.model || health?.model || '미지정'}</dd></div><div><dt>프로토콜</dt><dd>{provider.protocol || '미확인'}</dd></div><div><dt>호출 경로</dt><dd>{provider.route || '서버 직접 호출'}</dd></div></dl>
    {!!provider.missing?.length && <p className="integration-warning">필요 설정: {provider.missing.join(', ')}</p>}
    <div className="integration-test"><h3>실제 모델 · 도구 연결 검사</h3><p>임시 프로젝트에서 상태 조회 도구를 호출하고 새 검증 토큰을 되돌려 받습니다. 현재 비즈니스·고객·사진은 보내지 않습니다. 설정된 API의 사용량이 발생할 수 있습니다.</p><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmedConnectionId(e.target.checked ? provider.connectionId : null)} disabled={checking}/> 테스트 요청 전송에 동의합니다</label><button type="button" disabled={!confirmed||checking} onClick={check}>{checking?'실제 응답 확인 중…':'연결 검사 실행'}</button>{error&&<p role="alert">{error}</p>}
    {receipt&&<div className={`integration-receipt ${receiptMatches&&receipt.status==='verified'?'verified':''}`} role="status"><strong>{receiptLabel}</strong><span>검사 대상 {receipt.provider || '미확인'} · {receipt.model || '미확인'}</span><span>{receipt.checkedAt} · {receipt.durationMs}ms</span>{receipt.code&&<code>{receipt.code}</code>}<span>검사 당시 추론 {receipt.inferenceVerified?'확인':'미확인'} / 도구 왕복 {receipt.toolCallingVerified?'확인':'미확인'}</span></div>}</div>
    <div className="integration-test"><h3>NeMo Agent Toolkit · 로컬 도구 서버</h3><p>실제 NAT 워크플로가 앱 상태 조회 도구를 호출합니다. LLM 추론이나 모델 서빙 검사는 아닙니다.</p><button type="button" disabled={natChecking} onClick={checkNat}>{natChecking?'NAT 도구 확인 중…':'NAT 워크플로 확인'}</button>{health?.natCheck&&<div className={`integration-receipt ${health.natCheck.verified?'verified':''}`} role="status"><strong>{health.natCheck.verified?`NAT ${health.natCheck.version} · 도구 왕복 확인`:'NAT 서버 연결 미확인'}</strong><span>{health.natCheck.checkedAt}</span><span>모델 추론 없음 · 읽기 전용</span></div>}</div>
    <section className="integration-notes" aria-label="연결 설정 안내"><h3>NVIDIA 구성 요소별 상태</h3><ul><li>NIM API / 자체 NIM: 선택한 제공자 설정과 위 검사가 기준입니다.</li><li>NeMo Agent Toolkit: 별도 로컬 워크플로 서버입니다. 설치만으로 추론 연결이 검증되지는 않습니다.</li><li>OpenShell: 미연결. 컨텍스트 훅 재사용은 OS 격리와 다릅니다.</li></ul>
    <p>서버의 <code>MODEL_PROVIDER</code>로 <code>openai / nvidia / nim</code>을 선택합니다. NVIDIA는 <code>NVIDIA_API_KEY</code>·<code>NVIDIA_MODEL</code>, 직접 서빙은 <code>NIM_BASE_URL</code>·<code>NIM_MODEL</code>이 필요합니다. 키는 서버 .env에만 보관하고 재시작하세요.</p>
    <p className="help">실패 시 다른 모델이나 가짜 응답으로 전환하지 않습니다. 채팅의 모델 사용과 사진 전송 동의, 오너 승인·CRM 배포 경계는 그대로 유지됩니다.</p>
    </section>
  </div>;
}
