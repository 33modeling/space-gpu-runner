# 🚀 SPACE GPU Auto-Allocator & Admin Run-Approval Server (`space-gpu-runner`)

**SPACE (`https://space.n9.sr-cloud.com` / API Gateway `https://mlp.n9.sr-cloud.com`)** 플랫폼을 주기적으로 모니터링하여 **여유 GPU 할당**, **Group Volume (`/group-volume`) 내 스크립트 자동 실행**, 그리고 **Group Admin 전용 `/run-approval` (실행 승인) 자동 승인**까지 전 과정을 무인화하는 독립형 Node.js 웹서버 및 대시보드입니다.

---

## ✨ 핵심 기능 요약

1. **🔒 접속 시마다 비밀번호 보안 잠금 (`cycy`)**
   - 페이지에 접속하거나 새로고침(`F5`)할 때마다 잠금 화면이 표시되며, 비밀번호(`cycy`)를 입력해야 대시보드가 열립니다.
2. **🔍 ID 몰라도 되는 100% 자동 조회 (Zero-Config Auto-Discovery)**
   - `Group ID`, `Group Pool ID` (`groupPoolId`), `GPU Core ID` (`coreId`), `Priority ID` (`quotaId`), `컨테이너 이미지` 등을 사용자가 직접 찾을 필요가 없습니다.
   - **Access Token만 붙여넣으면** 서버가 SPACE API(`/api/acm/groups/default`, `/api/wlm/v2/org-resources`, `/api/wlm/v2/specs`, `/api/wlm/v2/quota`)를 호출해 **드롭다운에 한글 이름과 잔여 GPU 수량으로 자동 세팅**합니다.
3. **⚡ Group Admin `/run-approval` 실시간 자동 승인 데몬**
   - GPU 워크로드 생성 후 Admin 승인 대기(`WAIT_APPROVAL` / `PENDING`) 상태에 머무르지 않도록, 백그라운드 데몬이 주기적으로 `/taskorbit/api/v1/approvals` 및 `/api/wlm/v2/runs`를 스캔하여 **자동으로 Admin 승인 API를 호출**합니다.
   - 워크로드 생성 직후에는 **초고속 연속 승인 루프**(기본 2초 간격 × 8회)가 즉시 작동하여 대기 시간 없이 `RUNNING` 상태로 전환합니다.
4. **📦 `/group-volume` 자동 마운트 & 스크립트 반복 실행**
   - 그룹 공유 스토리지(`storageId: 2`, `mountPath: "/group-volume"`, `storageType: "GROUP"`)를 모든 컨테이너에 자동 마운트합니다.
   - `/group-volume/train.sh` 또는 `/group-volume/run.py` 경로만 입력하면 `bash` / `python3` 실행 커맨드와 로그 리다이렉션을 자동 구성합니다.
5. **⏱️ 4가지 조회 주기 실시간 조정**
   - **GPU 할당 & 작업 체크 주기** (기본 `15초`)
   - **Admin `/run-approval` 승인 감시 주기** (기본 `5초`)
   - **Run 생성 직후 연속 승인 재시도** (기본 `2초 간격 × 8회`)
   - **웹 대시보드 화면 자동 새로고침 주기** (기본 `5초`)

---

## 🛠️ 요구 사항 및 서버 실행 방법

외부 npm 패키지 의존성이 없는 **순수 Node.js (v18 이상 내장 `fetch` 및 `http` 모듈 사용)** 애플리케이션입니다.

### 1. 서버 실행
```bash
cd /home/kms/dev/space-gpu-runner
node server.mjs
```

### 2. 환경 변수 설정 (선택 사항)
기본 포트는 `4300`, 기본 비밀번호는 `cycy`입니다. 변경하려면 환경 변수를 지정해 실행하세요.
```bash
PORT=4300 ADMIN_PASSWORD=cycy node server.mjs
```

### 3. 웹 대시보드 접속
브라우저에서 아래 주소로 접속합니다.
- **URL**: `http://localhost:4300`
- **초기 비밀번호**: `cycy`

---

## 📖 단계별 상세 사용 방법 (Quick Start)

