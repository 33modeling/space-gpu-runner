# 🚀 SPACE Multi-Site GPU Auto-Allocator & Admin Run-Approval Server (`space-gpu-runner`)

**SPACE 멀티 사이트 클러스터(`SPACE N9 · NVIDIA H100` 및 `SPACE N6 · NVIDIA A100`)** 를 통합 모니터링하여 **목표 가동 워커(`minConcurrentRuns`) 및 목표 Pending 대기열(`targetPendingRuns`) 자동 할당·보충**, **Group Volume(`/group-volume`) 스크립트 자동 실행·동기화**, **Group Admin 전용 `/run-approval` 실시간 무인 자동 승인**, 그리고 **특정 워커 슬롯 즉시 Kill(`🛑`) / 영구 삭제(`🗑️ -1`)** 까지 전 과정을 자동화하는 무의존성(Zero-Dependency) Node.js 웹서버 및 관제 대시보드입니다.

---

## 📚 엔지니어링 설계 및 테스트 문서 (Documentation Index)

| 문서 | 설명 |
| :--- | :--- |
| 📘 **[소프트웨어 구성 및 상세 설계 명세서 (`docs/SOFTWARE_ARCHITECTURE_AND_DESIGN.md`)](./docs/SOFTWARE_ARCHITECTURE_AND_DESIGN.md)** | 시스템 기능/비기능 요구사항(SRS), 8대 핵심 설계 지침, 시스템/런타임/상태머신/ERD 아키텍처(Mermaid 다이어그램), 백엔드·프론트엔드 서브시스템 상세 설계 및 31개 전수 REST API 명세 |
| 🧪 **[테스트 구성 전략 및 수행 결과 보고서 (`docs/TESTING_STRATEGY_AND_REPORT.md`)](./docs/TESTING_STRATEGY_AND_REPORT.md)** | 5계층 비파괴 검증 아키텍처, `node:vm` 기반 프로덕션 함수 직접 추출 자동화 테스트(`TC-01`~`TC-23`), 시나리오 통합 검증 및 40시간+ 실전 클러스터(80 H100 GPU) Soak Test & 버그 감사 리포트 |
| ⚙️ **[자동화 검증 테스트 스위트 (`tests/run-tests.mjs`)](./tests/run-tests.mjs)** | 외부 패키지 없이 `npm test`로 즉시 실행 가능한 6개 스위트·23개 자동 검증 스크립트 |

---

## ✨ 핵심 기능 요약

1. **🌐 멀티 사이트 통합 관제 (`SPACE N9 H100` + `SPACE N6 A100` + 커스텀 사이트)**
   - 상단 사이트 탭 바를 통해 N9(H100)와 N6(A100)를 원클릭 전환하며, 사이트별 토큰·자동화 규칙·런타임 통계·누적 GPU-Hours 텔레메트리를 `AsyncLocalStorage` 기반으로 완전 격리 관리합니다.
   - 토큰 붙여넣기 시 JWT `iss` 클레임으로 대상 사이트와 그룹 ID를 자동 식별하고, N9에서는 `H100` 풀카드, N6에서는 `A100` 풀카드를 최우선 자동 선택합니다.
2. **🎯 이중 목표 자동 할당 스케줄러 (`minConcurrentRuns` + `targetPendingRuns`)**
   - **목표 가동 워커 수(`minConcurrentRuns`)**: `1 ~ 9999`개 목표치를 설정된 할당 주기(`5초`, `15초`, `30초`, `1분`, `2분`, `3분`, `5분`, `10분` 등)로 자동 유지합니다.
   - **목표 Pending 대기열 유지(`targetPendingRuns`)**: 클러스터 노드가 비는 즉시 배정받을 수 있도록 지정된 개수의 `Pending` 워커를 항상 큐에 채워 두며, `Pending ➔ Running` 승격 감지 시 쿨다운을 우회해 즉시 보충합니다.
3. **⚡ Group Admin `/run-approval` 2단계 무인 자동 승인**
   - 3초 주기 백그라운드 감시 루프와 런 생성 직후 고속 연속 승인 루프가 TaskOrbit 승인 요청(`request`) 및 Admin 승인(`approve`)을 무인 완결하며, 승인 범위(`my_runs` / `all_group` / `job_only` / `off`)를 엄격히 준수합니다.
