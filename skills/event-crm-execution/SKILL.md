---
name: event-crm-execution
description: Translate an owner-approved event option into a local CRM draft while preserving consent and deployment boundaries.
---

# 승인안에서 CRM 구축

현재 입력 리비전의 시뮬레이션과 모든 제약을 통과한 안만 오너가 승인할 수 있다. 에이전트는 승인 도구를 갖지 않는다. 승인 없는 `build_crm` 실패를 우회하거나 승인을 받았다고 추정하지 않는다.

승인 뒤 CRM 빌드는 구역, 체험 회차, 정원, 인력 배분, 등록·체크인 뷰와 내부 태스크 구조를 로컬로 생성한다. 생성된 예약 가능 용량과 실제 완료 예측을 동일하게 설명하지 않는다. 이 단계는 외부 CRM 배포나 고객 메시지 발송이 아니다.

연락처, 개별 등록, 동의 원문은 모델 맥락에 요청하지 않는다. 마케팅 동의를 행사 참가 동의로 추정하지 않는다. CRM 적용과 외부 발송은 오너의 별도 판단이 필요하며, 현재 앱의 적용도 로컬 상태임을 명시한다.
