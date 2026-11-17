/**
 * SPACE Multi-Site GPU Auto-Allocator & Admin Run-Approval Server
 * Automated Verification & Regression Test Suite (`node --test tests/run-tests.mjs`)
 *
 * - Zero external dependencies (uses Node.js built-in `node:test`, `node:assert/strict`, `node:vm`)
 * - 100% Non-Destructive: Never modifies `data/state.json` and never mutates/terminates live SPACE runs.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT_DIR, "server.mjs");
const APP_JS_PATH = path.join(ROOT_DIR, "public", "app.js");
const INDEX_HTML_PATH = path.join(ROOT_DIR, "public", "index.html");

const serverSrc = fs.readFileSync(SERVER_PATH, "utf8");
const appJsSrc = fs.readFileSync(APP_JS_PATH, "utf8");
const indexHtmlSrc = fs.readFileSync(INDEX_HTML_PATH, "utf8");

/**
 * Extract a named top-level function block (indented at column 0) from source code.
 */
function extractFunctionSource(source, fnName) {
  const normalized = source.replace(/\r\n/g, "\n");
  const startRegex = new RegExp(`^(?:async\\s+)?function\\s+${fnName}\\s*\\(`, "m");
  const match = startRegex.exec(normalized);
  if (!match) {
    throw new Error(`Function "${fnName}" not found in source`);
  }
  const startIdx = match.index;
  const closeRegex = /\n\}(?=\n|$)/g;
  closeRegex.lastIndex = startIdx;
  const closeMatch = closeRegex.exec(normalized);
  if (!closeMatch) {
    throw new Error(`Closing brace for "${fnName}" not found in source`);
  }
  return normalized.slice(startIdx, closeMatch.index + 2);
}

/**
 * Build isolated VM sandbox with actual functions extracted from `server.mjs`.
 */
function createServerLogicSandbox() {
  const fnNames = [
    "normalizeSiteId",
    "decodeJwtPayload",
    "detectSiteIdFromTokenOrText",
    "classifyRunStatus",
    "selectPreferredGpuCore",
    "getInFlightReservationsForJob",
    "reserveWorkerSlot",
    "releaseWorkerSlot",
    "pickNextWorkerSlot",
    "parseWorkerLogProgress",
    "getJobContainerPrefix",
    "doesRunMatchJob",
    "doesRunMatchSiteJobs",
    "computeJobTargetMetrics",
    "computeAdjustedTargetsAfterSlotDelete",
    "parseIncomingRequestUrl",
  ];

  const context = vm.createContext({
    Buffer,
    URL,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    JSON,
    currentSite: "n9",
    rawState: { sites: { n9: { id: "n9" }, n6: { id: "n6" } } },
    state: { jobs: [] },
    inFlightJobReservations: new Map(),
    getCurrentSiteId: () => context.currentSite,
    getSiteGpuModel: (sid) => (sid === "n6" ? "A100" : "H100"),
    extractAssignedSlotFromRun: (r) => {
      const m = String(r?.containerName || r?.name || "").match(/-s(\d+)-/i);
      return m ? Number(m[1]) : null;
    },
  });

  const combinedCode = fnNames.map((fn) => extractFunctionSource(serverSrc, fn)).join("\n\n");
  vm.runInContext(combinedCode, context);
  return context;
}

/**
 * Build isolated VM sandbox with actual functions extracted from `public/app.js`.
 */
function createFrontendLogicSandbox() {
  const fnNames = ["escapeHtml", "escapeJsStr", "parseSlotSpecToRunIds", "classifyUiRunStatus"];
  const context = vm.createContext({
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    Math,
    latestWorkerFleet: null,
    latestRawSpaceRuns: [],
    getFocusedJobFleet: () => null,
  });

  const combinedCode = fnNames.map((fn) => extractFunctionSource(appJsSrc, fn)).join("\n\n");
  vm.runInContext(combinedCode, context);
  return context;
}

const srv = createServerLogicSandbox();
const ui = createFrontendLogicSandbox();

