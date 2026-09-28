# 배포 가이드

## 역할 분리

Vercel은 React 정적 파일과 서버 간 스트리밍 프록시를 담당한다. SQLite와 Node 에이전트, NAT Python 서버는 영속적인 Brev/OpenShell 환경에서 실행한다. SQLite 파일을 Vercel 함수의 임시 파일 시스템에 두지 않는다.

## 로컬

Node.js 22.13 이상인 **22.x**를 사용한다. Node 내장 `node:sqlite`가 필요하다.

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

http://127.0.0.1:4180 에 접속한다. 모델 키가 비어 있어도 명시적 로컬 도구 명령과 시뮬레이션, CRM 흐름을 사용할 수 있다. 자연어 모델 경로는 유효한 제공자·모델·키가 필요하다.

## NVIDIA 실행 경로

- Hosted API: `MODEL_PROVIDER=nvidia`, `NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1`, `NVIDIA_MODEL=<tool-calling model ID>`, `NVIDIA_API_KEY=<local secret>`.
- 기존 OpenShell: `https://inference.local/v1` 관리형 추론을 사용한다. SDK의 inert key는 실제 제공자 키가 아니다. 게이트웨이가 키를 관리한다. OpenShell이 주입한 CA 설정을 유지하고 TLS 검증을 끄지 않는다.
- NIM 자체 서빙: [준비 가이드](../integrations/nvidia/README.md)와 모델별 지원 GPU·약관을 확인한다. 공개 데모는 자체 GPU에 NIM 가중치를 올린 구성이 아니다.

NAT 설치·실행:

```sh
node scripts/nvidia-nat.mjs setup
node scripts/nvidia-nat.mjs check
node scripts/nvidia-nat.mjs serve
```

앱 포트가 4188이면 `EVENT_TWIN_APP_URL=http://127.0.0.1:4188`을 지정한다. NAT는 앱과 같은 신뢰 경계의 loopback에 두고 공개 포트로 노출하지 않는다.

## Brev → Vercel

1. OpenShell 샌드박스 안에 앱 소스를 설치하고 빌드한다. Mac의 `.env`, DB, 고객 자료는 복사하지 않는다.
2. `scripts/nemoclaw-launch.mjs`로 앱과 NAT를 실행한다. `deploy/nemoclaw/*.service`는 기존 sandbox/gateway 이름에 맞게 조정하는 systemd 예시다.
3. 앱은 4188 loopback, 전용 nginx TLS ingress는 4191이다. `event-twin-api.inc`는 요청에 배포 프록시 표식을 강제하고 서버 키 검사를 통과시킨다. 강의 사이트·터미널·OpenClaw 경로를 이 포트에 넣지 않는다.
4. `event-twin-tls.conf`의 전용 TLS 리스너를 Brev TCP forwarding으로 연결한다. 인증서 SAN은 `event-twin.internal`이며 Vercel은 배포 인증서만 명시적으로 신뢰하고 서버 이름을 검증한다. `rejectUnauthorized`를 끄지 않는다. Brev HTTP Secure Link는 서버 요청이 앞단에서 거절될 수 있어 현재 배포는 직접 TLS 전송을 사용한다. **gateway key 검사도 유지**한다.
5. 키 없이 `/event-twin-api/health`가 **401**, 올바른 키로 **200**, `/`가 **404**인지 확인한다.
6. Vercel 환경변수를 서버 비밀값으로 설정한다. `VITE_` 등의 공개 빌드 변수에 넣지 않는다.

