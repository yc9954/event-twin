# NVIDIA 실행 연결

NVIDIA NeMo Agent Toolkit 1.9.0의 실제 Python 패키지, 등록 함수, `nat run`, `nat serve`를 사용한다. 별도 모델을 흉내 내는 서버는 없다. NAT 연결 범위는 **앱 상태·비식별 구조 요약·저장된 16안 실험 결과 검수의 읽기 전용 HTTP 도구**다. 에이전트의 모델·도구 실행 루프 자체는 Node 서버가 담당하며 NAT 내부에서 실행되는 것은 아니다. 로컬 실행은 일반 프로세스이고, 공개 데모 배포에서는 Node 앱과 NAT를 모두 NemoClaw/OpenShell 샌드박스 안에 실행한다. [배포 가이드](../../docs/DEPLOYMENT.md)를 참고한다.

NVIDIA 키와 GPU 서버 주소는 `.env.example`에서 의도적으로 비워 두었다. 이 디렉터리의 `.env`를 실행 스크립트가 자동으로 읽지는 않는다. 필요한 값만 실행 환경에 설정한다. 키를 출력하거나 커밋하지 않는다.

## 로컬 실행

다음 명령은 저장소 루트에서 실행한다. Python 3.11–3.13과 `uv`가 필요하다. 의존성은 `integrations/nvidia/.venv`에만 설치되고 `uv.lock`으로 고정된다.

```sh
node scripts/nvidia-nat.mjs setup
node scripts/nvidia-nat.mjs check
node scripts/nvidia-nat.mjs run
node scripts/nvidia-nat.mjs serve
```

앱은 먼저 `127.0.0.1:4180`에서 실행한다. 다른 포트라면 `EVENT_TWIN_APP_URL=http://127.0.0.1:PORT`를 설정한다. NAT는 `127.0.0.1:8008`에서 대기한다. 서비스 종료는 실행 터미널의 Ctrl+C. 별도 터미널에서 확인:

```sh
node scripts/nvidia-nat-smoke.mjs
node --test tests/nvidia-readiness.test.mjs
cd integrations/nvidia
NAT_TELEMETRY_ENABLED=false .venv/bin/python -m unittest test_bridge.py -v
```

설치 스크립트는 NAT 사용량 텔레메트리를 끄고, 실행 프로세스에서 OpenAI/NVIDIA/NGC 키를 제거한다. LangChain의 모델 어댑터·Dask·eval·MCP 추가 패키지는 설치하지 않는다. NAT 1.9.0의 기본 도구 및 FastAPI 모듈 import에 필요한 `langchain-core`, `sqlalchemy[asyncio]`만 별도로 고정했다. Dask/eval/MCP 미설치 안내는 이 워크플로우 실행 실패가 아니다. 상위 Authlib의 deprecated API 경고는 남아 있다.

## 앱 서버 통합 계약

`GET http://127.0.0.1:8008/health` → `{"status":"healthy"}`는 실제 NAT 프로세스 상태만 확인한다.

`POST http://127.0.0.1:8008/generate`, `Content-Type: application/json`:

```json
{"input_message":"health"}
```

위 호출은 NAT 함수가 앱 `/api/health`를 실제 GET한다. **앱 `/api/health`에서 이 generate 호출을 다시 수행하면 재귀 호출이 생긴다.** 서버 상태에는 NAT의 `/health`만 사용하고, 실제 도구 검증은 별도 명시적 probe에서 수행한다.

또는 아래 입력으로 기존 프로젝트를 읽는다. 현재 앱 도메인의 `version`, `inputRevision`, `selectedId`, `simulation.id`, `crm.deployment`, `crm.people` 구조와 맞춘 요약만 반환한다. 메시지·이미지·연락처·노트는 반환하지 않는다.

```json
{"input_message":"{\"tool\":\"project_summary\",\"projectId\":\"EVT-existing-id\"}"}
```

저장된 16개 실험 결과에 대한 NAT 검수는 다음과 같다. 앱의 기존 프로젝트 API에서 **실제로 저장된 시뮬레이션 결과**를 읽고, 입력 revision·후보/결과 ID·방법·제약/추천 일관성을 검사한다. 시뮬레이션을 다시 돌리거나 모델을 호출하지 않는다.