// ============================================================================
// Suite 1: 정적 구문 및 코드베이스 구조 무결성 검증
// ============================================================================
describe("Suite 1: 정적 구문 및 코드베이스 무결성 검증 (Static & Structural Verification)", () => {
  test("TC-01: server.mjs Node.js ESM 구문 검사 통과 (`node --check`)", () => {
    execFileSync(process.execPath, ["--check", SERVER_PATH], { stdio: "pipe" });
  });

  test("TC-02: public/app.js 프론트엔드 스크립트 구문 검사 통과 (`node --check`)", () => {
    execFileSync(process.execPath, ["--check", APP_JS_PATH], { stdio: "pipe" });
  });

  test("TC-03: 미선언 상수(`DEFAULT_SITES`) 부재 및 핵심 안전 헬퍼 존재 검증", () => {
    assert.equal(
      /\bDEFAULT_SITES\b/.test(serverSrc),
      false,
      "server.mjs 내에 미선언 식별자 DEFAULT_SITES가 존재하면 안 됩니다."
    );
    assert.ok(serverSrc.includes("function doesRunMatchSiteJobs("), "doesRunMatchSiteJobs 헬퍼 필수");
    assert.ok(serverSrc.includes("function createSiteRuntimeObjectProxy("), "사이트별 런타임 프록시 필수");
    assert.ok(appJsSrc.includes("function escapeJsStr("), "인라인 핸들러 이스케이프 함수 escapeJsStr 필수");
  });

  test("TC-04: index.html 핵심 DOM 컨테이너 ID와 app.js 바인딩 정합성 검증", () => {
    const requiredIds = [
      "lockOverlay",
      "multiSiteTabsContainer",
      "topAutoStatusBanner",
      "workerFleetPanel",
      "runsTableBody",
      "jobsTableBody",
      "approvalsTableBody",
      "historyTableBody",
      "runLogBox",
      "sfmEditorTextarea",
      "presetsBarPanel",
    ];
    for (const id of requiredIds) {
      assert.ok(
        indexHtmlSrc.includes(`id="${id}"`),
        `public/index.html에 필수 DOM ID #${id}가 존재해야 합니다.`
      );
      assert.ok(
        appJsSrc.includes(`"${id}"`) || appJsSrc.includes(`'${id}'`),
        `public/app.js에서 필수 DOM ID #${id}를 참조해야 합니다.`
      );
    }
  });
});

// ============================================================================
// Suite 2: 워커 규칙 매칭 및 공유 그룹(SR-Coredata) 멀티테넌트 보호 검증
// ============================================================================
describe("Suite 2: 공유 그룹(SR-Coredata) 타 사용자 보호 및 규칙 매칭 검증", () => {
  const siteJobs = [
    { id: "job-1", name: "worker-spot", lastRunId: null },
    { id: "job-2", name: "worker-spot-eval", lastRunId: null },
    { id: "job-v8", name: "v8", lastRunId: 360146 },
  ];

  test("TC-05: 최장 접두사 우선 매칭(`doesRunMatchJob`)으로 유사 규칙 간 런 가로채기 방지", () => {
    const runShort = { id: 101, containerName: "worker-spot-s01-1113-12-00-00" };
    const runLong = { id: 102, containerName: "worker-spot-eval-s01-1113-12-00-00" };

    assert.equal(srv.doesRunMatchJob(runShort, siteJobs[0], siteJobs), true);
    assert.equal(srv.doesRunMatchJob(runShort, siteJobs[1], siteJobs), false);

    assert.equal(srv.doesRunMatchJob(runLong, siteJobs[0], siteJobs), false, "짧은 접두사 규칙이 긴 접두사 규칙의 런을 가로채면 안 됨");
    assert.equal(srv.doesRunMatchJob(runLong, siteJobs[1], siteJobs), true);
  });

  test("TC-06: `doesRunMatchSiteJobs`가 동료 워크로드(`rememberme-gpu`, `mmodal-gap-eval`, `regift2`)를 완벽히 배제", () => {
    const myV8Run = { id: 360140, containerName: "v8-s19-1113-12-10-00", userName: "minsoo3.kim" };
    const colleagueRuns = [
      { id: 359001, containerName: "rememberme-gpu-train-01", userName: "colleague.a" },
      { id: 359002, containerName: "mmodal-gap-eval-h100", userName: "colleague.b" },
      { id: 359003, containerName: "regift2-exp-run", userName: "colleague.c" },
    ];

    assert.equal(srv.doesRunMatchSiteJobs(myV8Run, siteJobs), true);
    for (const cr of colleagueRuns) {
      assert.equal(
        srv.doesRunMatchSiteJobs(cr, siteJobs),
        false,
        `동료 워크로드 ${cr.containerName}는 내 규칙 대상에 절대 매칭되면 안 됩니다.`
      );
    }
  });

  test("TC-07: `doesRunMatchSiteJobs`에 `targetJobId` 지정 시 해당 단일 규칙 런만 선별", () => {
    const myV8Run = { id: 360140, containerName: "v8-s02-1113-12-10-00" };
    const mySpotRun = { id: 360141, containerName: "worker-spot-s01-1113-12-10-00" };

    assert.equal(srv.doesRunMatchSiteJobs(myV8Run, siteJobs, "job-v8"), true);
    assert.equal(srv.doesRunMatchSiteJobs(mySpotRun, siteJobs, "job-v8"), false);
  });

  test("TC-08: 백엔드 종료 API(403 차단) 및 프론트엔드 타유저 UI 보호 적용 검증", () => {
    assert.ok(
      serverSrc.includes("타 사용자(") && serverSrc.includes("sendJson(res, 403"),
      "POST /api/space/runs/:id/stop 에 타 사용자 런 종료 403 차단 가드가 있어야 합니다."
    );
    assert.ok(
      appJsSrc.includes("🔒 타유저 보호"),
      "프론트엔드 런 테이블에서 타 사용자 활성 런은 Kill 버튼 대신 보호 배지를 표시해야 합니다."
    );
  });
});