### Step 1. 비밀번호(`cycy`) 입력 및 잠금 해제
1. `http://localhost:4300`에 접속하면 보안 잠금 모달이 표시됩니다.
2. 비밀번호 입력란에 **`cycy`** 를 입력하고 **`🔓 잠금 해제 및 접속`** 버튼을 누릅니다.
3. 사용 중 자리를 비울 때는 우측 상단 **`🔒 화면 잠금`** 버튼을 눌러 즉시 잠글 수 있습니다.

---

### Step 2. SPACE 브라우저 토큰 1-Click 추출 및 자동 연동
`Group ID`나 `Group Pool ID`를 직접 찾을 필요가 없습니다.

1. 대시보드 좌측 상단 **1️⃣번 카드**에서 **`📋 브라우저 토큰 추출 코드 복사`** 버튼을 클릭합니다.
   - 또는 아래 한 줄 코드를 직접 복사합니다:
   ```javascript
   copy(JSON.stringify({accessToken:localStorage.getItem("access_token")||sessionStorage.getItem("access_token"),refreshToken:localStorage.getItem("refresh_token")||sessionStorage.getItem("refresh_token"),groupId:localStorage.getItem("group_id")||sessionStorage.getItem("group_id"),userName:localStorage.getItem("userName")||sessionStorage.getItem("userName")}))
   ```
2. 크롬/엣지에서 **[SPACE 사이트 (`https://space.n9.sr-cloud.com`)](https://space.n9.sr-cloud.com)** 에 로그인한 탭으로 이동합니다.
3. **`F12`** (개발자 도구) → **`Console` (콘솔)** 탭을 열고, 복사한 코드를 붙여넣은 뒤 **`Enter`** 를 누릅니다.
   - `sessionStorage`와 `localStorage`에 저장된 `access_token`, `refresh_token`, `group_id`가 클립보드에 JSON 형태로 자동 복사됩니다.
4. 다시 대시보드(`http://localhost:4300`)로 돌아와서 **1️⃣번 카드 상단의 `⚡ 빠른 붙여넣기` 입력창**에 **`Ctrl+V`** 로 붙여넣습니다.
5. **붙여넣는 즉시 자동으로 다음 작업이 완료됩니다:**
   - Access Token / Refresh Token(만료 시 자동 갱신용) / Group ID가 서버에 자동 저장됩니다.
   - SPACE 서버와 통신하여 **내 소속 그룹, GPU 리소스 풀(`groupPoolId`), GPU 스펙(`coreId`), 우선순위(`quotaId`), 컨테이너 이미지 목록**을 자동으로 가져옵니다.

---

### Step 3. Admin 자동 승인 범위 및 조회 간격 설정 (1️⃣번 카드)
- **👑 Admin 자동 승인 범위 (`/run-approval`)**:
  - `내 그룹 전체 승인 대기 워크로드 자동 승인 (권장)`: 내 그룹에서 생성된 모든 승인 대기 워크로드를 Admin 권한으로 자동 승인합니다.
  - `이 자동 실행기가 생성한 워크로드만 자동 승인`: 본 서버의 스케줄러가 생성한 Run만 선별하여 자동 승인합니다.
  - `자동 승인 끄기 (수동 승인 버튼만 사용)`: 대시보드 하단 테이블에서 직접 버튼으로만 승인합니다.
- **⏱️ 주기/간격 설정**:
  - 원하는 초(sec) 단위로 변경 후 **`💾 설정 저장`**을 누르면 서버 재시작 없이 즉시 타이머에 반영됩니다.

---

### Step 4. `/group-volume` 스크립트 확인 및 자동 실행 규칙 등록 (2️⃣, 3️⃣번 카드)

1. **파일 탐색 (선택)**:
   - **2️⃣번 카드** 하단의 **`📂 파일 목록 조회`** 버튼을 누르면 `/group-volume` 내의 디렉터리와 `.sh`, `.py` 파일 목록이 표시됩니다.
   - 원하는 스크립트의 **`👉 이 스크립트 선택`** 버튼을 누르면 3️⃣번 카드의 스크립트 경로에 자동 입력됩니다.
2. **새 자동 실행 규칙 등록 (3️⃣번 카드)**:
   - **작업 별칭**: 예) `nightly-llm-train`
   - **실행할 스크립트 경로**: 예) `/group-volume/exp/train.sh` (또는 `.py` 파일)
   - **추가 인자 / 환경변수**: 예) `--epochs 50 --lr 1e-4`
   - **실행 주기 모드**:
     - `항상 실행 유지 (종료/실패 시 자동 재할당)`: 워크로드가 죽거나 완료되면 다음 주기에 즉시 GPU를 다시 할당받아 재실행합니다.
     - `그룹 풀에 여유 GPU가 남을 때만 자동 할당`: 선택한 GPU 풀의 잔여 GPU(`freeGpu`)가 요청 수량 이상일 때만 할당합니다.
     - `1회 성공(COMPLETED)할 때까지 재시도`: 정상 종료(`COMPLETED`)될 때까지 실패 시 재할당합니다.
   - **요청 GPU 수 (`coreCount`)**: `1` ~ `8` (`0`으로 설정 시 CPU 전용 모드로 실행)
   - **대상 GPU 리소스 풀 / 스펙 / Priority / 컨테이너 이미지**:
     - Step 2에서 **이미 자동으로 첫 번째 유효한 항목이 선택**되어 있습니다. 필요시 드롭다운에서 다른 풀/스펙을 선택할 수 있으며, `자동 선택`으로 두어도 실행 시점에 서버가 자동으로 최적의 ID를 채워 넣습니다.
   - **`➕ 자동 실행 작업 등록`** 버튼을 클릭하면 스케줄러가 즉시 감시를 시작합니다.

