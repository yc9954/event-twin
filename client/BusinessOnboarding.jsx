import React, { useState } from 'react';
import { Box, Check, Sparkles, ArrowUpRight } from 'lucide-react';
import './business-onboarding.css';

export function CreateBusinessForm({ pending, onCreate }) {
  const [template, setTemplate] = useState('demo');
  const [name, setName] = useState('');
  return <form className="create-business-form" onSubmit={e => { e.preventDefault(); onCreate(name.trim() || (template === 'demo' ? '성수 브랜드 체험 매장 · 데모' : '새 오프라인 비즈니스'), template); }}>
    <fieldset disabled={!!pending} className="project-start-options">
      <legend>예시 데모 프로젝트를 불러올까요?</legend>
      <label className={template === 'demo' ? 'selected' : ''}><input type="radio" name="template" value="demo" checked={template === 'demo'} onChange={() => setTemplate('demo')} /><span><strong>예, 준비된 비즈니스로 체험할게요</strong><small>성수 체험 매장 · 공간 24×18m · 방문 1,200명 가정 · 계산된 16안과 지도 분석. 나만의 사본에 저장됩니다.</small></span></label>
      <label className={template === 'blank' ? 'selected' : ''}><input type="radio" name="template" value="blank" checked={template === 'blank'} onChange={() => setTemplate('blank')} /><span><strong>아니오, 내 비즈니스를 직접 입력할게요</strong><small>에이전트 대화에서 공간 구조와 치수부터 정합니다. 기존 프로젝트는 변경하지 않습니다.</small></span></label>
      <label className="field"><span>비즈니스 이름 (선택)</span><input value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder={template === 'demo' ? '성수 브랜드 체험 매장 · 데모' : '예: 성수 라이프스타일 매장'} /></label>
      <p className="help">{template === 'demo' ? '예시 치수와 방문 수는 합성 가정입니다. 계산은 실제 엔진으로 실행하며, CRM은 안을 검토·승인한 후 구축합니다. 실제 고객 데이터는 포함하지 않습니다.' : '첫 대화에서 입력하거나 카드로 선택할 수 있습니다. 공간 확인 전에는 후보를 생성하지 않습니다.'}</p>
      <div className="form-actions"><button className="btn primary" type="submit"><Sparkles size={15} /><span>{pending ? '프로젝트 준비 중…' : template === 'demo' ? '예시 데모로 시작' : '내 비즈니스로 시작'}</span></button></div>
    </fieldset>
  </form>;
}

export function SpaceOnboarding({ project, pending, onSave, onChat, onClose }) {
  const [values, setValues] = useState({ ...project.space });
  const [confirmed, setConfirmed] = useState(false);
  const fields = [['width', '가로 (m)', 8, 100], ['depth', '세로 (m)', 8, 100], ['height', '높이 (m)', 2, 12], ['booths', '체험·서비스 구역 (개)', 1, 12], ['staff', '운영 인력 (명)', 1, 40]];
  return <form className="space-onboarding" aria-label="대화에서 공간 설정" onSubmit={async e => {
    e.preventDefault();
    if (!confirmed) return;
    const payload = { family: values.family, variant: values.variant, confirmed: true };
    for (const [key] of fields) payload[key] = Number(values[key]);
    if (await onSave(payload)) onClose?.();
  }}>
    <div className="onboarding-heading"><Box size={18} /><div><small>FIRST STEP / SPACE CONTEXT</small><h3>{project.space.confirmed ? '공간 조건을 다시 확인할까요?' : '먼저, 어떤 공간에서 운영하나요?'}</h3></div></div>
    <p>아래에서 선택하거나 채팅으로 알려주세요. 입력값을 확인하면 16개 안 비교로 이어집니다.</p>
    <fieldset disabled={!!pending}>
      <label className="field"><span>공간 구조</span><select value={values.family} onChange={e => { setValues(v => ({ ...v, family: e.target.value })); setConfirmed(false); }}><option value="gallery">실내 매장 · 갤러리형</option><option value="courtyard">중정형 · 여러 구역</option><option value="forum">복층형 · 포럼</option><option value="festival">야외형 · 오픈 스페이스</option></select></label>
      <div className="onboarding-fields">{fields.map(([key, label, min, max]) => <label className="field" key={key}><span>{label}</span><input required type="number" min={min} max={max} step={key === 'booths' || key === 'staff' ? 1 : 'any'} value={values[key]} onChange={e => { setValues(v => ({ ...v, [key]: e.target.value })); setConfirmed(false); }} /></label>)}</div>
      <label className="check-row onboarding-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{project.demo?.synthetic ? '합성 예시 조건임을 이해하고 비교 기준으로 사용합니다.' : '치수가 실측·도면의 기준값임을 확인합니다. 기본 예시값과 구분해 주세요.'}</label>
      <div className="onboarding-actions"><button type="button" className="btn quiet" onClick={() => onChat('24×18m 갤러리 높이 3.4m 부스 3개 인력 6명')}><ArrowUpRight size={14} /><span>채팅 입력 예시</span></button><button className="btn primary" disabled={!confirmed}><Check size={14} /><span>공간 확인 · 저장</span></button></div>
    </fieldset>
  </form>;
}
