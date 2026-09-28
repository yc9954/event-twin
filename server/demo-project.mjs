import { audit } from './domain.mjs';

// Public, synthetic template only. Never clone a project from the owner's DB.
export function initializeDemoProject(project, domain) {
  project.demo = { template: 'seongsu-business-v1', synthetic: true, label: '합성 예시 · 실제 사업 실적 아님' };
  project.brief.goal = '브랜드 체험 매장의 방문 완료율을 높이고, 대기 12분 이내·예산 6천만원 안에서 동의 기반 고객 관계를 구축한다.';
  project.space.confirmed = true;
  domain.applyAction(project, 'GENERATE_CANDIDATES', {}, { actor: 'owner' });
  domain.applyAction(project, 'RUN_SIMULATION', {}, { actor: 'owner' });
  domain.applyAction(project, 'RUN_RESEARCH', {}, { actor: 'owner' });
  audit(project, 'DEMO_TEMPLATE_LOADED', { template: project.demo.template, synthetic: true });
  // Selection is a recommendation, not approval. No CRM deployment or people.
  return project;
}