---

### Step 5. 실시간 모니터링 및 즉시 실행 / 수동 제어 (4️⃣, 5️⃣번 카드)
- **즉시 실행**: 기다리지 않고 바로 GPU를 할당받고 싶다면 상단의 **`⚡ 지금 즉시 주기 체크 & 승인 실행`** 버튼 또는 작업 카드의 **`🚀 지금 할당`** 버튼을 클릭하세요.
- **Admin 승인 대기열 확인**: **4️⃣번 카드**에서 현재 그룹 내 승인 대기 중인 워크로드 목록을 볼 수 있으며, **`👑 대기 전체 일괄 승인`** 버튼으로 한 번에 승인할 수도 있습니다.
- **실시간 이벤트 로그**: **5️⃣번 카드 우측**에서 주기별 체크 결과, GPU 할당 요청 페이로드, Admin 자동 승인 성공 여부를 초 단위로 확인할 수 있습니다.

---

## 🔌 내장 REST API 엔드포인트 요약

| 메서드 | 경로 | 설명 |
| :--- | :--- | :--- |
| `POST` | `/api/auth/verify` | 대시보드 잠금 해제 비밀번호(`cycy`) 검증 |
| `GET` | `/api/state` | 서버 전체 설정, 등록된 Job, 실행 이력, 캐시된 SPACE 리소스 조회 |
| `POST` | `/api/config` | 인증 토큰, 그룹 ID, Admin 승인 범위 및 4종 조회 주기 설정 저장 |
| `POST` | `/api/space/discover` | SPACE 그룹/GPU 풀/스펙/쿼터/이미지 전체 자동 탐색 및 기본값 바인딩 |
| `GET` | `/api/space/runs` | 현재 그룹의 활성/최근 워크로드(`runs`) 목록 조회 |
| `GET` | `/api/space/approvals` | 현재 그룹의 Admin 승인 대기(`/run-approval`) 목록 조회 |
| `POST` | `/api/space/approvals/approve-all` | 대기 중인 모든 워크로드 일괄 Admin 승인 |
| `POST` | `/api/space/runs/:id/approve` | 특정 Run 또는 Approval ID 즉시 Admin 승인 |
| `POST` | `/api/space/runs/:id/stop` | 실행 중인 워크로드 강제 종료 |
| `GET` | `/api/space/runs/:id/logs` | 특정 워크로드의 컨테이너 표준 출력 로그 조회 |
| `GET` | `/api/space/files?path=/` | `/group-volume` 내 디렉터리/스크립트 파일 목록 조회 |
| `POST` | `/api/jobs` | 주기적 GPU 할당 & 스크립트 실행 규칙 등록/수정 |
| `POST` | `/api/jobs/:id/trigger` | 특정 실행 규칙 즉시 강제 트리거 (GPU 할당 + 즉시 Admin 승인) |
| `POST` | `/api/scheduler/tick` | 스케줄러 주기 틱(승인 스캔 + GPU 할당 평가) 즉시 1회 실행 |

