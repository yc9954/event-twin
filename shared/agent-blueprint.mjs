// Event Twin's web blueprint, inspired by NemoClaw's versioned separation of
// runtime, inference and policy. This is NOT an OpenShell deployment manifest.
export const agentBlueprint = Object.freeze({
  id: 'event-twin-web',
  version: '1.0.0',
  upstream: Object.freeze({
    repository: 'https://github.com/NVIDIA/NemoClaw',
    commit: '3c668364eeb9b94dcd2e0a553382aa0e16e3745e',
    module: 'nemoclaw/src/runtime-context.ts',
    license: 'Apache-2.0',
    integration: 'modified-runtime-context-hook',
  }),
  runtime: 'local-direct',
  limits: Object.freeze({ rounds: 6, toolCalls: 16 }),
  tools: Object.freeze([
    { name: 'get_project', label: '프로젝트 맥락', access: 'read', prompt: '현재 프로젝트 상태 조회' },
    { name: 'analyze_area', label: '상권 · 접근성', access: 'write', prompt: '주변 상권 분석해줘' },
    { name: 'propose_space', label: '공간 초안', access: 'write', prompt: '24×18m 갤러리 부스 3개' },
    { name: 'update_assumptions', label: '실험 가정', access: 'write', prompt: null },
    { name: 'generate_candidates', label: '16개 안 생성', access: 'write', prompt: '16개 안 생성해줘' },
    { name: 'run_simulation', label: '비교 시뮬레이션', access: 'write', prompt: '시뮬레이션 실행해줘' },
    { name: 'build_crm', label: 'CRM 초안 구축', access: 'approved-write', prompt: 'CRM 구축해줘' },
    { name: 'review_operations', label: '운영 데이터 검토', access: 'read', prompt: '현장 관측 데이터를 토대로 개선안을 연구해줘.' },
  ].map(Object.freeze)),
  policy: Object.freeze({
    ownerOnly: Object.freeze(['APPROVE_PLAN', 'DEPLOY_CRM', 'APPLY_PROPOSAL']),
    modelRequiresOptIn: true,
    imageRequiresSelection: true,
    arbitraryShell: false,
    arbitraryNetwork: false,
    enforcement: 'application-tool-allowlist-and-domain-validation',
  }),
});
