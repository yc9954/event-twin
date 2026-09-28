const issueLabels = {
  NO_SIMULATION: '저장된 실험 결과가 없습니다.',
  INPUT_REVISION_CHANGED: '실험 뒤 공간 또는 입력이 변경되었습니다.',
  ASSUMPTIONS_CHANGED: '실험 뒤 공통 가정이 변경되었습니다.',
  CANDIDATE_RESULT_MISMATCH: '16개 후보와 결과가 일치하지 않습니다.',
  FEASIBILITY_CONTRADICTION: '제약 판정과 저장된 결과가 모순됩니다.',
  RECOMMENDATION_MISMATCH: '저장된 추천안과 제약·순위 계산이 일치하지 않습니다.',
};

export function natAuditView(project, audit, error, loading = false) {
  if (loading) return { status: 'running', title: 'NAT 검수 중', detail: '저장된 실험 결과를 읽어 구조와 제약 판정을 확인하고 있습니다.' };
  if (error) return {
    status: error.status === 409 ? 'stale' : 'unavailable',
    title: error.status === 409 ? '검수 중 프로젝트 변경' : 'NAT 검수 연결 불가',
    detail: error.status === 409 ? '최신 프로젝트를 불러온 뒤 다시 검수하세요.' : 'NeMo Agent Toolkit이 응답하지 않아 검수를 완료하지 못했습니다. 기존 실험 결과는 그대로입니다.',
  };
  if (!audit) return { status: 'idle', title: 'NAT 검수 전', detail: '저장된 16안의 일관성을 아직 확인하지 않았습니다.' };
  if (audit.projectId !== project.id || audit.projectVersion !== project.version || audit.inputRevision !== project.inputRevision)
    return { status: 'stale', title: '이전 리비전 검수', detail: '검수 후 프로젝트가 변경되었습니다. 현재 결과를 다시 검수하세요.' };
  if (audit.status === 'audited') {
    if (audit.candidateCount !== 16 || !Number.isInteger(audit.feasibleCount) || audit.feasibleCount < 0 || audit.feasibleCount > 16)
      return { status: 'invalid', title: '검수 응답 오류', detail: 'NAT가 반환한 16안 집계가 올바르지 않습니다.' };
    return {
      status: 'audited',
      title: 'NAT 저장 결과 검수 완료',
      detail: `제약 통과 ${audit.feasibleCount}/16안 · 추천 ${audit.recommendedId || '없음'}`,
    };
  }
  if (['not_run', 'stale', 'invalid'].includes(audit.status)) {
    const titles = { not_run: '실험 결과 없음', stale: '실험 결과 오래됨', invalid: '저장 결과 검수 실패' };
    return {
      status: audit.status,
      title: titles[audit.status],
      detail: (audit.issueCodes || []).map(code => issueLabels[code] || code).join(' · ') || 'NAT 검수 결과를 확인하세요.',
    };
  }
  return { status: 'invalid', title: '검수 응답 오류', detail: '알 수 없는 NAT 검수 상태입니다.' };
}