---

## 🛠️ 최근 해결된 버그 내역 (Changelog)

1. **비밀번호(`cycy`) 입력 후 잠금 오버레이가 닫히지 않던 문제 수정**
   - `public/style.css`에 `.lock-overlay.hidden { display: none !important; }` 규칙을 추가하고, `public/app.js`의 `submitPassword()`에서 `overlay.style.display = "none"`을 직접 지정하여 인증 즉시 잠금 화면이 제거되도록 수정했습니다.
   - 또한 브라우저 캐시로 인해 구버전 CSS/JS가 로드되는 현상을 방지하기 위해 `/style.css?v=2`, `/app.js?v=2` 캐시 버스팅 및 `Cache-Control: no-store` 헤더를 적용했습니다.
2. **SPACE 브라우저 스토리지(`sessionStorage` / `localStorage`) 토큰 추출 호환성 개선**
   - SPACE 웹앱(`v2.9.6`)이 `access_token`, `refresh_token`을 `sessionStorage`에 저장하고 `group_id`를 `localStorage`에 저장하는 구조에 맞춰 양쪽 스토리지를 모두 탐색하도록 추출 스니펫을 개선했습니다.
3. **`Group ID`, `Group Pool ID`, `GPU Core ID`, `Priority ID` 100% 자동 탐색 지원**
   - 사용자가 숫자 ID를 몰라도 `/api/acm/groups/default`, `/api/wlm/v2/org-resources`, `/api/wlm/v2/specs`, `/api/wlm/v2/quota`를 순차 조회하여 드롭다운과 실행 페이로드에 자동 바인딩하도록 구현했습니다.
4. **토큰 입력 전 초기 진입 시 401/500 에러 방지**
   - 토큰을 설정하기 전에 대시보드에 처음 접속했을 때 `/api/space/runs` 및 `/api/space/approvals`가 에러 대신 빈 배열과 안내 상태를 반환하도록 개선했습니다.
5. **무제한 멀티 워커(`minConcurrentRuns`) 자동 생성 및 상단 실시간 컨트롤 배너 추가**
   - 기존 32개/128개 상한을 해제하여 원하는 목표 워커 수(`1` ~ `9999`개, 제한 없음)만큼 자동으로 신청·승인·보충되도록 개선했습니다.
   - 최상단 무인 자동화 배너(`#topAutoStatusBanner`)에서 `-4`, `+4`, `+8`, `40개`, `48개`, `64개`, `100개` 프리셋 및 직접 숫자 입력으로 즉시 목표 워커 수를 변경할 수 있습니다.
   - `evaluateJobRule`의 쿨다운 비교에 1.5초 지터 마진(`cooldownMs - 1500`)을 적용하고 틱 시작 시점 기준으로 타임스탬프를 기록하여 API 응답 지연으로 인해 다음 생성 주기가 건너뛰어지는 현상을 해결했습니다.
6. **클릭 없는 2단계 무인 자동 승인 (`request` → `approve`) 및 시각적 타임라인 표시**
   - `WAIT_APPROVAL` 상태의 워크로드가 아직 TaskOrbit 승인 대기열에 등록되지 않은 경우 서버가 자동으로 `POST /taskorbit/api/v1/approvals/request`를 먼저 호출한 뒤 이어서 `POST /taskorbit/api/v1/approvals/{approvalId}/approve`로 Admin 승인을 완료합니다.
   - 상단 배너 및 워커 현황판에서 최근 자동 신청/자동 승인 시각과 다음 자동 실행 카운트다운을 초 단위로 실시간 표시합니다.