4. **🛑 개별·범위 슬롯 즉시 Kill 및 영구 삭제(`🗑️ -1`) + 공유 그룹 타유저 3중 보호**
   - 슬롯 카드 원클릭, 체크박스 다중 선택, 슬롯 번호/범위 입력(`예: 1, 5, 58-62, #360146`)으로 즉시 강제 종료(`🛑 Kill`)하거나 목표 수량까지 함께 차감하는 영구 삭제(`🗑️ 삭제 -1`)를 지원합니다.
   - 공유 그룹(`SR-Coredata`) 내 동료 연구자의 워크로드는 UI(`🔒 타유저 보호`), 종료 API(`403 Forbidden`), 자동화 루프(`doesRunMatchSiteJobs`)의 3중 안전 장치로 완벽히 보호됩니다.
5. **🖥️ 화면 깜빡임 없는(Flicker-Free) 실시간 모니터링 & 클러스터 보호 가드**
   - 시그니처 비교(`data-render-sig`), 슬롯 카드 단위 증분 패치(`data-slot-key`), 마우스 호버 시 자동 갱신 일시정지(Hover-Freeze)로 5초 주기 새로고침 시에도 깜빡임 없이 조작할 수 있습니다.
   - **Smart Load Guard**(API 지연 자동 백오프), **Bad-Node Guard**(180초 내 조기 실패 노드 회피), **Watchdog & 라운드로빈 로그 파서**(진행률 `%`/`Epoch`/`Loss`/`ETA` 실시간 추출), **`/group-volume` 웹 스크립트 에디터 & 무중단 롤링 배포**, **사이트별 GPU-Hours 차트 및 CSV/JSON 내보내기**를 내장하고 있습니다.

---

## 🛠️ 요구 사항, 실행 및 테스트 방법

외부 `npm` 패키지 의존성이 전혀 없는 **순수 Node.js(`>= 20.0.0`)** 애플리케이션입니다.

### 1. 서버 실행
```bash
cd /home/kms/dev/space-gpu-runner
npm start
# 또는 환경 변수 지정 실행:
PORT=4300 ADMIN_PASSWORD=cycy node server.mjs
```

### 2. 구문 검사 및 자동화 테스트 실행
```bash
# 백엔드 + 프론트엔드 구문 무결성 검사
npm run check

# 전체 자동화 검증 테스트 스위트 실행 (6개 스위트 · 23개 케이스)
npm test
```

### 3. 웹 대시보드 접속
- **접속 주소**: `http://localhost:4300` (초기 비밀번호: `cycy`)

---

## 📖 빠른 사용 가이드 (Quick Start)

1. **잠금 해제**: 대시보드 접속 후 비밀번호(`cycy`)를 입력해 잠금을 해제합니다.
2. **사이트 선택 & 브라우저 토큰 1-Click 연동**:
   - 상단에서 `SPACE N9 (H100)` 또는 `SPACE N6 (A100)` 사이트 탭을 선택하거나, 설정 화면의 **`📋 브라우저 토큰 추출 코드 복사`** 버튼을 눌러 SPACE 포털 콘솔(`F12`)에서 실행한 뒤 붙여넣습니다.
   - 토큰 속 사이트(N9/N6), 그룹, GPU 풀, H100/A100 코어, 쿼터, 컨테이너 이미지가 자동으로 탐색·세팅됩니다.
3. **목표 워커 수 · 목표 Pending 수 · 할당 주기 설정**:
   - 실시간 모니터링 보드 상단에서 **목표 Running 워커 수**, **목표 Pending 대기 수(`targetPendingRuns`)**, **자동 할당 주기(`5초` ~ `10분`)** 를 원클릭으로 조정하고 규칙을 `🟢 ON`으로 켭니다.
4. **슬롯 정밀 제어**:
   - 특정 워커만 재할당하려면 슬롯 카드의 `🛑Kill`을, 목표 수량 자체를 줄여 다시 생성되지 않게 하려면 `🗑️삭제`를 클릭합니다.