// ============================================================================
// Suite 3: 이중 목표 스케줄러(minConcurrentRuns & targetPendingRuns) 및 슬롯 삭제 수식 검증
// ============================================================================
describe("Suite 3: 스케줄러 상태 분류, 부족분(Deficit), 슬롯 예약 및 영구 삭제(-1) 수식 검증", () => {
  test("TC-09: `classifyRunStatus` 모든 WLM 상태 문자열을 ACTIVE / SUCCEEDED / FAILED 로 정확 분류", () => {
    for (const st of ["RUNNING", "PENDING", "WAIT_APPROVAL", "CREATING", "STAGING", "APPROVED", "QUEUED"]) {
      assert.equal(srv.classifyRunStatus(st), "ACTIVE", `${st} should be ACTIVE`);
    }
    for (const st of ["SUCCEEDED", "COMPLETED", "FINISHED", "DONE"]) {
      assert.equal(srv.classifyRunStatus(st), "SUCCEEDED", `${st} should be SUCCEEDED`);
    }
    for (const st of ["FAILED", "ERROR", "TERMINATED", "KILLED", "CANCELED", "REJECTED"]) {
      assert.equal(srv.classifyRunStatus(st), "FAILED", `${st} should be FAILED`);
    }
  });

  test("TC-10: `computeJobTargetMetrics`가 전체 목표(`minConcurrentRuns`) 상한 내에서 `deficit`을 정확히 계산", () => {
    // Case 1: v8 운영 시나리오 (목표 56, Running 20개 가동 중, targetPending = 6, 현재 Pending = 4, InFlight = 0 -> 2개 즉시 보충)
    const m1 = srv.computeJobTargetMetrics({
      minConcurrentRuns: 56,
      targetPendingRuns: 6,
      coreCount: 4,
      runningCount: 20,
      pendingCount: 4,
      inFlightCount: 0,
    });
    assert.equal(m1.deficit, 2);
    assert.equal(m1.targetCount, 56);
    assert.equal(m1.targetGpuCount, 224);

    // Case 2: In-Flight 예약 2개가 이미 생성 중이면 중복 생성 0개
    const m2 = srv.computeJobTargetMetrics({
      minConcurrentRuns: 56,
      targetPendingRuns: 6,
      coreCount: 4,
      runningCount: 20,
      pendingCount: 4,
      inFlightCount: 2,
    });
    assert.equal(m2.deficit, 0);

    // Case 3: targetPending = 0 일반 모드 (목표 20, Running 15 + Pending 3 = 18 -> 부족분 2개)
    const m3 = srv.computeJobTargetMetrics({
      minConcurrentRuns: 20,
      targetPendingRuns: 0,
      coreCount: 4,
      runningCount: 15,
      pendingCount: 3,
      inFlightCount: 0,
    });
    assert.equal(m3.deficit, 2);
    assert.equal(m3.targetGpuCount, 80);
  });

  test("TC-11: `computeAdjustedTargetsAfterSlotDelete`가 목표 범위 내 슬롯 영구 삭제 시 목표를 정확히 차감", () => {
    // Pending 대기 슬롯 삭제 시 (Running 20 + Pending 6 = 26 <= 목표 56): Running 목표(56) 유지, targetPendingRuns 6 -> 5 차감
    const resA = srv.computeAdjustedTargetsAfterSlotDelete({
      prevTarget: 56,
      prevPendingTarget: 6,
      activeBefore: 26,
      pendingBefore: 6,
      runningDeletedCount: 0,
      pendingDeletedCount: 1,
    });
    assert.equal(resA.newTarget, 56);
    assert.equal(resA.newPendingTarget, 5);
    assert.equal(resA.shouldDisable, false);

    // Running 가동 슬롯 삭제 시 (Running 50 + Pending 6 = 56 <= 목표 56): minConcurrentRuns 56 -> 55 차감
    const resB = srv.computeAdjustedTargetsAfterSlotDelete({
      prevTarget: 56,
      prevPendingTarget: 6,
      activeBefore: 56,
      pendingBefore: 6,
      runningDeletedCount: 1,
      pendingDeletedCount: 0,
    });
    assert.equal(resB.newTarget, 55);
    assert.equal(resB.newPendingTarget, 6);
    assert.equal(resB.shouldDisable, false);

    // targetPendingRuns = 0 인 상태에서 마지막 1개 슬롯 삭제 시: 자동생성 shouldDisable = true 전환
    const resC = srv.computeAdjustedTargetsAfterSlotDelete({
      prevTarget: 1,
      prevPendingTarget: 0,
      activeBefore: 1,
      pendingBefore: 0,
      runningDeletedCount: 1,
      pendingDeletedCount: 0,
    });
    assert.equal(resC.newTarget, 1);
    assert.equal(resC.shouldDisable, true);
  });

  test("TC-24: [회귀 방지] `targetPendingRuns > 0`이어도 목표 워커·총 GPU(`minConcurrentRuns * coreCount`)를 절대 부풀리거나 초과 생성하지 않음", () => {
    // 실제 장애 재현 1: 목표 60워커(240 GPU), Running 103 + Pending 6, targetPendingRuns 6
    // 과거 버그: targetCount가 109(436 GPU)로 덮어써지고 excessPendingCount가 0이 되었음!
    const over60 = srv.computeJobTargetMetrics({
      minConcurrentRuns: 60,
      targetPendingRuns: 6,
      coreCount: 4,
      runningCount: 103,
      pendingCount: 6,
      inFlightCount: 0,
    });
    assert.equal(over60.targetCount, 60);
    assert.equal(over60.targetGpuCount, 240);
    assert.equal(over60.deficit, 0);
    assert.equal(over60.remainingToCreate, 0);
    assert.equal(over60.excessActiveCount, 49);
    assert.equal(over60.excessPendingCount, 6);

    // 실제 장애 재현 2: 목표 30워커(120 GPU), Running 31 + Pending 2, targetPendingRuns 2
    const over30 = srv.computeJobTargetMetrics({
      minConcurrentRuns: 30,
      targetPendingRuns: 2,
      coreCount: 4,
      runningCount: 31,
      pendingCount: 2,
      inFlightCount: 0,
    });
    assert.equal(over30.targetCount, 30);
    assert.equal(over30.targetGpuCount, 120);
    assert.equal(over30.deficit, 0);
    assert.equal(over30.excessActiveCount, 3);
    assert.equal(over30.excessPendingCount, 2);

    // 경계 조건: 목표 30워커(120 GPU), Running 29 + Pending 0, targetPendingRuns 2 -> 총 목표 상한(30) 때문에 1개만 생성해야 함!
    const boundary = srv.computeJobTargetMetrics({
      minConcurrentRuns: 30,
      targetPendingRuns: 2,
      coreCount: 4,
      runningCount: 29,
      pendingCount: 0,
      inFlightCount: 0,
    });
    assert.equal(boundary.targetCount, 30);
    assert.equal(boundary.deficit, 1);
    assert.equal(boundary.remainingGpuToCreate, 4);
  });

  test("TC-25: [회귀 방지] 목표 초과 상태(`activeBefore > prevTarget`)에서 초과 워커 슬롯 삭제 시 설정된 목표(`prevTarget`)가 깎이지 않고 보존됨", () => {
    // 실제 장애 재현: 목표 60워커 상태에서 103개 가동 중 초과분 1개를 슬롯 삭제해도 목표 60이 59로 줄어들면 안 됨!
    const keep60 = srv.computeAdjustedTargetsAfterSlotDelete({
      prevTarget: 60,
      prevPendingTarget: 0,
      activeBefore: 103,
      pendingBefore: 0,
      runningDeletedCount: 1,
      pendingDeletedCount: 0,
    });
    assert.equal(keep60.newTarget, 60);
    assert.equal(keep60.shouldDisable, false);

    // 초과분 43개를 넘어 총 44개를 일괄 삭제해 남은 활성 워커가 59개가 된 경우에만 60 -> 59로 1개 차감됨
    const trim44 = srv.computeAdjustedTargetsAfterSlotDelete({
      prevTarget: 60,
      prevPendingTarget: 0,
      activeBefore: 103,
      pendingBefore: 0,
      runningDeletedCount: 44,
      pendingDeletedCount: 0,
    });
    assert.equal(trim44.newTarget, 59);
  });

  test("TC-12: `pickNextWorkerSlot` 및 `reserveWorkerSlot` 인플라이트 슬롯 번호 중복 할당 방지", () => {
    const job = { id: "job-slot-test" };
    const activeRuns = [
      { id: 1, containerName: "v8-s1-1113-12-00-00" },
      { id: 2, containerName: "v8-s3-1113-12-00-01" },
    ];

    // 1-based 슬롯에서 s1, s3이 사용 중이므로 첫 빈 슬롯은 2번(s2)이어야 함
    const slot1 = srv.pickNextWorkerSlot(job, activeRuns, 4);
    assert.equal(slot1, 2);
    const resId1 = srv.reserveWorkerSlot(job.id, slot1, 10000);

    // s2가 인플라이트 예약 상태이므로 다음 호출은 4번(s4)을 반환해야 함
    const slot2 = srv.pickNextWorkerSlot(job, activeRuns, 4);
    assert.equal(slot2, 4);

    srv.releaseWorkerSlot(job.id, resId1);
    assert.equal(srv.getInFlightReservationsForJob(job.id).length, 0);
  });
});