```json
{"input_message":"{\"tool\":\"experiment_audit\",\"projectId\":\"EVT-existing-id\"}"}
```

정상 시 `result.status`는 `audited`, `candidateCount`는 16이다. `results`에는 후보 ID와 출처 경로, 완료 인원·완료율·P90 대기·비용·시나리오 동의 수, 제약 판정·고정 사유 코드만 있다. `rankedFeasibleIds`는 **실제로 저장된 적격안**을 완료 인원 내림차순·비용 오름차순으로 순위화한다. 원래 배치의 추천 ID와 다시 계산한 순위가 다르면 `invalid`로 닫는다. 실험이 아직 없으면 `not_run`, 입력이 바뀌면 `stale`, 형식·무결성이 맞지 않으면 `invalid`다. 어떤 상태에서도 임의의 예상 성과를 생성하지 않는다.

`evidence.forecastValidated=false`, `calibration=uncalibrated`, `evidence.sameSurveyedFixedBuilding=false`는 의도적인 한계 표기다. 반복 실행의 10–90 분위 범위는 현실의 예측 신뢰구간이 아니며, 16안의 벽·시설·동선이 달라 같은 실측 건물 내 운영안 비교가 아니다.

Node 서버에서는 `getNatExperimentAudit(projectId)`를 `server/nat-bridge.mjs`에서 import한다. 실제 NAT 프로세스가 `127.0.0.1:8008`에 있어야 하며, 결과는 추가로 형식 검증·비공개 필드 제거 후 반환된다. 프로젝트 ID 이외의 채팅·CRM·이미지 등은 Node→NAT 요청에 담지 않는다. 실패 시 `INVALID_PROJECT_ID`(400) 또는 `NAT_UNAVAILABLE_OR_INVALID`(503) 오류가 발생한다. **이 함수는 읽기만 하므로 실험 생성·승인·CRM 배포·모델 추론을 했다는 증거가 아니다.**

NAT 응답은 `{"value":"<JSON 문자열>"}`이다. `value`를 JSON 파싱하면:

```json
{"framework":"nvidia-nat","version":"1.9.0","bridgeVersion":"0.2.0","tool":"health","inferencePerformed":false,"readOnly":true,"result":{"ok":true,"modelConfigured":false}}
```

`modelConfigured`는 앱의 설정 여부이지 과금·크레딧·추론 성공 증명이 아니다. 이 기능으로 `NVIDIA 추론 연결 완료`를 표시하지 않는다.

브리지의 네트워크 목적지는 명시적 `http://127.0.0.1:PORT` 하나다. 리디렉션과 환경 프록시를 사용하지 않는다. Host/Origin, 요청 크기, 도구와 경로를 제한한다. NAT 요청 4 KiB, 앱 읽기 응답 4 MiB, NAT→Node 응답 16 KiB이며 각 구간에 타임아웃이 있다. 브라우저 교차 출처, WebSocket, NAT의 기타 실행·모니터링 경로는 막았다. 서버 간 호출에서만 사용한다. **현재 앱의 `/api/projects/:id`는 원본 프로젝트 전체를 반환하므로 NAT 프로세스 메모리에서 원본을 읽은 뒤 출력만 비식별화한다.** NAT와 앱을 같은 신뢰 경계의 로컬 단일 사용자 환경에만 띄운다. 외부 배포 전에 전용 최소 데이터 API와 인증이 필요하다. 이 앱 수준 경계는 OpenShell 격리의 대체품이 아니다.

NAT에서 변경 도구를 추가하려면 앱 트랜잭션/CAS/승인 경계와 별도 계약이 필요하다. 열린 앱 트랜잭션 중 NAT가 다시 변경 API를 호출하는 식으로 연결하지 않는다. 현재 구성은 승인·CRM 배포·시뮬레이션 변경을 수행하지 않는다.

## NIM GPU 서빙 준비

