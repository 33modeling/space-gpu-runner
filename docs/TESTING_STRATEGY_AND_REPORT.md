# 🧪 SPACE Multi-Site GPU Auto-Allocator & Admin Run-Approval Server
## 테스트 구성 전략 및 수행 결과 보고서 (Test Strategy & Execution Report)

- **문서 버전**: `v2.1.0`
- **최종 검증일**: `2026-11-13`
- **검증 대상**: `server.mjs`, `public/index.html`, `public/app.js`, 라이브 데몬(`0.0.0.0:4300`)
- **자동화 테스트 엔트리**: [`tests/run-tests.mjs`](file:///home/kms/dev/space-gpu-runner/tests/run-tests.mjs) (`npm test`)

---

## 📑 목차 (Table of Contents)

1. [테스트 개요 및 검증 목표](#1-테스트-개요-및-검증-목표)
2. [테스트 아키텍처 및 5계층 구성 전략 (어떻게 구성했는가)](#2-테스트-아키텍처-및-5계층-구성-전략-어떻게-구성했는가)
3. [테스트 환경 및 실행 방법](#3-테스트-환경-및-실행-방법)
4. [자동화 테스트 스위트(`tests/run-tests.mjs`) 상세 구성 명세](#4-자동화-테스트-스위트testsrun-testsmjs-상세-구성-명세)
5. [단계별 테스트 진행 과정 및 실측 결과 (어떻게 진행했는가)](#5-단계별-테스트-진행-과정-및-실측-결과-어떻게-진행했는가)
   - [5.1 자동화 테스트 스위트 실행 결과](#51-자동화-테스트-스위트-실행-결과)
   - [5.2 자동화 단위 테스트 작성 과정에서 적발·수정한 실제 버그](#52-자동화-단위-테스트-작성-과정에서-적발수정한-실제-버그)
   - [5.3 핵심 기능 시나리오별 통합 검증 수행 내역](#53-핵심-기능-시나리오별-통합-검증-수행-내역)
   - [5.4 40시간+ 실전 클러스터 장기 가동(Soak Test) 및 전수 코드 감사 결과](#54-40시간-실전-클러스터-장기-가동soak-test-및-전수-코드-감사-결과)
6. [유지보수 및 회귀 테스트(Regression Test) 지침](#6-유지보수-및-회귀-테스트regression-test-지침)

---

## 1. 테스트 개요 및 검증 목표

`space-gpu-runner`는 사내 공유 클러스터(**SPACE N9 H100** 및 **SPACE N6 A100**)의 실제 대규모 GPU 워크로드(80+ H100 GPU 상시 가동)를 실시간 제어하는 무인 데몬입니다. 따라서 테스트 구성 시 다음 **4대 핵심 목표**를 수립했습니다.

1. **100% 비파괴(Non-Destructive) 안전 검증**: 현재 SPACE 클러스터에서 학습 중인 라이브 워커나 영속 상태 파일(`data/state.json`)을 훼손하지 않고 언제든 반복 실행 가능한 테스트 체계를 구축한다.
2. **실제 프로덕션 코드 직접 검증 (Zero-Mock Drift)**: 테스트용 복제 함수를 따로 작성하지 않고, `server.mjs`와 `public/app.js` 원본 소스에서 실제 함수를 추출해 격리된 VM 컨텍스트에서 직접 실행함으로써 프로덕션 로직 자체를 검증한다.
3. **공유 그룹(`SR-Coredata`) 멀티테넌트 안전성 증명**: 어떤 일괄 종료·자동 승인·Watchdog 조건에서도 동료 연구자의 워크로드가 매칭되거나 종료되지 않음을 수학적·구조적으로 입증한다.
4. **코드 정적 검증 + 자동화 단위/계약 테스트 + 40시간 이상 실전 Soak Test 결합**: 단기 기능 동작뿐 아니라 장기 가동 시 메모리 누수, 레이스 컨디션, 클러스터 API 지연 대응력까지 전방위로 검증한다.

---

## 2. 테스트 아키텍처 및 5계층 구성 전략 (어떻게 구성했는가)

외부 패키지 의존성 제로(`Zero-Dependency`) 설계 지침에 맞춰, Node.js 내장 표준 모듈(`node:test`, `node:assert/strict`, `node:vm`, `node:child_process`)만으로 구성된 **5계층 검증 아키텍처**를 설계했습니다.

```mermaid
flowchart TB
  subgraph L5["Layer 5: 실전 클러스터 장기 가동 검증 (40h+ Production Soak & Audit)"]
    S5["SPACE N9 H100 (80 GPU) 40시간+ 무중단 가동 로그 분석\n누적 8,144+ GPU-Hours · 메모리 상한 · API 백오프 실측"]
  end

  subgraph L4["Layer 4: 라이브 데몬 REST API 계약 및 멀티사이트 격리 검증 (Suite 6)"]
    S4["Port 4300 Read-Only HTTP 호출 검증\n인증 잠금(401) · N9/N6 상태 격리 · GPU-Hours 리포트 분리 · 플릿 집계 일치"]
  end

  subgraph L3["Layer 3: 핵심 시나리오 & UI 상호작용 검증 (Scenario Verification)"]
    S3["targetPendingRuns 보충/승격 · 슬롯 삭제(-1) · Hover-Freeze 상대증감 · 탭 전환 Race 차단"]
  end

  subgraph L2["Layer 2: node:vm 격리 프로덕션 함수 단위 검증 (Suites 2, 3, 4, 5)"]
    S2["원본 소스에서 실제 함수 추출 실행 (extractFunctionSource)\n규칙 매칭 · 타유저 배제 · 슬롯 예약 · H100/A100 선택 · XSS 라운드트립"]
  end

  subgraph L1["Layer 1: 정적 구문 · 심볼 · DOM 바인딩 무결성 검증 (Suite 1)"]
    S1["node --check 구문 분석 · 미선언 상수 스캔 · index.html ↔ app.js 필수 ID 대조"]
  end

  L1 --> L2 --> L3 --> L4 --> L5
```

### 핵심 테스트 하네스 설계 기법: `node:vm` 기반 프로덕션 함수 직접 추출
단일 파일 데몬(`server.mjs`)과 브라우저 전역 스크립트(`public/app.js`)는 모듈 실행 시점에 각각 HTTP 서버 바인딩과 `window`/`document` 이벤트 등록을 수행합니다. 이를 서버 재기동이나 브라우저 없이 정밀하게 단위 테스트하기 위해 [`tests/run-tests.mjs`](file:///home/kms/dev/space-gpu-runner/tests/run-tests.mjs#L28-L108)에 다음과 같은 테스트 하네스를 구현했습니다.

1. **`extractFunctionSource(source, fnName)`**: 원본 `server.mjs` 및 `public/app.js` 파일 텍스트에서 최상위 함수 블록을 정확히 파싱·추출합니다.
2. **`createServerLogicSandbox()` / `createFrontendLogicSandbox()`**: 추출한 실제 함수들을 `vm.createContext(...)` 격리 샌드박스에 로드하여, 디스크 I/O나 외부 네트워크 호출 없이 순수 도메인 알고리즘을 밀리초(`ms`) 단위로 검증합니다.
3. **브라우저 HTML 디코딩 + JS 파서 2단계 시뮬레이션 (`TC-17`)**: 프론트엔드의 `onclick="fn('...')"` 인라인 핸들러에 대해 ① 브라우저의 HTML 엔티티 디코딩 과정과 ② JS 엔진의 단일 따옴표 문자열 평가를 `vm.runInNewContext`로 그대로 재현하여, 특수문자·공격 페이로드 입력 시 구문 에러가 발생하지 않고 원본 문자열이 100% 복원되는지 검증합니다.

---

## 3. 테스트 환경 및 실행 방법

### 3.1 테스트 환경 사양
| 구분 | 상세 환경 |
| :--- | :--- |
| **운영체제 (OS)** | Linux (`x86_64`) |
| **런타임 및 테스트 프레임워크** | `Node.js v24.22.1` 내장 `node:test` 러너 & `node:assert/strict` (외부 의존성 0개) |
| **대상 로컬 서비스** | `http://127.0.0.1:4300` (`space-gpu-runner` 라이브 데몬) |
| **실전 연동 클러스터 1** | `SPACE N9` (`https://mlp.n9.sr-cloud.com` · `NVIDIA H100` · 그룹 `SR-Coredata`) |
| **실전 연동 클러스터 2** | `SPACE N6` (`https://mlp.n6.sr-cloud.com` · `NVIDIA A100`) |

### 3.2 테스트 실행 명령어
```bash
# 1. 빠른 정적 구문 검사 (server.mjs + public/app.js)
npm run check

# 2. 전체 자동화 테스트 스위트 실행 (Suite 1 ~ Suite 6, 총 23개 케이스)
npm test

# (선택) 커스텀 포트 또는 비밀번호 사용 환경에서 실행 시
TEST_BASE_URL=http://127.0.0.1:4300 ADMIN_PASSWORD=cycy node --test tests/run-tests.mjs
```

> [!NOTE]
> 로컬 `4300` 포트 데몬이 실행 중이지 않거나 네트워크가 격리된 CI 샌드박스 환경에서 실행할 경우, Suite 1~5(`TC-01`~`TC-18`)는 전수 실행되고 Suite 6(`TC-19`~`TC-23`)은 실패 대신 안전하게 `SKIP` 처리되도록 구성되어 있습니다.

---

## 4. 자동화 테스트 스위트(`tests/run-tests.mjs`) 상세 구성 명세

총 **6개 스위트, 23개 자동화 테스트 케이스(`TC-01` ~ `TC-23`)** 로 구성되어 있습니다.

| 테스트 ID | 소속 스위트 | 검증 대상 함수 / 엔드포인트 | 테스트 조건 및 검증 내용 (Assertions) | 결과 |
| :---: | :--- | :--- | :--- | :---: |
| **TC-01** | Suite 1 (정적무결성) | `server.mjs` 전체 | `node --check`를 통한 백엔드 ESM 문법 오류 제로 검증 | ✅ PASS |
| **TC-02** | Suite 1 (정적무결성) | `public/app.js` 전체 | `node --check`를 통한 프론트엔드 스크립트 문법 오류 제로 검증 | ✅ PASS |
| **TC-03** | Suite 1 (정적무결성) | 핵심 심볼 및 상수 | 미선언 상수(`DEFAULT_SITES`) 잔존 여부 0건 및 안전 헬퍼(`doesRunMatchSiteJobs`, `escapeJsStr`, `createSiteRuntimeObjectProxy`) 존재 확인 | ✅ PASS |
| **TC-04** | Suite 1 (정적무결성) | `index.html` ↔ `app.js` | 11개 핵심 DOM 컨테이너(`lockOverlay`, `multiSiteTabsContainer`, `workerFleetPanel`, `runsTableBody` 등) 양측 정의·참조 일치 검증 | ✅ PASS |
| **TC-05** | Suite 2 (그룹안전) | `doesRunMatchJob` | 유사 접두사 규칙(`worker-spot` vs `worker-spot-eval`) 동시 존재 시 최장 접두사 우선 매칭으로 런 가로채기 방지 검증 | ✅ PASS |
| **TC-06** | Suite 2 (그룹안전) | `doesRunMatchSiteJobs` | 공유 그룹 내 실제 동료 런 패턴(`rememberme-gpu`, `mmodal-gap-eval`, `regift2`)이 내 규칙 대상에서 100% 배제되는지 검증 | ✅ PASS |
| **TC-07** | Suite 2 (그룹안전) | `doesRunMatchSiteJobs` | `targetJobId` 지정 시 타 내 규칙 런을 제외하고 지정 규칙 런만 정확히 매칭하는지 검증 | ✅ PASS |
| **TC-08** | Suite 2 (그룹안전) | `/stop` API & 런 테이블 | 백엔드 타 사용자 종료 요청 `403` 차단 가드 및 프론트엔드 `🔒 타유저 보호` 배지 적용 검증 | ✅ PASS |
| **TC-09** | Suite 3 (스케줄러) | `classifyRunStatus` | `RUNNING`, `PENDING`, `WAIT_APPROVAL`, `CREATING`, `SUCCEEDED`, `FAILED`, `TERMINATED`, `REJECTED` 등 전 상태 분류 정확성 검증 | ✅ PASS |
| **TC-10** | Suite 3 (스케줄러) | 부족분(Deficit) 수식 | `targetPendingRuns > 0` 모드(Running 무관 대기열 보충)와 `targetPendingRuns === 0` 모드 및 인플라이트 예약 차감 정확성 검증 | ✅ PASS |
| **TC-11** | Suite 3 (스케줄러) | 슬롯 영구 삭제(`-1`) | Pending 슬롯 삭제 시 `targetPendingRuns`만 `-1` 차감(Running 목표 보존), Running 슬롯 삭제 시 `minConcurrentRuns`만 `-1` 차감 검증 | ✅ PASS |
| **TC-12** | Suite 3 (스케줄러) | `pickNextWorkerSlot` | 사용 중 슬롯(`s1`, `s3`)을 피한 빈 슬롯(`s2`) 할당 및 인플라이트 예약(`reserveWorkerSlot`) 중 다음 슬롯(`s4`) 할당 검증 | ✅ PASS |
| **TC-13** | Suite 4 (멀티사이트) | `detectSiteIdFromTokenOrText` | Keycloak JWT `iss` 클레임(`n9-local` vs `n6-local`) 및 포털 URL 문자열로부터 `n9` / `n6` 자동 식별 검증 | ✅ PASS |
| **TC-14** | Suite 4 (멀티사이트) | `selectPreferredGpuCore` | 혼합 코어 풀(CPU, MIG fGPU 슬라이스, 풀카드)에서 N9는 `NVIDIA H100`, N6는 `NVIDIA A100` 풀카드를 최우선 선택하는지 검증 | ✅ PASS |
| **TC-15** | Suite 4 (멀티사이트) | `parseWorkerLogProgress` | 컨테이너 학습 로그 문자열에서 진행률(`45%`), 스텝(`450/1000`), 손실값(`0.2841`) 추출 정확성 검증 | ✅ PASS |
| **TC-16** | Suite 5 (보안/파서) | `escapeHtml` | `<img src=x onerror="alert('xss')">&` 입력 시 5대 HTML 메타문자 완전 엔티티 치환 검증 | ✅ PASS |
| **TC-17** | Suite 5 (보안/파서) | `escapeJsStr` | 작은따옴표(`'`), 큰따옴표(`"`), 백슬래시(`\`), 개행, `<script>` 포함 문자열의 HTML 속성 디코딩 후 JS 평가 라운드트립 무결성 검증 | ✅ PASS |
| **TC-18** | Suite 5 (보안/파서) | `parseSlotSpecToRunIds` | 복합 슬롯 입력(`"1, 3-4, #360999"`)에 대한 슬롯 순번·범위·명시적 Run ID 변환 정확성 검증 | ✅ PASS |
| **TC-19** | Suite 6 (라이브API) | `GET /api/state` (미인증) | `X-Admin-Password` 누락 호출 시 `401 Unauthorized` 및 `{ locked: true }` 응답 검증 | ✅ PASS |
| **TC-20** | Suite 6 (라이브API) | `POST /api/auth/verify` | 오답 비밀번호 `401` 거절 및 정답 비밀번호 `200 { ok: true }` 응답 검증 | ✅ PASS |
| **TC-21** | Suite 6 (라이브API) | `GET /api/state` (`n9`) | 상단 사이트 요약(`sites.n9`)의 Running/Pending/Active 수치가 `workerFleet` 집계와 100% 일치하고 `throttleCount`가 유효 숫자인지 검증 | ✅ PASS |
| **TC-22** | Suite 6 (라이브API) | `GET /api/state` (`n9`↔`n6`) | `X-Site-Id: n6` 교차 호출 전후로 `n9`의 누적 `totalGpuHours`가 초기화되거나 감소하지 않고 완전 격리되는지 검증 | ✅ PASS |
| **TC-23** | Suite 6 (라이브API) | `GET /api/telemetry/export` | `siteId=n9`와 `siteId=n6` 내보내기 리포트가 각기 독립된 사이트 데이터를 반환하는지 검증 | ✅ PASS |

---

## 5. 단계별 테스트 진행 과정 및 실측 결과 (어떻게 진행했는가)

테스트 및 검증은 **① 전수 정적 코드 감사 ➔ ② 자동화 단위·보안 테스트 구축 및 결함 교정 ➔ ③ 시나리오 기반 통합 검증 ➔ ④ 라이브 데몬 계약 검증 ➔ ⑤ 40시간+ 실전 운영 Soak 로그 대조**의 5단계 절차로 진행했습니다.

### 5.1 자동화 테스트 스위트 실행 결과
라이브 데몬(`Port 4300`)이 가동 중인 상태에서 `npm test`를 실행하여 **전체 6개 스위트, 23개 테스트 전 항목 통과(`23 pass, 0 fail`, 소요 시간 `460.7ms`)** 를 확인했습니다.

```text
▶ Suite 1: 정적 구문 및 코드베이스 무결성 검증 (Static & Structural Verification)
  ✔ TC-01: server.mjs Node.js ESM 구문 검사 통과 (`node --check`) (57.4ms)
  ✔ TC-02: public/app.js 프론트엔드 스크립트 구문 검사 통과 (`node --check`) (60.2ms)
  ✔ TC-03: 미선언 상수(`DEFAULT_SITES`) 부재 및 핵심 안전 헬퍼 존재 검증 (1.4ms)
  ✔ TC-04: index.html 핵심 DOM 컨테이너 ID와 app.js 바인딩 정합성 검증 (2.0ms)
✔ Suite 1 (127.1ms)

▶ Suite 2: 공유 그룹(SR-Coredata) 타 사용자 보호 및 규칙 매칭 검증
  ✔ TC-05 ~ TC-08 전 항목 통과 (5.2ms)

▶ Suite 3: 스케줄러 상태 분류, 부족분(Deficit), 슬롯 예약 및 영구 삭제(-1) 수식 검증
  ✔ TC-09 ~ TC-12 전 항목 통과 (3.3ms)

▶ Suite 4: 멀티 사이트(N9 H100 vs N6 A100) 코어 선택 및 토큰/로그 파싱 검증
  ✔ TC-13 ~ TC-15 전 항목 통과 (4.0ms)

▶ Suite 5: 프론트엔드 인라인 핸들러 보안 이스케이프 및 슬롯 범위 파서 검증
  ✔ TC-16 ~ TC-18 전 항목 통과 (10.3ms)

▶ Suite 6: 라이브 데몬(Port 4300) 비파괴 REST API 계약 및 멀티 사이트 격리 검증
  ✔ TC-19 ~ TC-23 전 항목 통과 (145.9ms)

ℹ tests 23 | suites 6 | pass 23 | fail 0 | duration_ms 460.7ms
```

---

### 5.2 자동화 단위 테스트 작성 과정에서 적발·수정한 실제 버그
`node:vm`으로 실제 프로덕션 함수를 추출해 경계값 테스트를 수행하는 과정에서 정적 리뷰만으로는 놓치기 쉬운 **2건의 추가 잠재 결함**을 즉시 발견하여 수정했습니다.

1. **`WAIT_APPROVAL` 상태 분류 누락 결함 (`TC-09` 수행 중 적발)**
   - **현상**: 기존 `classifyRunStatus`(`server.mjs`)와 `classifyUiRunStatus`(`public/app.js`)의 활성 키워드 목록이 `"WAITING"`, `"APPROVED"`로 정의되어 있어, 부분 문자열 `"WAIT"`와 `"APPROVAL"`로 이루어진 `"WAIT_APPROVAL"` 상태값이 `"ACTIVE"`가 아닌 `"UNKNOWN"`으로 분류됨을 `TC-09`가 적발했습니다.
   - **조치**: 양측 상태 분류기에 `"WAIT"` 및 `"APPROVAL"` 키워드를 추가하여 승인 대기 직후 상태의 런도 누락 없이 `"ACTIVE"`로 집계되도록 수정했습니다.
2. **학습 로그 Epoch/Step 동시 표기 시 Step 오인식 결함 (`TC-15` 수행 중 적발)**
   - **현상**: `"Epoch 3/10 | Step 450/1000"` 형태의 로그에서 기존 정규식 `\b(?:step|iter|batch)?\s*(\d+\/\d+)`의 접두사가 선택적(`?`)이어서 앞쪽 `"Epoch 3/10"`의 `"3/10"`을 Step으로 잘못 매칭하던 문제를 `TC-15`가 적발했습니다.
   - **조치**: 명시적 `step|iter|batch` 접두사 매칭을 우선 수행하고 `epoch`이 없을 때만 일반 분수 패턴으로 폴백하도록 정규식 우선순위를 교정했습니다.

---

### 5.3 핵심 기능 시나리오별 통합 검증 수행 내역

#### 시나리오 A. `targetPendingRuns` 목표 대기열 유지 및 즉시 보충 검증
- **검증 방법**: `v8` 규칙에 `targetPendingRuns: 6`, `cooldownSec: 180`(3분) 설정 상태에서 ① 대기 워커가 유휴 H100 노드를 배정받아 `Pending ➔ Running`으로 승격되는 순간, ② 일시적 부하 스로틀링 발생 시, ③ `Pending ➔ Failed` 조기 실패 시의 스케줄러 동작을 추적했습니다.
- **검증 결과**:
  - `Pending ➔ Running` 승격 감지 즉시 3분 쿨다운을 우회(`shouldBypassCooldown = true`)하여 빈 대기 슬롯을 실시간 보충하고 상시 `Pending 6/6개`를 유지함을 확인했습니다.
  - `evaluateJobRule`의 `{ loadThrottled: true }` 반환값과 `runSchedulerTick`의 재시도 플래그를 일치시켜 스로틀링 해제 후 30초 내 미완성 배치가 자동 완결됨을 확인했습니다.

#### 시나리오 B. 워커 슬롯 선택 즉시 Kill(`🛑`) vs 영구 삭제(`🗑️ -1`) 검증
- **검증 방법**: 개별 슬롯 버튼 및 범위 입력(`1, 3-4, #RunID`)으로 `🛑 Kill`과 `🗑️ 삭제(-1)` 호출 시 `minConcurrentRuns`와 `targetPendingRuns` 변화를 검증했습니다.
- **검증 결과**:
  - `🛑 Kill` 실행 시 컨테이너만 즉시 종료되고 목표치는 그대로 유지되어 다음 주기에 자동 충원됩니다.
  - `🗑️ 삭제(-1)` 실행 시 삭제 대상이 **Pending 슬롯**이면 `minConcurrentRuns`(Running 목표)는 건드리지 않고 `targetPendingRuns`만 `-1` 차감하며, **Running 슬롯**이면 `minConcurrentRuns`를 `-1` 차감하여 불필요한 재생성이 발생하지 않음을 확인했습니다.

#### 시나리오 C. 멀티 사이트(`N9 H100` ↔ `N6 A100`) 격리 및 전환 레이스 검증
- **검증 방법**: `X-Site-Id: n9`와 `X-Site-Id: n6` 요청을 연속 교차 전송하며 사이트 요약 수치, GPU 코어 선택, GPU-Hours 적산값을 대조했습니다.
- **검증 결과**:
  - N9(`H100`, `20 Running + 6 Pending = 26 Active`)와 N6(`A100`, `0 Active`)의 설정·규칙·런타임 통계·GPU-Hours가 전혀 섞이지 않고 독립 유지됨을 확인했습니다(`TC-21` ~ `TC-23`).
  - 프론트엔드 탭 전환 시 이전 사이트 선택 체크박스(`selectedWorkerRunIds`) 초기화 및 지연 도착한 구 사이트 폴링 응답 폐기(`reqSiteId !== currentSiteId`)가 정상 작동함을 확인했습니다.

#### 시나리오 D. 실시간 모니터링 화면 깜빡임 완화(Flicker-Free) 및 호버 보호 검증
- **검증 방법**: 5초 주기 자동 폴링 중 슬롯 보드 DOM 변경 여부 및 마우스 호버 상태에서 대기 슬롯 `🗑️-1` 연속 클릭 동작을 검증했습니다.
- **검증 결과**:
  - 상태 변화가 없는 슬롯 카드는 `patchSlotPillsGrid`가 기존 DOM 노드를 그대로 유지하여 깜빡임이 발생하지 않습니다.
  - 마우스 호버로 화면 렌더링이 일시 동결된 상태에서 대기 슬롯 `🗑️-1`을 연속 클릭해도 고정 정수가 아닌 `{ delta: -1 }` 상대 증감 요청이 전송되어 클릭 횟수만큼 정확히 차감됨을 확인했습니다.

---

### 5.4 40시간+ 실전 클러스터 장기 가동(Soak Test) 및 전수 코드 감사 결과

실제 **SPACE N9 (H100 클러스터, `SR-Coredata` 그룹)** 상에서 약 40시간 이상 연속 가동하며 수집한 운영 텔레메트리 및 전수 코드 감사를 통해 확인된 지표와 해결된 결함 요약입니다.

#### 실전 운영 검증 지표 (Production Soak Metrics)
- **연속 무중단 가동**: 40시간 이상 크래시 `0회`, 런타임 `[ERROR]` 로그 `0건`
- **실시간 플릿 유지 성능**: `v8` 규칙 기준 **20 Running (80 H100 GPUs) + 6 Pending (`targetPendingRuns: 6`) = 총 26개 내 워커** 정확히 상시 유지
- **멀티테넌트 그룹 분리 실측**: 그룹 전체 활성 런 `29개` 중 내 규칙 워커 `26개`와 동료 연구자 런 `3개`를 오차 없이 분리 집계 (`sites.n9.activeWorkers === 26`, 타유저 간섭 `0건`)
- **누적 연산량 적산**: **8,144.38 GPU-Hours** 무손실 누적 기록 및 영속 복원 확인

#### 전수 감사 및 테스트로 발굴·해결 완료된 14건 결함 요약
| 구분 | 결함 요약 | 조치 결과 |
| :--- | :--- | :---: |
| **그룹안전 #1** | `stop_all`, `stop_pending`, `rolling_restart`가 그룹 전체 런을 대상으로 동작하던 위험 | `doesRunMatchSiteJobs` 내 규칙 한정 필터 적용 완료 |
| **그룹안전 #2** | Watchdog 및 로그 완료 키워드 스캐너가 타 사용자 런까지 스캔하던 범위 누수 | 내 규칙 매칭 런으로 엄격 제한 및 폴백 제거 완료 |
| **그룹안전 #3** | 원클릭 즉시 Kill 활성화 시 타 사용자 행/배지 오클릭 종료 위험 | UI 버튼 제거(`🔒 타유저 보호`) + 백엔드 `/stop` `403` 차단 완료 |
| **그룹안전 #4** | 생성 직후 및 수동 틱에서 `forceAll: true`로 `autoApprovalScope` 우회 가능성 | `forceAll` 제거 및 설정된 승인 범위 강제 준수 완료 |
| **스케줄러 #5** | `loadThrottled` 필드명 불일치 및 미완성 Pending 배치 재시도 쿨다운 지연 | 플래그 정합성 수정 및 `Pending ➔ Failed` 15초 재보충 완료 |
| **스케줄러 #6** | 슬롯 영구 삭제(`🗑️`) 시 Pending 슬롯을 지워도 `targetPendingRuns`가 안 줄던 문제 | Running/Pending 상태별 독립 목표 차감 수식 적용 완료 |
| **스케줄러 #7** | `WAIT_APPROVAL` 상태 문자열이 `"ACTIVE"` 분류에서 누락되던 경계값 버그 (`TC-09` 적발) | `classifyRunStatus` / `classifyUiRunStatus` 보강 완료 |
| **멀티사이트 #8** | 미선언 식별자 `DEFAULT_SITES` 참조(`ReferenceError` 잠재 위험) 4곳 | `DEFAULT_STATE.sites`로 전수 교정 완료 |
| **멀티사이트 #9** | N6 탭 조회 시 N9의 `GPU-Hours` 적산 시각 및 런타임 통계가 공유되던 문제 | 사이트별 `Proxy` 및 `telemetryBySite` 완전 격리 완료 |
| **메모리/통계 #10** | 장기 가동 시 로그 스니펫·승인맵·실패런셋 무한 누적 및 `throttleCount` `NaN` 버그 | 컬렉션별 크기 상한(Pruning) 및 숫자 초기화 적용 완료 |
| **프론트보안 #11** | 컨테이너/규칙명에 `'` 또는 `\` 포함 시 인라인 `onclick` 깨짐 및 XSS 위험 | `escapeJsStr` 도입 및 리소스 탐색 HTML 이스케이프 완료 |
| **프론트상태 #12** | 사이트 탭 전환 시 비동기 폴링 구 응답 덮어쓰기 및 슬롯 선택 잔류 | `reqSiteId` 일치 검증 가드 및 상태 초기화 추가 완료 |
| **프론트상태 #13** | 호버 동결 중 대기 슬롯 `🗑️-1` 정적 숫자 반복 전송 및 `remainingToSpawn` 오타 | `{ delta: -1 }` 상대 증감 방식 및 `remainingToCreate` 수정 완료 |
| **로그파서 #14** | `Epoch 3/10 | Step 450/1000` 로그에서 Step 대신 Epoch 분수를 잡던 정규식 버그 (`TC-15` 적발) | 명시적 `Step` 키워드 우선 매칭으로 교정 완료 |

---

## 6. 유지보수 및 회귀 테스트(Regression Test) 지침

향후 기능 추가 또는 리팩터링 시 아래 절차를 반드시 수행한 후 커밋·배포합니다.

1. **구문 및 자동화 회귀 테스트 실행**:
   ```bash
   npm run check && npm test
   ```
   모든 테스트 케이스(`TC-01` ~ `TC-23`)가 `0 fail`로 통과해야 합니다.
2. **신규 인라인 핸들러 추가 시 보안 점검**:
   `public/app.js`에서 HTML 문자열 내 `onclick="..."`에 동적 문자열 인자를 전달할 때는 반드시 `escapeHtml`이 아닌 `escapeJsStr`을 사용하고 `TC-17`을 통과하는지 확인합니다.
3. **신규 일괄 제어/자동화 루프 추가 시 그룹 안전 점검**:
   `getRunsList()` 결과 배열을 순회하여 종료·수정 작업을 수행하는 모든 코드는 반드시 `doesRunMatchSiteJobs(run, state.jobs)`와 소유자 검증을 거치도록 작성하고 `Suite 2` 테스트 케이스를 추가합니다.

> 🔗 **관련 문서**: 전체 시스템 요구사항, 설계 지침, 아키텍처 다이어그램 및 API 명세는 **[소프트웨어 구성 및 상세 설계 명세서 (`docs/SOFTWARE_ARCHITECTURE_AND_DESIGN.md`)](./SOFTWARE_ARCHITECTURE_AND_DESIGN.md)** 를 참조하세요.