// ============================================================================
// Suite 4: 멀티 사이트(N9 H100 / N6 A100) 리소스 자동 탐색 및 로그 파서 검증
// ============================================================================
describe("Suite 4: 멀티 사이트(N9 H100 vs N6 A100) 코어 선택 및 토큰/로그 파싱 검증", () => {
  test("TC-13: `detectSiteIdFromTokenOrText`가 URL 및 JWT `iss` 클레임으로 N9 / N6 사이트를 정확 판별", () => {
    const makeFakeJwt = (payload) =>
      `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

    const n6Jwt = makeFakeJwt({ iss: "https://keycloak.n6-local.sr-cloud.com/auth/realms/srcloud" });
    const n9Jwt = makeFakeJwt({ iss: "https://keycloak.n9-local.sr-cloud.com/auth/realms/srcloud" });

    assert.equal(srv.detectSiteIdFromTokenOrText("", n6Jwt, "", "n9"), "n6");
    assert.equal(srv.detectSiteIdFromTokenOrText("", n9Jwt, "", "n6"), "n9");
    assert.equal(srv.detectSiteIdFromTokenOrText("https://space.n6.sr-cloud.com/login", "", "", "n9"), "n6");
  });

  test("TC-14: `selectPreferredGpuCore`가 N9에서는 H100 풀카드, N6에서는 A100 풀카드를 최우선 선택", () => {
    const mixedCores = [
      { id: 1, name: "CPU" },
      { id: 2, name: "H100 20GB (fGPU)" },
      { id: 3, name: "NVIDIA H100" },
      { id: 4, name: "A100 40GB" },
      { id: 5, name: "NVIDIA A100" },
    ];

    const pickedN9 = srv.selectPreferredGpuCore(mixedCores, "n9");
    assert.equal(pickedN9.id, 3, "N9 사이트는 MIG/fGPU가 아닌 NVIDIA H100 풀카드를 선택해야 함");

    const pickedN6 = srv.selectPreferredGpuCore(mixedCores, "n6");
    assert.equal(pickedN6.id, 5, "N6 사이트는 슬라이스가 아닌 NVIDIA A100 풀카드를 선택해야 함");
  });

  test("TC-15: `parseWorkerLogProgress`가 학습 로그에서 Epoch, Step, Loss 진행 지표를 정확히 추출", () => {
    const sampleLog = [
      "[2026-11-13 12:10:00] Initializing distributed process group...",
      "Epoch 3/10 | Step 450/1000 (45%) | loss: 0.2841 | lr: 1e-4",
    ].join("\n");

    const parsed = srv.parseWorkerLogProgress(sampleLog);
    assert.ok(parsed, "파싱 결과가 반환되어야 함");
    assert.equal(parsed.pct, 45);
    assert.ok(String(parsed.stepInfo).includes("450/1000"));
    assert.ok(String(parsed.loss).includes("0.2841"));
  });
});

// ============================================================================
// Suite 5: 프론트엔드 XSS/쿼트 이스케이프 및 슬롯 범위 파서 검증
// ============================================================================
describe("Suite 5: 프론트엔드 인라인 핸들러 보안 이스케이프 및 슬롯 범위 파서 검증", () => {
  test("TC-16: `escapeHtml`이 모든 HTML 메타문자(`&`, `<`, `>`, `\"`, `'`)를 엔티티로 치환", () => {
    const raw = `<img src=x onerror="alert('xss')">&`;
    const escaped = ui.escapeHtml(raw);
    assert.equal(escaped, "&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;");
  });

  test("TC-17: `escapeJsStr`이 HTML 속성 디코딩 후 JS 단일 따옴표 리터럴에서 원본 문자열을 100% 복원", () => {
    const trickyInputs = [
      `worker's-"quote"-test`,
      `path\\to\\script.sh`,
      `<script>alert('pwn')</script>`,
      `line1\nline2 & more`,
    ];

    const decodeHtmlAttr = (str) =>
      str
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

    for (const input of trickyInputs) {
      const attrSafe = ui.escapeJsStr(input);
      // 1) HTML 속성 파서가 큰따옴표(") 경계를 깨뜨리지 않는지 확인
      assert.equal(attrSafe.includes('"'), false, "escapeJsStr 결과에 날것의 큰따옴표가 남으면 안 됨");
      // 2) 브라우저가 HTML 엔티티를 디코딩한 뒤 JS 엔진이 onclick="fn('...')"을 실행하는 과정 시뮬레이션
      const jsCode = `(${JSON.stringify("")}, '${decodeHtmlAttr(attrSafe)}')`;
      const evaluated = vm.runInNewContext(jsCode);
      assert.equal(evaluated, input.replace(/\r/g, ""), `원본 문자열이 정확히 복원되어야 함: ${input}`);
    }
  });

  test("TC-18: `parseSlotSpecToRunIds`가 개별 슬롯, 하이픈 범위(`2-4`), 명시적 Run ID(`#360999`)를 정확 파싱", () => {
    const mockFleet = {
      activeWorkers: [
        { id: "360101", slotIndex: 1 },
        { id: "360102", slotIndex: 2 },
        { id: "360103", slotIndex: 3 },
        { id: "360104", slotIndex: 4 },
        { id: "360105", slotIndex: 5 },
      ],
    };
    ui.latestRawSpaceRuns = [{ id: 360999, containerName: "unmatched-own-run" }];

    const res = ui.parseSlotSpecToRunIds("1, 3-4, #360999", mockFleet);
    assert.deepEqual(Array.from(res.matchedRunIds), ["360101", "360103", "360104", "360999"]);
  });

  test("TC-27: `parseIncomingRequestUrl`이 스캐너의 `//`, 다중 슬래시(`///api/state`), 비정상 URL에서도 크래시(`ERR_INVALID_URL`) 없이 안전 처리", () => {
    const doubleSlash = srv.parseIncomingRequestUrl("//");
    assert.ok(doubleSlash, "`//` 요청은 루트 `/`로 안전 정규화되어야 함");
    assert.equal(doubleSlash.pathname, "/");

    const multiSlashApi = srv.parseIncomingRequestUrl("///api/state?siteId=n9");
    assert.ok(multiSlashApi);
    assert.equal(multiSlashApi.pathname, "/api/state");
    assert.equal(multiSlashApi.searchParams.get("siteId"), "n9");

    assert.equal(srv.parseIncomingRequestUrl("10.113.125.253:4300"), null, "비정상 CONNECT 타깃은 null 반환");
    assert.equal(srv.parseIncomingRequestUrl("/bad\0null"), null, "Null 바이트 포함 URL은 null 반환");
    assert.equal(srv.parseIncomingRequestUrl("http://[invalid"), null, "깨진 호스트 URL은 예외 대신 null 반환");
  });
});

// ============================================================================
// Suite 6: 라이브 서버 비파괴(Read-Only) HTTP API 계약 및 운영 정합성 검증
// ============================================================================
describe("Suite 6: 라이브 데몬(Port 4300) 비파괴 REST API 계약 및 멀티 사이트 격리 검증", async () => {
  const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:4300";
  const ADMIN_PW = process.env.ADMIN_PASSWORD || "cycy";

  let serverReachable = false;
  try {
    const probe = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(1500) });
    serverReachable = probe.ok;
  } catch {
    serverReachable = false;
  }

  test("TC-19: 미인증 상태에서 보호 API(`GET /api/state`) 호출 시 `401 Unauthorized` 차단", async (t) => {
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 (샌드박스 네트워크 격리 등) — 스킵");
    const res = await fetch(`${BASE_URL}/api/state`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.locked, true);
  });

  test("TC-20: `POST /api/auth/verify` 오답 비밀번호 거부(`401`) 및 정답 비밀번호 승인(`200`) 검증", async (t) => {
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 스킵");
    const badRes = await fetch(`${BASE_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(badRes.status, 401);

    const okRes = await fetch(`${BASE_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PW }),
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.ok, true);
  });

  test("TC-21: `GET /api/state` (N9) 사이트 요약 워커 수와 `workerFleet` 집계 정합성 및 `NaN` 부재 검증", async (t) => {
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 스킵");
    const res = await fetch(`${BASE_URL}/api/state`, {
      headers: { "X-Admin-Password": ADMIN_PW, "X-Site-Id": "n9" },
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(data.sites?.n9, "N9 사이트 요약이 존재해야 함");
    assert.ok(data.sites?.n6, "N6 사이트 요약이 존재해야 함");
    assert.equal(data.sites.n9.gpuModel, "H100");
    assert.equal(data.sites.n6.gpuModel, "A100");

    // 규칙 기반 사이트 요약 워커 수와 플릿 보드 워커 수가 일치해야 함 (타 사용자 런 오염 없음)
    assert.equal(data.sites.n9.runningWorkers, data.workerFleet.totalRunningWorkers);
    assert.equal(data.sites.n9.pendingWorkers, data.workerFleet.totalPendingWorkers);
    assert.equal(data.sites.n9.activeWorkers, data.workerFleet.totalActiveWorkers);
    assert.equal(Number.isFinite(data.loadMonitor?.throttleCount), true, "throttleCount가 NaN이면 안 됨");
  });

  test("TC-22: `X-Site-Id: n6` 조회 시 N9의 누적 GPU-Hours 텔레메트리가 오염되지 않고 격리 반환됨을 검증", async (t) => {
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 스킵");
    const [resN9, resN6] = await Promise.all([
      fetch(`${BASE_URL}/api/state`, { headers: { "X-Admin-Password": ADMIN_PW, "X-Site-Id": "n9" } }),
      fetch(`${BASE_URL}/api/state`, { headers: { "X-Admin-Password": ADMIN_PW, "X-Site-Id": "n6" } }),
    ]);
    const dataN9 = await resN9.json();
    const dataN6 = await resN6.json();

    assert.equal(dataN9.siteId || "n9", "n9");
    assert.equal(dataN6.siteId || "n6", "n6");
    assert.notEqual(
      dataN9.config.baseUrl,
      dataN6.config.baseUrl,
      "N9와 N6는 서로 다른 API Gateway baseUrl을 가져야 합니다."
    );

    // N6 조회 직후 다시 N9 조회 시 totalGpuHours가 감소하거나 덮어써지지 않아야 함
    const resN9After = await fetch(`${BASE_URL}/api/state`, {
      headers: { "X-Admin-Password": ADMIN_PW, "X-Site-Id": "n9" },
    });
    const dataN9After = await resN9After.json();
    assert.ok(
      Number(dataN9After.telemetry?.totalGpuHours || 0) >= Number(dataN9.telemetry?.totalGpuHours || 0),
      "N6 조회가 N9의 누적 GPU-Hours를 초기화하거나 덮어쓰면 안 됩니다."
    );
  });

  test("TC-23: `GET /api/telemetry/export` 리포트가 `siteId` 파라미터별로 독립 데이터를 반환", async (t) => {
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 스킵");
    const [expN9, expN6] = await Promise.all([
      fetch(`${BASE_URL}/api/telemetry/export?format=json&siteId=n9&pw=${encodeURIComponent(ADMIN_PW)}`),
      fetch(`${BASE_URL}/api/telemetry/export?format=json&siteId=n6&pw=${encodeURIComponent(ADMIN_PW)}`),
    ]);
    assert.equal(expN9.status, 200);
    assert.equal(expN6.status, 200);
    const jsonN9 = await expN9.json();
    const jsonN6 = await expN6.json();
    assert.equal(jsonN9.siteId, "n9");
    assert.equal(jsonN6.siteId, "n6");
  });

  test("TC-26: 라이브 `GET /api/state`의 모든 규칙에서 `targetCount`·`targetGpuCount`가 설정값(`minConcurrentRuns * coreCount`)과 정확히 일치", async (t) => {
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 스킵");
    const res = await fetch(`${BASE_URL}/api/state`, {
      headers: { "X-Admin-Password": ADMIN_PW, "X-Site-Id": "n9" },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    const jobMap = new Map((data.jobs || []).map((j) => [j.id, j]));
    for (const jf of data.workerFleet?.jobs || []) {
      const cfgJob = jobMap.get(jf.jobId);
      assert.ok(cfgJob, `workerFleet job ${jf.jobId} must exist in state.jobs`);
      const expectedWorkers = Math.max(1, Number(cfgJob.minConcurrentRuns || 1));
      const expectedGpus = expectedWorkers * Math.max(1, Number(cfgJob.coreCount || 1));
      assert.equal(jf.targetCount, expectedWorkers, `[${cfgJob.name}] targetCount가 설정값과 일치해야 함`);
      assert.equal(jf.targetGpuCount, expectedGpus, `[${cfgJob.name}] targetGpuCount가 설정값과 일치해야 함`);
      if (jf.activeCount >= expectedWorkers) {
        assert.equal(jf.remainingToCreate, 0, `[${cfgJob.name}] 목표 도달/초과 시 remainingToCreate는 0이어야 함`);
      }
    }
  });

  test("TC-28: 네트워크 스캐너의 `GET // HTTP/1.1` 및 깨진 인코딩 요청에도 데몬이 크래시하지 않고 정상 생존", async (t) => {
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 스킵");
    const targetUrl = new URL(BASE_URL);
    const sendRawPath = (rawPath) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: targetUrl.hostname,
            port: Number(targetUrl.port || 4300),
            method: "GET",
            path: rawPath,
            headers: { Host: `${targetUrl.hostname}:${targetUrl.port || 4300}` },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          }
        );
        req.on("error", reject);
        req.end();
      });

    const codeDoubleSlash = await sendRawPath("//");
    assert.equal(codeDoubleSlash, 200, "`GET //` 요청은 크래시 대신 200(index.html)으로 안전 응답해야 함");

    const codeBadPercent = await sendRawPath("/%E0%A4%A");
    assert.equal(codeBadPercent, 400, "깨진 퍼센트 인코딩 URI는 400으로 안전 거부해야 함");

    const aliveCheck = await fetch(`${BASE_URL}/api/state`, {
      headers: { "X-Admin-Password": ADMIN_PW, "X-Site-Id": "n9" },
    });
    assert.equal(aliveCheck.status, 200, "스캐너 프로브 직후에도 데몬이 정상 응답해야 함");
  });
});