```sh
node scripts/nvidia-preflight.mjs
node scripts/nvidia-preflight.mjs --require-nim
```

이 검사는 키 값 없이 존재 여부와 로컬 GPU 호스트 준비 상태만 출력한다. 현재 Mac에는 NVIDIA GPU/컨테이너 런타임이 확인되지 않아 시작이 차단된다. 원격 Docker를 로컬 GPU 검사로 오인하지 않도록 원격 context도 차단한다. 원격 서버를 만들거나 GPU를 결제하지 않는다.

`nim.compose.yml`은 공식 `nvcr.io/nim/nvidia/nemotron-3.5-lightning-30b-a3b:2.0.9-variant` 릴리스 태그로 고정한 준비용 구성이다. digest 고정은 아직 아니다. 모델은 텍스트 전용이며 사진 모델링 입력을 직접 처리하지 않는다. CUDA/NVIDIA 드라이버·GPU별 지원 프로필·메모리를 GPU 호스트에서 확인해야 한다. 드라이버 580+, Docker 24+, NVIDIA Container Toolkit, 지원 Linux/GPU가 필요하다. NGC 키가 선택 사항인 feature-branch 배포이므로 키가 없다는 이유만으로 모든 자체 서빙이 불가능하다고 판단하지 않는다.

사용자가 NGC에서 해당 모델 약관을 직접 확인·수락하고, GPU 호스트에서 이미지를 명시적으로 준비한 뒤에만 `NIM_TERMS_ACCEPTED=yes`를 설정한다. 준비된 GPU 호스트에서:

```sh
NIM_TERMS_ACCEPTED=yes node scripts/nvidia-nim-start.mjs --allow-model-download
```

이 스크립트는 준비 검사가 통과하고 이미지가 이미 있을 때만 시작한다. 자동 이미지 pull, registry login, 서버 생성은 하지 않는다. 첫 시작은 모델 가중치를 크게 다운로드할 수 있으므로 `--allow-model-download`를 별도로 요구한다. 현재 작업에서는 이미지/가중치를 다운로드하거나 NIM을 시작하지 않았다. 컨테이너는 host loopback 8000 포트만 사용한다. 원격 사용 시 공개 무인증 포트 대신 검증된 SSH 터널 또는 인증 TLS 경로를 별도로 구성한다.

실행 후 `/v1/health/ready`, `/v1/models`, `/v1/metadata`와 실제 작은 추론을 별도로 검증해야 성공이다. 모델 프로필별 VRAM, KV cache, 처리량은 preflight 통과만으로 보장되지 않는다.

## NemoClaw / OpenShell

로컬 단독 실행은 수정한 NemoClaw runtime-context 모듈을 사용하며 샌드박스 연결을 별도로 보고한다. 공개 Brev 배포에서는 앱과 NAT가 실제 OpenShell 샌드박스 안에서 실행되고 관리형 Nemotron 추론을 사용한다. [상세 아키텍처](../../docs/ARCHITECTURE.md)를 참고한다. 공식 문서는 Apple Silicon의 Docker Desktop/Colima 경로를 제한적으로 테스트한다고 설명한다. 따라서 “Mac 또는 GPU 부재 때문에 NemoClaw 자체가 불가능”한 것은 아니다. 이 작업은 시스템 설치·온보딩·컨테이너 이미지 pull을 하지 않는다.

## 공식 근거

- [NeMo Agent Toolkit v1.9.0](https://github.com/NVIDIA/NeMo-Agent-Toolkit/tree/v1.9.0) · Apache-2.0, PyPI `nvidia-nat==1.9.0`
- [공식 함수 등록 패턴](https://github.com/NVIDIA/NeMo-Agent-Toolkit/blob/v1.9.0/skills/nat-tools-and-functions/references/tools-and-functions.md)
- [공식 FastAPI serving](https://github.com/NVIDIA/NeMo-Agent-Toolkit/blob/v1.9.0/skills/nat-mcp-and-serving/references/fastapi-frontend.md)
- [Nemotron 3.5 Lightning NIM 배포·제약](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html)
- [NemoClaw 플랫폼 요건](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/prerequisites)