| Vercel 변수 | 목적 |
| --- | --- |
| `EVENT_TWIN_BACKEND_URL` | 전용 HTTPS URL. 경로는 `/event-twin-api/`로 끝남 |
| `EVENT_TWIN_BACKEND_CA` | 전용 TLS 서버 인증서의 PEM 공개 인증서. 개인키가 아님 |
| `EVENT_TWIN_GATEWAY_KEY` | 원격 앱과 동일한 32바이트 이상의 무작위 비밀값 |
| `EVENT_TWIN_SESSION_SECRET` | 익명 브라우저 세션 서명. 최소 32자 |
| `EVENT_TWIN_PUBLIC_DEMO` | `true`이면 비밀번호 없는 공개 데모 |
| `EVENT_TWIN_PASSWORD_HASH` | 공개 모드가 아닐 때만 사용하는 오너 비밀번호 해시 |

키 생성 보조: `EVENT_TWIN_BACKEND_URL=<your-url> node scripts/deployment-credentials.mjs`. 파일은 `.deployment/`에 생성되며 Git에서 제외된다. 기존 파일을 덮어쓰지 않는다. `--sync-vercel`은 연결된 Vercel 프로젝트의 production 변수에 최초 추가한다. 변경은 `vercel env update` 후 재배포한다.

TLS 개인키는 서버 파일 권한 `600`으로 보관하고 Vercel·GitHub에 보내지 않는다. 현재 데모 인증서의 유효기간은 발급일로부터 90일이다. 장기 운영 시 만료 전에 새 인증서 배포와 Vercel 신뢰 인증서 갱신·재배포를 수행한다. 브라우저는 이 내부 주소가 아니라 Vercel의 정상 HTTPS 도메인에만 접속한다.

```sh
vercel link
vercel deploy --prod
EVENT_TWIN_PUBLIC_URL=https://your-app.vercel.app node scripts/vercel-smoke.mjs
```

마지막 검사는 **실제 모델 API를 호출**하고 분리된 합성 QA 프로젝트를 만든다. 무료 크레딧·비용·외부 API 제한이 적용될 수 있다. 동의 없이 실제 고객 자료로 실행하지 않는다.

## 공개 데모의 경계

- 로그인 화면은 없다. 초기 요청에서 서명된 HttpOnly·Secure 익명 쿠키를 만들고 프로젝트를 해당 브라우저 세션에 귀속한다.
- 사용자 지시에 따라 자체 일일/방문자별 모델 호출 횟수 제한은 없다. 동시 모델 요청 3개와 최대 20초 FIFO 대기, 모델 실행 기한은 과부하 제어이며 사용량 과금 상한은 아니다.
- NVIDIA 자체 한도와 인스턴스 비용·잔액이 적용된다. 공개 URL의 악의적 사용으로 비용이 발생할 수 있으므로 잔액을 직접 관리하고 심사 종료 후 공개 모드를 끄는 것이 필요하다.
- 쿠키는 8시간 후 만료된다. 계정 복구나 영구 소유권 인증이 아니므로 실제 고객 정보를 저장하지 않는다. 필요한 합성 데모 기록은 내보내기로 보관한다.
- 공개 배포의 이미지 입력은 2.5MB로 제한한다. 모델로 보내려면 별도의 선택·동의가 필요하고 모델이 이미지를 지원해야 한다.
- 로컬 4180/원격 4188은 신뢰된 단일 오너용이다. 이 포트를 직접 인터넷에 노출하지 않는다.

## 백업과 재시작

`data/`에는 프로젝트·대화·첨부 파일을 담은 `event-twin.sqlite`, 공개 세션 귀속을 담은 `demo-access.sqlite`, 지도 캐시가 있다. 앱을 정상 종료한 뒤 전체 디렉터리를 백업하거나 SQLite의 일관된 온라인 백업 절차를 사용한다. 실행 중 DB 본체만 복사하면 WAL 변경이 빠질 수 있다.

기존 OpenShell/강의 인스턴스 전체가 아니라 **Event Twin 전용 서비스만** 재시작한다. 호스트 서비스가 끝나도 sandbox 프로세스가 남을 수 있어 `nemoclaw-stop.mjs`가 해당 앱 런처만 종료한다. 제공자 키·네트워크 정책·강의 에이전트를 재설정하는 배포가 아니다.
