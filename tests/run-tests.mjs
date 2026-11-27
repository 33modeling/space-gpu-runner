/**
 * SPACE Multi-Site GPU Auto-Allocator & Admin Run-Approval Server
 * Automated Verification & Regression Test Suite (`node --test tests/run-tests.mjs`)
 *
 * - Zero external dependencies (uses Node.js built-in `node:test`, `node:assert/strict`, `node:vm`)
 * - 100% Non-Destructive: Never modifies `data/state.json` and never mutates/terminates live SPACE runs.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
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
    "parseFiniteNumber",
    "toSafeInt",
    "toSafeNum",
    "safeDecodeURIComponent",
    "writeStateFileAtomic",
    "readStateJsonWithFallback",
    "decodeJwtPayload",
    "shouldAlertAccessTokenExpiring",
    "sanitizeGroupId",
    "mergeSiteProfileUpdate",
    "resolveSfmFilePaths",
    "detectSiteIdFromTokenOrText",
    "isRunOwnedByUser",
    "shouldAutoApproveItem",
    "classifyRunStatus",
    "isGenuineBadNodeFailureRun",
    "shouldWatchdogTerminateNonRunningRun",
    "selectPreferredGpuCore",
    "getInFlightReservationsForJob",
    "reserveWorkerSlot",
    "releaseWorkerSlot",
    "pickNextWorkerSlot",
    "parseWorkerLogProgress",
    "formatWebhookPayload",
    "isSpotPreemptedRun",
    "isEligibleNewPreemptionEvent",
    "shouldTriggerHybridPoolFallback",
    "evaluateSilentHangState",
    "extractNodeIdentifierFromRunOrLog",
    "detectStragglerWorkers",
    "searchWorkerLogLines",
    "computeEffectiveJobBudget",
    "computeGlobalCapWorkerLimit",
    "extractScriptPathsFromCommand",
    "analyzeShellScriptIssues",
    "computeQueueAllocationVelocity",
    "classifyFailureRootCause",
    "isTransientGatewayCreateError",
    "sanitizeStateForBackup",
    "parseTaskQueueItems",
    "extractAssignedTaskIdxFromRun",
    "reconcileTaskQueueProgress",
    "pickNextTaskQueueItem",
    "detectLossDivergence",
    "summarizeOutputDirectoryEntries",
    "computeWorkerUptimeSec",
    "buildRunConsoleLinks",
    "computeHourlyClusterWeather",
    "parseExpectedRunTimeSec",
    "computeWorkerRemainingTtlSec",
    "computeTtlPreWarmAllowance",
    "evaluateJobBudgetCap",
    "appendMetricSeriesSample",
    "evaluateProblemNodeQuarantine",
    "slicePreviewContent",
    "evaluateDueScheduledActions",
    "incrementVersionToken",
    "buildClonedJobRule",
    "diffJobRules",
    "generateJobExperimentReport",
    "aggregateJsonlMetrics",
    "computeNextAutoSpawnEligibility",
    "getJobContainerPrefix",
    "doesRunMatchJob",
    "doesRunMatchSiteJobs",
    "computeJobTargetMetrics",
    "computeAdjustedTargetsAfterSlotDelete",
    "readJsonBody",
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
    Error,
    Promise,
    Infinity,
    decodeURIComponent,
    structuredClone,
    fs,
    path,
    process,
    console: { log() {}, warn() {}, error() {} },
    MAX_JSON_BODY_BYTES: 5 * 1024 * 1024,
    atomicStateWriteSeq: 0,
    currentSite: "n9",
    mockOwner: "admin",
    rawState: { sites: { n9: { id: "n9" }, n6: { id: "n6" } } },
    state: { jobs: [] },
    inFlightJobReservations: new Map(),
    getCurrentSiteId: () => context.currentSite,
    getSiteGpuModel: (sid) => (sid === "n6" ? "A100" : "H100"),
    resolveCurrentUserName: () => context.mockOwner || "admin",
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
  const fnNames = [
    "escapeHtml",
    "escapeJsStr",
    "parseSlotSpecToRunIds",
    "classifyUiRunStatus",
    "parseQuickPaletteCommand",
    "renderSvgPolyline",
  ];
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

  test("TC-29: `toSafeInt` / `toSafeNum` 비정상 입력(`NaN`, 빈문자열, 객체) 방어 및 스케줄러 파라미터 보호", () => {
    assert.equal(srv.toSafeInt("abc", 48, 1, 9999), 48, "숫자가 아닌 문자열 입력 시 기존 설정값(48) 유지");
    assert.equal(srv.toSafeInt("", 48, 1, 9999), 48, "빈 문자열 입력 시 1로 초기화되지 않고 기존 설정값(48) 유지");
    assert.equal(srv.toSafeInt(NaN, 15, 1, 86400), 15, "NaN 입력 시 폴백값(15) 유지");
    assert.equal(srv.toSafeInt({}, 300, 1, 86400), 300, "객체 입력 시 폴백값(300) 유지");
    assert.equal(srv.toSafeInt("0", 5, 0, 9999), 0, "명시적 '0' 입력(Pending 해제)은 0으로 정확히 반영");
    assert.equal(srv.toSafeInt(-10, 48, 1, 9999), 1, "하한 미만 음수는 최솟값(1)으로 클램핑");

    const metrics = srv.computeJobTargetMetrics({
      minConcurrentRuns: "not-a-number",
      targetPendingRuns: "bad",
      coreCount: "",
      runningCount: "nan",
      pendingCount: null,
    });
    assert.equal(Number.isNaN(metrics.targetCount), false);
    assert.equal(Number.isNaN(metrics.deficit), false);
    assert.equal(metrics.targetCount, 1);
  });

  test("TC-30: 멀티테넌트 그룹(`SR-Coredata`) 동명 프리픽스 컨테이너에 대한 소유권 격리(`isRunOwnedByUser`) 검증", () => {
    const prevOwner = srv.mockOwner;
    try {
      srv.mockOwner = "minsoo3.kim";
      const jobV8 = { id: "job-v8", name: "v8", siteId: "n9" };
      const myRun = { id: 901, name: "v8-s1-1234", userId: "minsoo3.kim", status: "Running" };
      const colleagueSamePrefixRun = { id: 902, name: "v8-colleague-exp", userId: "other.researcher", status: "Running" };
      const optimisticRunWithoutUser = { id: 903, name: "v8-s2-1235", status: "Pending" };

      assert.equal(srv.doesRunMatchJob(myRun, jobV8, [jobV8]), true, "내 계정의 v8 컨테이너는 정상 매칭되어야 함");
      assert.equal(
        srv.doesRunMatchJob(colleagueSamePrefixRun, jobV8, [jobV8]),
        false,
        "타 연구원이 우연히 v8- 프리픽스로 띄운 컨테이너는 내 규칙에 절대 매칭되면 안 됨"
      );
      assert.equal(
        srv.doesRunMatchJob(optimisticRunWithoutUser, jobV8, [jobV8]),
        true,
        "직후 생성된 낙관적 런(userId 미포함)은 정상 매칭되어야 함"
      );
    } finally {
      srv.mockOwner = prevOwner;
    }
  });

  test("TC-31: 원자적 `state.json` 저장(`writeStateFileAtomic`) 및 손상 시 `.bak` 자동 복구(`readStateJsonWithFallback`) 검증", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sgr-atomic-test-"));
    const testStatePath = path.join(tmpDir, "state.json");
    try {
      srv.writeStateFileAtomic(testStatePath, { version: 1, targetGpus: 120 });
      srv.writeStateFileAtomic(testStatePath, { version: 2, targetGpus: 192 });
      assert.equal(fs.existsSync(`${testStatePath}.bak`), true, "2회차 원자적 저장 시 직전 정상 상태의 .bak 백업이 생성되어야 함");

      // Simulate sudden power-loss / partial truncated JSON corruption on state.json
      fs.writeFileSync(testStatePath, '{"version": 3, "corrupted": ', "utf-8");
      const recovered = srv.readStateJsonWithFallback(testStatePath);
      assert.ok(recovered, "손상된 state.json 발견 시 .bak 백업으로부터 자동 복구되어야 함");
      assert.equal(recovered.version, 1, "백업된 직전 정상 스냅샷이 손실 없이 복원되어야 함");

      const restoredDisk = JSON.parse(fs.readFileSync(testStatePath, "utf-8"));
      assert.equal(restoredDisk.version, 1, "디스크의 손상된 state.json 파일도 정상 JSON으로 자동 복원되어야 함");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("TC-32: `readJsonBody` 멀티 청크 UTF-8 한글 보존, 잘못된 JSON `400`, 5MB 초과 페이로드 `413` 및 스트림 즉시 차단 검증", async () => {
    // 1. Multi-chunk split inside 3-byte UTF-8 Korean characters
    const payloadObj = { name: "목표GPU자동할당규칙", cmd: "echo 한글테스트 완료" };
    const fullBuf = Buffer.from(JSON.stringify(payloadObj), "utf-8");
    const splitIdx = fullBuf.indexOf(Buffer.from("표", "utf-8")) + 1; // split right in the middle of a 3-byte UTF-8 sequence!
    const reqUtf8 = new EventEmitter();
    reqUtf8.destroy = () => {};
    const p1 = srv.readJsonBody(reqUtf8);
    reqUtf8.emit("data", fullBuf.subarray(0, splitIdx));
    reqUtf8.emit("data", fullBuf.subarray(splitIdx));
    reqUtf8.emit("end");
    const parsedUtf8 = await p1;
    assert.equal(parsedUtf8.name, payloadObj.name, "TCP 패킷 경계에서 쪼개진 한글 UTF-8 바이트가 깨짐(U+FFFD) 없이 복원되어야 함");
    assert.equal(parsedUtf8.cmd, payloadObj.cmd);

    // 2. Malformed JSON -> statusCode 400
    const reqBad = new EventEmitter();
    reqBad.destroy = () => {};
    const p2 = srv.readJsonBody(reqBad);
    reqBad.emit("data", Buffer.from("{bad json", "utf-8"));
    reqBad.emit("end");
    await assert.rejects(p2, (err) => err.statusCode === 400 && err.message === "Invalid JSON body");

    // 3. > 5MB payload -> statusCode 413 + immediate req.destroy()
    let destroyed = false;
    const reqHuge = new EventEmitter();
    reqHuge.destroy = () => {
      destroyed = true;
    };
    const p3 = srv.readJsonBody(reqHuge);
    reqHuge.emit("data", Buffer.alloc(5 * 1024 * 1024 + 1024, 0x61));
    await assert.rejects(p3, (err) => err.statusCode === 413 && err.message === "Payload too large");
    assert.equal(destroyed, true, "5MB 초과 스트림 수신 즉시 req.destroy()를 호출해 OOM을 차단해야 함");
  });

  test("TC-33: `targetPendingRuns > 0` 상태에서 총 목표(`minConcurrentRuns`) 도달 시 스케줄러 무한 틱 폭주 방지 및 토큰 갱신 타임아웃 검증", () => {
    // Verify `refreshAccessToken` has `AbortSignal.timeout` so singleflight token refresh can never deadlock forever
    const refreshFnSrc = extractFunctionSource(serverSrc, "refreshAccessToken");
    assert.match(refreshFnSrc, /AbortSignal\.timeout\(\s*\d+\s*\)/, "refreshAccessToken fetch에 AbortSignal.timeout이 적용되어야 함");

    // Verify `setInterval` loop uses `computeJobTargetMetrics` instead of `matchingPending.length < targetPending`
    assert.equal(
      serverSrc.includes("targetPending > 0 ? matchingPending.length < targetPending : matchingActive.length < minConcurrent"),
      false,
      "setInterval 루프에 총 목표 상한을 무시하는 구형 hasDeficit 식이 남아있으면 안 됨"
    );
    const cappedMetrics = srv.computeJobTargetMetrics({
      minConcurrentRuns: 48,
      targetPendingRuns: 5,
      coreCount: 4,
      runningCount: 45,
      pendingCount: 3,
      inFlightCount: 0,
    });
    assert.equal(cappedMetrics.deficit, 0, "45 Running + 3 Pending = 48 Active 도달 시 targetPending=5여도 deficit=0이어야 함");
  });

  test("TC-34: 프론트엔드(`public/app.js` & `public/index.html`) 미정의 함수 호출(`renderSiteSelectorBar` 등) 부재 및 타유저 슬롯 보호 검증", () => {
    assert.equal(
      appJsSrc.includes("renderSiteSelectorBar"),
      false,
      "loadSpaceRuns()를 크래시시키던 미정의 renderSiteSelectorBar 호출이 존재하면 안 됨"
    );
    assert.equal(
      appJsSrc.includes("syncSitesListFromServer(data.sites)"),
      true,
      "loadSpaceRuns 및 loadServerState는 syncSitesListFromServer를 통해 멀티사이트 바를 안전 갱신해야 함"
    );
    assert.equal(
      appJsSrc.includes("🔒보호"),
      true,
      "언매칭 타유저 워크로드 슬롯에는 Kill 버튼 대신 🔒보호 배지가 표시되어야 함"
    );
  });

  test("TC-35: 라이브 API 라우트에 깨진 URI(`DELETE /api/presets/%E0%A4%A`) 및 잘못된 JSON 전송 시 `500` 대신 `400`으로 안전 처리", async (t) => {
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 스킵");
    const targetUrl = new URL(BASE_URL);
    const codeBadDelete = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: targetUrl.hostname,
          port: Number(targetUrl.port || 4300),
          method: "DELETE",
          path: "/api/presets/%E0%A4%A",
          headers: {
            Host: `${targetUrl.hostname}:${targetUrl.port || 4300}`,
            "X-Admin-Password": ADMIN_PW,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(codeBadDelete, 400, "깨진 퍼센트 인코딩 API 경로는 URIError(500) 대신 400을 반환해야 함");

    const badJsonRes = await fetch(`${BASE_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-json",
    });
    assert.equal(badJsonRes.status, 400, "잘못된 JSON 본문은 500 대신 400을 반환해야 함");
  });

  test("TC-36: `resolveSfmFilePaths` `/user-volume/...` 경로 훼손 방지 및 복수 스크립트 자동 동기화 조건 검증", () => {
    // 1. `/user-volume/...` must NEVER be mangled into `/group-volume/user-volume/...`
    const u1 = srv.resolveSfmFilePaths(
      "/user-volume/offpolicy-misranking/scripts/run_v8_nodes.sh",
      "SR-Coredata",
      "userA"
    );
    assert.equal(u1.volumeType, "user");
    assert.equal(u1.containerPath, "/user-volume/offpolicy-misranking/scripts/run_v8_nodes.sh");
    assert.equal(u1.viewerFilePath, "/SR-Coredata/user/offpolicy-misranking/scripts/run_v8_nodes.sh");
    assert.equal(u1.onedataViewerPath, "/users/userA/offpolicy-misranking/scripts/run_v8_nodes.sh");
    assert.equal(u1.sfmPath, "/user-volume/offpolicy-misranking/scripts/run_v8_nodes.sh");

    // 2. `/users/<user>/...` DataViewer path maps cleanly to `/user-volume/...`
    const u2 = srv.resolveSfmFilePaths("/users/userA/work/train.py", "", "userA");
    assert.equal(u2.volumeType, "user");
    assert.equal(u2.containerPath, "/user-volume/work/train.py");
    assert.equal(u2.viewerFilePath, "/users/userA/work/train.py");

    // 3. `/group-volume/...` and `/groups/<grp>/...` map cleanly to `/group-volume/...`
    const g1 = srv.resolveSfmFilePaths("/group-volume/exp/run.sh", "SR-Coredata", "userA");
    assert.equal(g1.volumeType, "group");
    assert.equal(g1.containerPath, "/group-volume/exp/run.sh");
    assert.equal(g1.viewerFilePath, "/SR-Coredata/group/exp/run.sh");
    assert.equal(g1.onedataViewerPath, "/groups/SR-Coredata/exp/run.sh");

    const g2 = srv.resolveSfmFilePaths("/groups/SR-Coredata/exp/eval.sh", "SR-Coredata", "userA");
    assert.equal(g2.volumeType, "group");
    assert.equal(g2.containerPath, "/group-volume/exp/eval.sh");

    // 4. `buildRunPayload` must check per-script `> "${scriptPath}"` instead of global `"base64 -d >"`
    assert.equal(
      serverSrc.includes('!executionCommand.includes("base64 -d >")'),
      false,
      "단일 base64 검사로 두 번째 편집 스크립트 동기화를 막는 구형 조건이 남아있으면 안 됨"
    );
    assert.equal(
      serverSrc.includes('!executionCommand.includes(`> "${scriptPath}"`)'),
      true,
      "스크립트 경로별 중복 주입 방지 조건이 적용되어야 함"
    );
  });

  test("TC-37: `isGenuineBadNodeFailureRun` 수동 종료·취소·선점(Preempted) 오탐 차단 및 실제 조기 크래시만 감지 검증", () => {
    const nowIso = new Date().toISOString();
    const startIso = new Date(Date.now() - 20_000).toISOString();
    const recentTermMap = new Map([["9001", Date.now()]]);

    // Intentional stops / cancellations / Spot preemptions must NEVER trigger Bad-Node Guard
    for (const nonCrashStatus of [
      "STOPPED",
      "KILLED",
      "TERMINATED",
      "CANCELED",
      "CANCELLED",
      "REJECTED",
      "PREEMPTED",
      "EVICTED",
      "RUNNING",
      "SUCCEEDED",
    ]) {
      assert.equal(
        srv.isGenuineBadNodeFailureRun({ id: "8001", status: nonCrashStatus, startTime: startIso, endTime: nowIso }, recentTermMap),
        false,
        `${nonCrashStatus} 상태는 불량 노드 하드웨어/런타임 크래시로 오탐하면 안 됨`
      );
    }

    // Runs terminated by our own controller (`recentlyTerminatedRunsMap`) must NEVER trigger Bad-Node Guard even if SPACE reports FAILED
    assert.equal(
      srv.isGenuineBadNodeFailureRun({ id: "9001", status: "FAILED", startTime: startIso, endTime: nowIso }, recentTermMap),
      false,
      "서버가 직접 종료 요청한 Run ID는 FAILED로 보고되더라도 불량 노드로 오탐하면 안 됨"
    );

    // Runs that never started (`startTime` missing) must not be treated as node runtime crashes
    assert.equal(
      srv.isGenuineBadNodeFailureRun({ id: "9002", status: "FAILED", startTime: null, endTime: nowIso }, recentTermMap),
      false,
      "startTime이 없는 런은 노드 런타임 조기 크래시로 오탐하면 안 됨"
    );

    // Genuine rapid runtime crashes (`FAILED`, `ERROR`, `OOM`, `CRASH`) must be detected
    for (const crashStatus of ["FAILED", "ERROR", "OOMKilled", "CRASH"]) {
      assert.equal(
        srv.isGenuineBadNodeFailureRun({ id: "9003", status: crashStatus, startTime: startIso, endTime: nowIso }, recentTermMap),
        true,
        `실제 조기 실패 상태(${crashStatus})는 정상 감지되어야 함`
      );
    }
  });

  test("TC-38: 멀티 사이트 프로필 갱신(`mergeSiteProfileUpdate`) 시 `schedulerEnabled` · `autoApprovalScope` 유실 방지 검증", () => {
    const existingN6 = {
      id: "n6",
      name: "SPACE N6 (A100 클러스터)",
      gpuModel: "A100",
      accessToken: "existing-access-token",
      refreshToken: "existing-refresh-token",
      groupId: "SR-Coredata",
      userName: "researcher1",
      schedulerEnabled: false,
      autoApprovalScope: "my_runs",
      customNote: "keep-me",
    };

    const updated = srv.mergeSiteProfileUpdate("n6", { name: "SPACE N6 Updated" }, existingN6);
    assert.equal(updated.name, "SPACE N6 Updated");
    assert.equal(updated.gpuModel, "A100");
    assert.equal(updated.accessToken, "existing-access-token");
    assert.equal(updated.schedulerEnabled, false, "사이트 프로필 수정 시 기존 schedulerEnabled=false 설정이 초기화되면 안 됨");
    assert.equal(updated.autoApprovalScope, "my_runs", "사이트 프로필 수정 시 기존 autoApprovalScope 설정이 초기화되면 안 됨");
    assert.equal(updated.customNote, "keep-me", "기존 확장 필드가 유실되면 안 됨");
  });

  test("TC-39: 프론트엔드 슬롯 툴바 규칙 범위(`jobId`), 슬롯 차감 시 총 GPU 입력 동기화, 하드코딩 계정명 제거 검증", () => {
    // 1. `selectSpaceSite` inline handlers use `escapeJsStr`
    assert.equal(
      appJsSrc.includes("selectSpaceSite('${escapeHtml("),
      false,
      "인라인 JS 문자열 내부에 escapeHtml만 단독 사용한 selectSpaceSite 핸들러가 남아있으면 안 됨"
    );
    // 2. Per-rule slot toolbar `stop_pending` & `stop_all` pass `{ jobId: ... }`
    assert.match(
      appJsSrc,
      /bulkControlWorkers\('stop_pending',\s*\{\s*jobId:/,
      "슬롯 관리 바의 Pending 전체 취소는 현재 선택된 규칙 jobId 범위로 제한되어야 함"
    );
    assert.match(
      appJsSrc,
      /bulkControlWorkers\('stop_all',\s*\{\s*jobId:/,
      "슬롯 관리 바의 전체 워커 종료는 현재 선택된 규칙 jobId 범위로 제한되어야 함"
    );
    // 3. `killSingleWorkerSlot` and `executeSelectedWorkersKill` sync total GPU & quick target inputs on `-1` target reduction
    const killSingleSrc = extractFunctionSource(appJsSrc, "killSingleWorkerSlot");
    const execSelectedSrc = extractFunctionSource(appJsSrc, "executeSelectedWorkersKill");
    assert.equal(
      killSingleSrc.includes("syncAllQuickTargetInputsDom("),
      true,
      "개별 슬롯 -1 영구 삭제 시 목표 총 GPU 및 빠른 입력칸이 즉시 동기화되어야 함"
    );
    assert.equal(
      execSelectedSrc.includes("syncAllQuickTargetInputsDom("),
      true,
      "선택 슬롯 영구 삭제 시 목표 총 GPU 및 빠른 입력칸이 즉시 동기화되어야 함"
    );
    // 4. Hardcoded fallback username removed from `loadApprovals`
    assert.equal(
      appJsSrc.includes('"minsoo3.kim"'),
      false,
      "승인 내역 테이블에 특정 사용자 아이디가 하드코딩되어 있으면 안 됨"
    );
    // 5. Quick log viewer jump scrolls directly to log viewer section
    assert.equal(
      indexHtmlSrc.includes("switchMainView('workloads', 'log')"),
      true,
      "모니터링 빠른 로그 카드의 크게 보기 버튼은 switchMainView('workloads', 'log')를 호출해야 함"
    );
  });

  test("TC-40: 라이브 정적 에셋(`/style.css?v=8`, `/app.js?v=30`) 및 `/api/state` 응답 무결성 검증", async (t) => {
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 스킵");
    const [htmlRes, cssRes, jsRes, stateRes] = await Promise.all([
      fetch(`${BASE_URL}/`),
      fetch(`${BASE_URL}/style.css?v=8`),
      fetch(`${BASE_URL}/app.js?v=30`),
      fetch(`${BASE_URL}/api/state`, { headers: { "X-Admin-Password": ADMIN_PW } }),
    ]);
    assert.equal(htmlRes.status, 200);
    assert.equal(cssRes.status, 200);
    assert.equal(jsRes.status, 200);
    assert.equal(stateRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.equal(htmlText.includes("/app.js?v=30"), true, "라이브 index.html이 최신 캐시버전 app.js?v=30을 서빙해야 함");
    const stateJson = await stateRes.json();
    assert.equal(typeof stateJson.activeSiteId, "string");
    assert.equal(Array.isArray(stateJson.jobs), true);
  });

  test("TC-41: `shouldWatchdogTerminateNonRunningRun` FIFO 클러스터 대기열(`Pending`) 순번 보존 및 진짜 컨테이너 생성 먹통(`Creating`)만 종료 검증", () => {
    const nowMs = Date.now();
    const eightHoursAgoIso = new Date(nowMs - 8 * 60 * 60 * 1000).toISOString();
    const thirtyMinAgoIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
    const pendingQueueJob = { id: "job-v8", name: "v8", targetPendingRuns: 6 };
    const normalJob = { id: "job-std", name: "worker-std", targetPendingRuns: 0 };

    // 1. Workers in FIFO cluster queue (`Pending` / `Queued` / `Approved` / `Scheduled`) must NOT lose 8 hours of queue seniority!
    for (const qState of ["Pending", "Queued", "Approved", "Scheduled", "Waiting"]) {
      const resQueue = srv.shouldWatchdogTerminateNonRunningRun(
        { id: "368273", status: qState, registerTime: eightHoursAgoIso },
        pendingQueueJob,
        nowMs,
        20,
        false
      );
      assert.equal(resQueue.terminate, false, `${qState} 대기열 워커는 8시간 대기 중이어도 큐 순번 보존을 위해 강제 종료하면 안 됨`);

      const resStdQueue = srv.shouldWatchdogTerminateNonRunningRun(
        { id: "368274", status: qState, registerTime: eightHoursAgoIso },
        normalJob,
        nowMs,
        20,
        false
      );
      assert.equal(resStdQueue.terminate, false, `기본 정책(recycleQueuePending=false)에서 정상 ${qState} 대기열 워커를 종료하면 안 됨`);
    }

    // 2. Genuinely stuck container initialization states (`Creating`, `ContainerCreating`, `Initializing`, `Pulling`) MUST be replaced!
    for (const stuckState of ["Creating", "ContainerCreating", "Initializing", "ImagePulling", "Starting"]) {
      const resStuck = srv.shouldWatchdogTerminateNonRunningRun(
        { id: "369001", status: stuckState, registerTime: thirtyMinAgoIso },
        pendingQueueJob,
        nowMs,
        20,
        false
      );
      assert.equal(resStuck.terminate, true, `${stuckState} 상태에서 30분째 멈춘 컨테이너는 좀비로 감지해 교체해야 함`);
    }
  });

  test("TC-42: `shouldAlertAccessTokenExpiring` Refresh Token 정상 시 15분 주기 오탐 알림 차단 및 5xx 게이트웨이 백오프 검증", () => {
    const nowMs = Date.now();
    const makeJwtToken = (expSecFromNow) => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(nowMs / 1000) + expSecFromNow })).toString("base64url");
      return `${header}.${payload}.sig`;
    };

    const healthyRefresh = makeJwtToken(6 * 3600); // 6h remaining on Refresh Token
    const expiringRefresh = makeJwtToken(20 * 60); // 20m remaining on Refresh Token

    // 1. Access Token has 27m or 13m left, Refresh Token is healthy -> NO false-alarm alert!
    const at27m = srv.shouldAlertAccessTokenExpiring({
      accessJwt: { exp: Math.floor(nowMs / 1000) + 27 * 60 },
      refreshToken: healthyRefresh,
      lastDeadRefreshToken: "",
      nowMs,
    });
    assert.equal(at27m.shouldAlert, false, "Refresh Token이 유효할 때 27분 남은 Access Token으로 오탐 경고를 띄우면 안 됨");
    assert.equal(at27m.shouldProactiveRefresh, false);

    // 2. Access Token has 4m left (<= 300s), Refresh Token is healthy -> trigger proactive refresh without spamming alert!
    const at4m = srv.shouldAlertAccessTokenExpiring({
      accessJwt: { exp: Math.floor(nowMs / 1000) + 240 },
      refreshToken: healthyRefresh,
      lastDeadRefreshToken: "",
      nowMs,
    });
    assert.equal(at4m.shouldAlert, false, "선제 자동 갱신 구간(4분 남음)에서는 갱신을 먼저 수행하고 오탐 알림을 보내지 않아야 함");
    assert.equal(at4m.shouldProactiveRefresh, true, "만료 5분 이하 진입 시 선제 토큰 자동 갱신 플래그가 켜져야 함");

    // 3. Refresh Token itself has 20m left -> SHOULD alert about Refresh session expiry!
    const rtExp = srv.shouldAlertAccessTokenExpiring({
      accessJwt: { exp: Math.floor(nowMs / 1000) + 15 * 60 },
      refreshToken: expiringRefresh,
      lastDeadRefreshToken: "",
      nowMs,
    });
    assert.equal(rtExp.shouldAlert, true);
    assert.equal(rtExp.reason, "refresh_token_expiring");

    // 4. No Refresh Token at all & Access Token has 20m left -> SHOULD alert!
    const noRt = srv.shouldAlertAccessTokenExpiring({
      accessJwt: { exp: Math.floor(nowMs / 1000) + 20 * 60 },
      refreshToken: "",
      lastDeadRefreshToken: "",
      nowMs,
    });
    assert.equal(noRt.shouldAlert, true);
    assert.equal(noRt.reason, "no_refresh_token");

    // 5. Verify `refreshAccessToken` implements `refreshBackoffUntilMs` so HTTP 503 gateway blips never hammer `/api/acm/token`
    const refreshFnSrc = extractFunctionSource(serverSrc, "refreshAccessToken");
    assert.equal(
      refreshFnSrc.includes("refreshBackoffUntilMs"),
      true,
      "refreshAccessToken에 5xx/네트워크 오류 백오프(refreshBackoffUntilMs)가 적용되어야 함"
    );
  });

  test("TC-43: `shouldAutoApproveItem` 공유 그룹(`SR-Coredata`) 내 접두사 하이픈 경계 및 소유자 검증, `job.lastStatus` 덮어쓰기 방지 검증", () => {
    const jobs = [{ id: "job-v8", name: "v8", autoApprove: true }];
    const trackedIds = new Set(["370327"]);

    // 1. Colleague's run with similar prefix (`v80-colleague` or `v8-colleague`) MUST NOT be auto-approved under `my_runs` or `job_only`!
    assert.equal(
      srv.shouldAutoApproveItem(
        { id: "app-1", runId: "99901", runName: "v80-colleague-01", userId: "colleague.park" },
        { scope: "my_runs", currentUser: "minsoo3.kim", jobs, trackedRunIds: trackedIds }
      ),
      false,
      "접두사 하이픈 경계가 다른 타유저 런(v80-...)을 자동 승인하면 안 됨"
    );
    assert.equal(
      srv.shouldAutoApproveItem(
        { id: "app-2", runId: "99902", runName: "v8-s01-1123", userId: "colleague.park" },
        { scope: "my_runs", currentUser: "minsoo3.kim", jobs, trackedRunIds: trackedIds }
      ),
      false,
      "my_runs 범위에서 타유저 소유의 동명 프리픽스 런을 자동 승인하면 안 됨"
    );

    // 2. Own rule run (`v8-s07-1123`, `minsoo3.kim`) MUST be auto-approved
    assert.equal(
      srv.shouldAutoApproveItem(
        { id: "app-3", runId: "99903", runName: "v8-s07-1123", userId: "minsoo3.kim" },
        { scope: "job_only", currentUser: "minsoo3.kim", jobs, trackedRunIds: trackedIds }
      ),
      true,
      "내 계정의 규칙 매칭 런은 job_only 범위에서도 즉시 자동 승인되어야 함"
    );

    // 3. `processPendingApprovals` must only overwrite `job.lastStatus` when `job.lastStatus.includes("승인 추적 중")`
    const procAppSrc = extractFunctionSource(serverSrc, "processPendingApprovals");
    assert.equal(
      procAppSrc.includes('job.lastStatus.includes("승인 추적 중")'),
      true,
      "processPendingApprovals가 스케줄러의 정상 목표 유지 상태(lastStatus)를 덮어쓰지 않도록 승인 추적 중일 때만 갱신해야 함"
    );
  });

  test("TC-44: 규칙 명령어 수정 시 파이프라인 `_stage2Transitioned` 리셋 및 사이트 전환 시 빠른 로그 초기화 검증", () => {
    assert.equal(
      serverSrc.includes('String(body.executionCommand).trim() !== String(existingJob.executionCommand || "").trim()'),
      true,
      "실행 명령어 변경 시 Stage 2 전환 플래그(_stage2Transitioned)가 자동 초기화되어야 함"
    );
    const selectSiteSrc = extractFunctionSource(appJsSrc, "selectSpaceSite");
    assert.equal(
      selectSiteSrc.includes("closeMonitorQuickLog"),
      true,
      "사이트 전환(N9 <-> N6) 시 이전 사이트의 빠른 로그 프리뷰 창을 닫아야 함"
    );
  });

  test("TC-45: [Feature 1] `evaluateSilentHangState` 조용한 먹통(Silent Hang) 감지 및 로그 변화 시 즉시 해제 검증", () => {
    const t0 = Date.parse("2026-11-23T08:00:00.000Z");
    const startIso = "2026-11-23T07:50:00.000Z";

    // Initial scan: records signature, stalledMinutes = 0
    const s1 = srv.evaluateSilentHangState(null, "Step 10/100 loss=0.45\n", startIso, t0, 45);
    assert.equal(s1.isSilentHang, false);
    assert.equal(s1.stalledMinutes, 0);

    // 20m later with identical log -> stalledMinutes = 20 (< 45m), NOT silent hang yet
    const s2 = srv.evaluateSilentHangState(s1, "Step 10/100 loss=0.45\n", startIso, t0 + 20 * 60_000, 45);
    assert.equal(s2.stalledMinutes, 20);
    assert.equal(s2.isSilentHang, false);

    // 50m later with identical log -> stalledMinutes = 50 (>= 45m) -> IS silent hang!
    const s3 = srv.evaluateSilentHangState(s2, "Step 10/100 loss=0.45\n", startIso, t0 + 50 * 60_000, 45);
    assert.equal(s3.stalledMinutes, 50);
    assert.equal(s3.isSilentHang, true);

    // New log line arrives at 51m -> immediately resets `isSilentHang = false` and `stalledMinutes = 0`!
    const s4 = srv.evaluateSilentHangState(s3, "Step 10/100 loss=0.45\nStep 11/100 loss=0.42\n", startIso, t0 + 51 * 60_000, 45);
    assert.equal(s4.stalledMinutes, 0);
    assert.equal(s4.isSilentHang, false);
  });

  test("TC-46: [Feature 2] `computeEffectiveJobBudget` 무중단 세대교체(Graceful Drain) 및 후속 실험 큐 슬롯 인계 검증", () => {
    const jobV8 = {
      id: "job-v8",
      name: "v8",
      enabled: true,
      draining: true,
      drainNextJobId: "job-v9",
      drainSharedCap: 50,
      minConcurrentRuns: 50,
      targetPendingRuns: 6,
    };
    const jobV9 = {
      id: "job-v9",
      name: "v9",
      enabled: true,
      draining: false,
      minConcurrentRuns: 50,
      targetPendingRuns: 4,
    };
    const allJobs = [jobV8, jobV9];

    // Step A: v8 still has 50 Running -> v8 stops new spawns (effectiveMinConcurrent=50, pending=0), v9 waits at 0
    const bV8_50 = srv.computeEffectiveJobBudget(jobV8, allJobs, { "job-v8": 50, "job-v9": 0 });
    const bV9_50 = srv.computeEffectiveJobBudget(jobV9, allJobs, { "job-v8": 50, "job-v9": 0 });
    assert.equal(bV8_50.isDraining, true);
    assert.equal(bV8_50.drainCompleted, false);
    assert.equal(bV8_50.effectiveTargetPending, 0);
    assert.equal(bV9_50.waitingOnDrainJobId, "job-v8");
    assert.equal(bV9_50.effectiveMinConcurrent, 0, "선행 규칙이 50개 전부 가동 중일 때 후속 규칙은 총 한도를 넘지 않고 대기해야 함");

    // Step B: 12 v8 workers finish naturally (v8=38 Running) -> v9 automatically gets 12 slots!
    const bV9_38 = srv.computeEffectiveJobBudget(jobV9, allJobs, { "job-v8": 38, "job-v9": 5 });
    assert.equal(bV9_38.effectiveMinConcurrent, 12, "반납된 12개 슬롯만큼 후속 규칙 v9가 즉시 인계받아야 함");
    assert.equal(bV9_38.effectiveTargetPending, 4);

    // Step C: All v8 workers finish (v8=0 Running) -> v8 drainCompleted=true, v9 gets full 50 slots!
    const bV8_0 = srv.computeEffectiveJobBudget(jobV8, allJobs, { "job-v8": 0, "job-v9": 38 });
    const bV9_0 = srv.computeEffectiveJobBudget(jobV9, allJobs, { "job-v8": 0, "job-v9": 38 });
    assert.equal(bV8_0.drainCompleted, true);
    assert.equal(bV9_0.effectiveMinConcurrent, 50);
  });

  test("TC-47: [Feature 3] 원클릭 북마클릿(`bookmarkletSyncKey` & `POST /api/tokens/bookmarklet-sync`) 인증 및 보안 검증", async (t) => {
    assert.equal(indexHtmlSrc.includes('id="spaceTokenBookmarkletLink"'), true);
    assert.equal(appJsSrc.includes("handleIncomingBookmarkletHashSync"), true);

    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 라이브 북마클릿 엔드포인트 스킵");

    // Invalid syncKey must be rejected with 401
    const badRes = await fetch(`${BASE_URL}/api/tokens/bookmarklet-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncKey: "wrong-key", accessToken: "dummy" }),
    });
    assert.equal(badRes.status, 401, "잘못된 syncKey 요청은 401로 차단되어야 함");

    // Authenticated `/api/state` must expose `config.bookmarkletSyncKey` (28-char hex)
    const stRes = await fetch(`${BASE_URL}/api/state`, { headers: { "X-Admin-Password": ADMIN_PW } });
    const stJson = await stRes.json();
    assert.equal(typeof stJson.config?.bookmarkletSyncKey, "string");
    assert.equal(stJson.config.bookmarkletSyncKey.length, 28);
  });

  test("TC-48: [Feature 4] `searchWorkerLogLines` 및 `POST /api/space/runs/log-grep` 전체 워커 로그 통합 검색 검증", async (t) => {
    const sampleLog = [
      "[2026-11-23 19:00:01] Starting on gpu-node-h100-07",
      "Epoch 1/5 | Step 100/500 | loss=0.3120 | 2.40 it/s",
      "Saved checkpoint to /user-volume/offpolicy-misranking/ckpt/step_100.pt",
      "Epoch 1/5 | Step 200/500 | loss=0.2810 | 2.45 it/s",
    ].join("\n");

    const plainHit = srv.searchWorkerLogLines(sampleLog, { query: "saved checkpoint", isRegex: false, caseSensitive: false });
    assert.equal(plainHit.matchCount, 1);
    assert.equal(plainHit.matches[0].lineNumber, 3);

    const regexHit = srv.searchWorkerLogLines(sampleLog, { query: "loss=0\\.(31|28)", isRegex: true });
    assert.equal(regexHit.matchCount, 2);

    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 라이브 로그 검색 API 스킵");

    // Invalid regex must safely return 400 (never 500 crash)
    const invalidRxRes = await fetch(`${BASE_URL}/api/space/runs/log-grep`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Password": ADMIN_PW },
      body: JSON.stringify({ query: "[unclosed-regex", isRegex: true }),
    });
    assert.equal(invalidRxRes.status, 400);
  });

  test("TC-49: [Feature 5] `detectStragglerWorkers` 느린 노드(Straggler) 감지, 처리량 합산 및 노드 호스트명 추출 검증", () => {
    assert.equal(
      srv.extractNodeIdentifierFromRunOrLog({}, "[SPACE Worker] Starting on n9-h100-dgx-14 (Slot: 2/50)"),
      "n9-h100-dgx-14"
    );
    assert.equal(
      srv.extractNodeIdentifierFromRunOrLog({ nodeName: "k8s-gpu-node-03" }, ""),
      "k8s-gpu-node-03"
    );

    const workers = [
      { id: "1", progress: { speedVal: 4.0, speedUnit: "it/s", loss: "0.20", isStraggler: false } },
      { id: "2", progress: { speedVal: 4.2, speedUnit: "it/s", loss: "0.22", isStraggler: false } },
      { id: "3", progress: { speedVal: 3.8, speedUnit: "it/s", loss: "0.18", isStraggler: false } },
      { id: "4", progress: { speedVal: 1.2, speedUnit: "it/s", loss: "0.24", isStraggler: false } }, // 0.3x of median 4.0 -> straggler!
    ];
    const summary = srv.detectStragglerWorkers(workers, 0.55);
    assert.equal(summary.stragglerCount, 1);
    assert.equal(summary.speedUnit, "it/s");
    assert.equal(summary.totalThroughput, 13.2);
    assert.equal(summary.avgLoss, 0.21);
    assert.equal(workers[3].progress.isStraggler, true);
    assert.equal(workers[3].progress.speedRatio, 0.31);
    assert.equal(workers[0].progress.isStraggler, false);
  });

  test("TC-50: [Feature 6] `isSpotPreemptedRun` 스팟 회수 감지 및 Slack/Discord/Telegram 다채널 웹훅 포맷 검증", () => {
    const recentTerm = new Map([["5001", Date.now()]]);
    assert.equal(srv.isSpotPreemptedRun({ id: "5001", status: "PREEMPTED" }, recentTerm), false, "직접 종료한 런은 스팟 회수로 집계하면 안 됨");
    assert.equal(srv.isSpotPreemptedRun({ id: "5002", status: "PREEMPTED" }, recentTerm), true);
    assert.equal(srv.isSpotPreemptedRun({ id: "5003", status: "STOPPED", reason: "Spot node evicted" }, recentTerm), true);
    assert.equal(srv.isSpotPreemptedRun({ id: "5004", status: "SUCCEEDED" }, recentTerm), false);

    const tg = srv.formatWebhookPayload("https://api.telegram.org/bot12345:ABC/sendMessage?chat_id=987654", {
      level: "warn",
      title: "스팟 회수 알림",
      message: "테스트 메시지",
    });
    assert.equal(tg.channel, "telegram");
    assert.equal(tg.body.chat_id, "987654");
    assert.equal(tg.body.text.includes("스팟 회수 알림"), true);

    const dc = srv.formatWebhookPayload("https://discord.com/api/webhooks/111/222", {
      level: "success",
      title: "목표 달성",
      message: "100워커 가동",
    });
    assert.equal(dc.channel, "discord");
    assert.equal(typeof dc.body.content, "string");

    const sl = srv.formatWebhookPayload("https://hooks.slack.com/services/T00/B00/XXX", {
      level: "info",
      title: "일일 리포트",
      message: "정상 가동 중",
    });
    assert.equal(sl.channel, "slack");
    assert.equal(typeof sl.body.text, "string");
  });

  test("TC-51: `isEligibleNewPreemptionEvent` 과거 이력 재집계 차단(2시간 이내 & 워터마크) 검증", () => {
    const nowMs = Date.parse("2026-11-26T01:20:00.000Z");
    const seen = new Set(["373421"]);

    // 1. Fresh preemption (5m ago) not yet seen -> eligible
    assert.equal(
      srv.isEligibleNewPreemptionEvent(
        { id: "373430", status: "Preempted", endTime: "2026-11-26T01:15:00.000Z" },
        { seenSet: seen, minWatermarkId: 371000, nowMs }
      ),
      true
    );
    // 2. Historical preemption from 2 days ago -> rejected so sliding window never re-counts old runs
    assert.equal(
      srv.isEligibleNewPreemptionEvent(
        { id: "370900", status: "Preempted", endTime: "2026-11-24T01:15:00.000Z" },
        { seenSet: seen, minWatermarkId: 371000, nowMs }
      ),
      false
    );
    // 3. Below watermark ID -> rejected even if endTime is missing
    assert.equal(
      srv.isEligibleNewPreemptionEvent(
        { id: "370500", status: "Preempted" },
        { seenSet: seen, minWatermarkId: 371000, nowMs }
      ),
      false
    );
  });

  test("TC-52: `shouldTriggerHybridPoolFallback` 게이트웨이 502/503/타임아웃 시 Spot➔Standard 오발동 차단 검증", () => {
    assert.equal(
      srv.shouldTriggerHybridPoolFallback(
        new Error("SPACE API Error [502] /api/wlm/v2/runs: An invalid response was received from the upstream server")
      ),
      false,
      "502 게이트웨이 오류 시 Spot 규칙을 Standard(On-Demand)로 폴백하면 안 됨"
    );
    assert.equal(
      srv.shouldTriggerHybridPoolFallback(new Error("SPACE API Error [503] /api/wlm/v2/runs: Service Unavailable")),
      false
    );
    assert.equal(
      srv.shouldTriggerHybridPoolFallback(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })),
      false
    );
    assert.equal(
      srv.shouldTriggerHybridPoolFallback(new Error("SPACE API Error [400] /api/wlm/v2/runs: insufficient spot quota")),
      true,
      "실제 풀/쿼터 부족 오류(400/409/422)에서는 하이브리드 폴백이 정상 동작해야 함"
    );
  });

  test("TC-53: `computeGlobalCapWorkerLimit` 사이트 통합 GPU 상한(`globalMaxGpus`) 및 우선순위(`priority`) 자동 양보 검증", () => {
    const jobV9 = { id: "job-v9", name: "v9", priority: 1, enabled: true, coreCount: 4, minConcurrentRuns: 80 };
    const jobV8 = { id: "job-v8", name: "v8", priority: 2, enabled: true, coreCount: 4, minConcurrentRuns: 30 };
    const allJobs = [jobV8, jobV9];

    // 1. globalMaxGpus = 0 -> unlimited (null)
    assert.equal(srv.computeGlobalCapWorkerLimit(jobV8, allJobs, { "job-v9": 92 }, 0), null);

    // 2. globalMaxGpus = 320G, v9(1순위) currently uses 92G (23W) -> v9 gets up to 80W, v8(2순위) gets floor((320-92)/4) = 57W
    assert.equal(srv.computeGlobalCapWorkerLimit(jobV9, allJobs, { "job-v9": 92, "job-v8": 24 }, 320), 80);
    assert.equal(srv.computeGlobalCapWorkerLimit(jobV8, allJobs, { "job-v9": 92, "job-v8": 24 }, 320), 57);

    // 3. v9 scales up to 280G (70W) -> v8 automatically yields to floor((320-280)/4) = 10W!
    assert.equal(srv.computeGlobalCapWorkerLimit(jobV8, allJobs, { "job-v9": 280, "job-v8": 40 }, 320), 10);

    // 4. v9 reaches full 320G (80W) -> v8 pauses new spawns (0W) without exceeding 320G!
    assert.equal(srv.computeGlobalCapWorkerLimit(jobV8, allJobs, { "job-v9": 320, "job-v8": 0 }, 320), 0);
  });

  test("TC-54: 멀티 규칙 활성 요약 바(`visibleMultiJobs`) 및 `systemd` 자동 재기동 스크립트(`scripts/manage-service.sh`) 검증", () => {
    assert.equal(appJsSrc.includes("활성 규칙 현황:"), true, "다중 규칙 동시 가동 시 모니터링 상단 요약 칩 바가 제공되어야 함");
    assert.equal(indexHtmlSrc.includes('id="cfgGlobalMaxGpus"'), true);
    assert.equal(indexHtmlSrc.includes('id="jobPriority"'), true);

    const svcScriptPath = path.join(ROOT_DIR, "scripts", "manage-service.sh");
    assert.equal(fs.existsSync(svcScriptPath), true, "systemd 관리 스크립트가 존재해야 함");
    assert.doesNotThrow(() => {
      execFileSync("bash", ["-n", svcScriptPath], { encoding: "utf-8" });
    });
  });

  test("TC-55: [Batch 4] `extractScriptPathsFromCommand` & `analyzeShellScriptIssues` 출발 전 스크립트 검증기(CRLF·BOM·Bashism) 검증", async (t) => {
    const paths = srv.extractScriptPathsFromCommand(
      "cd /user-volume/offpolicy-misranking && sh /user-volume/offpolicy-misranking/v9/run.sh && python3 /group-volume/eval.py"
    );
    assert.deepEqual([...paths], ["/user-volume/offpolicy-misranking/v9/run.sh", "/group-volume/eval.py"]);

    // CRLF detection (fatal on Linux containers)
    const crlfRes = srv.analyzeShellScriptIssues("#!/bin/bash\r\necho hello\r\n", "bash /group-volume/run.sh", "/group-volume/run.sh");
    assert.equal(crlfRes.ok, false);
    assert.equal(crlfRes.hasCrlf, true);
    assert.equal(crlfRes.issues.some((i) => i.code === "CRLF_LINE_ENDINGS"), true);

    // `sh` + bashism (`set -o pipefail` / `[[ ]]`) warning
    const bashismRes = srv.analyzeShellScriptIssues(
      "#!/usr/bin/env bash\nset -euo pipefail\nif [[ -f config.yaml ]]; then echo ok; fi\n",
      "sh /user-volume/offpolicy-misranking/v9/run.sh",
      "/user-volume/offpolicy-misranking/v9/run.sh"
    );
    assert.equal(bashismRes.ok, true);
    assert.equal(bashismRes.issues.some((i) => i.code === "SH_WITH_BASHISMS"), true);

    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 라이브 preflight API 스킵");
    const pfRes = await fetch(`${BASE_URL}/api/jobs/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Password": ADMIN_PW },
      body: JSON.stringify({ executionCommand: "echo preflight_ok" }),
    });
    assert.equal(pfRes.status, 200);
    const pfJson = await pfRes.json();
    assert.equal(Array.isArray(pfJson.checks), true);
  });

  test("TC-56: [Batch 4] `computeQueueAllocationVelocity` 최근 1시간 클러스터 노드 배정 속도 및 대기 중앙값 산출 검증", () => {
    const nowMs = Date.parse("2026-11-26T08:00:00.000Z");
    const jobs = [{ id: "j-v9", name: "v9", executionCommand: "sh /user-volume/v9/run.sh" }];
    const runs = [
      // Promoted 10m ago after 120s queue wait
      {
        id: "1",
        containerName: "v9-s01-1126",
        registerTime: "2026-11-26T07:48:00.000Z",
        startTime: "2026-11-26T07:50:00.000Z",
      },
      // Promoted 20m ago after 300s queue wait
      {
        id: "2",
        containerName: "v9-s02-1126",
        registerTime: "2026-11-26T07:35:00.000Z",
        startTime: "2026-11-26T07:40:00.000Z",
      },
      // Promoted 3 hours ago -> excluded from 1h velocity
      {
        id: "3",
        containerName: "v9-s03-1126",
        registerTime: "2026-11-26T04:50:00.000Z",
        startTime: "2026-11-26T05:00:00.000Z",
      },
    ];
    const vel = srv.computeQueueAllocationVelocity(runs, jobs, nowMs);
    assert.equal(vel.promotionsLast1h, 2);
    assert.equal(vel.avgWaitSec, 210);
    assert.equal(vel.medianWaitSec, 210);
  });

  test("TC-57: [Batch 4] `classifyFailureRootCause` 컨테이너 실패 원인 자동 부검 분류기(OOM·NCCL·경로·Python) 검증", async (t) => {
    assert.equal(
      srv.classifyFailureRootCause("torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB").category,
      "OOM_VRAM"
    );
    assert.equal(
      srv.classifyFailureRootCause("[E ProcessGroupNCCL.cpp:915] Watchdog caught collective operation timeout").category,
      "NCCL_COMM"
    );
    assert.equal(
      srv.classifyFailureRootCause("sh: /user-volume/v9/run.sh: /bin/bash^M: bad interpreter: No such file or directory").category,
      "FILE_OR_MOUNT"
    );
    assert.equal(
      srv.classifyFailureRootCause("Traceback (most recent call last):\n  File 'train.py', line 42\nKeyError: 'reward'").category,
      "PYTHON_EXCEPTION"
    );

    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 라이브 postmortem API 스킵");
    const pmRes = await fetch(`${BASE_URL}/api/space/runs/postmortem`, {
      headers: { "X-Admin-Password": ADMIN_PW },
    });
    assert.equal(pmRes.status, 200);
    const pmJson = await pmRes.json();
    assert.equal(Array.isArray(pmJson.items), true);
  });

  test("TC-58: [Batch 4] `sanitizeStateForBackup` 토큰 마스킹 백업 스냅샷 생성 및 라이브 내보내기 검증", async (t) => {
    const sampleState = {
      activeSiteId: "n9",
      config: { accessToken: "secret-jwt", refreshToken: "secret-rt", checkIntervalSec: 15 },
      sites: { n9: { id: "n9", accessToken: "site-jwt", refreshToken: "site-rt", groupId: "SR-Coredata" } },
      jobs: [{ id: "j1", name: "v9", minConcurrentRuns: 80, _knownPendingRunIds: ["1", "2"] }],
      presets: [{ id: "p1", name: "preset-80" }],
      scriptFiles: { "/user-volume/v9/run.sh": "echo hi" },
    };
    const snap = srv.sanitizeStateForBackup(sampleState, { includeTokens: false });
    assert.equal(snap.config.accessToken, undefined, "기본 백업에서는 accessToken이 제거되어야 함");
    assert.equal(snap.sites.n9.accessToken, "", "사이트 프로필에서도 토큰이 비워져야 함");
    assert.equal(snap.jobs[0]._knownPendingRunIds, undefined, "임시 런타임 배열은 백업에서 정리되어야 함");
    assert.equal(snap.jobs[0].minConcurrentRuns, 80);

    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 라이브 backup API 스킵");
    const bkRes = await fetch(`${BASE_URL}/api/backup/export?includeTokens=0`, {
      headers: { "X-Admin-Password": ADMIN_PW },
    });
    assert.equal(bkRes.status, 200);
    const bkJson = await bkRes.json();
    assert.equal(bkJson.backupFormat, "space-gpu-runner-v2.8");
    assert.equal(bkJson.config?.accessToken, undefined);
  });

  test("TC-59: [Batch 4] `isTransientGatewayCreateError` 502/503/504 일시 게이트웨이 오류 판별 검증", () => {
    assert.equal(
      srv.isTransientGatewayCreateError(
        new Error("SPACE API Error [502] /api/wlm/v2/runs: An invalid response was received from the upstream server")
      ),
      true
    );
    assert.equal(srv.isTransientGatewayCreateError(new Error("SPACE API Error [503] Service Unavailable")), true);
    assert.equal(
      srv.isTransientGatewayCreateError(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
      true
    );
    assert.equal(srv.isTransientGatewayCreateError(new Error("SPACE API Error [400] Bad Request")), false);
  });

  test("TC-60: [Batch 4] 규칙별 독립 GPU-Hours 적산(`jobGpuHours` / `dailyJobGpuHours`) 및 프론트엔드 표시 바인딩 검증", () => {
    assert.equal(serverSrc.includes("siteTel.dailyJobGpuHours[dateKey][jName]"), true);
    assert.equal(serverSrc.includes("jfItem.gpuHoursTotal = Number(telemetryStatus.jobGpuHours?.[jfItem.jobName] || 0)"), true);
    assert.equal(appJsSrc.includes("jf.gpuHoursTotal"), true);
  });

  test("TC-61: [Batch 5 - Feature 1] `reconcileTaskQueueProgress` & `pickNextTaskQueueItem` 상태 보존형 태스크 큐 자동 분배·재시도 검증", () => {
    const job = {
      id: "job-sweep",
      name: "v9-sweep",
      taskQueueItems: ["--seed 1", "--seed 2", "--seed 3", "--seed 4"],
      taskQueueCompletedIdx: [1],
      taskQueueRunMap: {},
    };
    const matchingRuns = [
      // Task 2 is currently RUNNING
      { id: "101", containerName: "v9-sweep-s01-t02-1127", status: "RUNNING" },
      // Task 3 was PREEMPTED (FAILED class) -> must automatically be re-queued!
      { id: "102", containerName: "v9-sweep-s02-t03-1127", status: "PREEMPTED" },
      // Task 4 just SUCCEEDED -> must be folded into completedIndices!
      { id: "103", containerName: "v9-sweep-s03-t04-1127", status: "SUCCEEDED" },
    ];
    const prog = srv.reconcileTaskQueueProgress(job, matchingRuns);
    assert.deepEqual([...prog.completedIndices], [1, 4], "기존 완료(1)와 신규 SUCCEEDED(4)가 합산되어야 함");
    assert.deepEqual([...prog.activeIndices], [2], "현재 RUNNING 중인 태스크(2)는 active로 분류되어야 함");
    assert.deepEqual([...prog.remainingIndices], [3], "Spot 회수된 태스크(3)만 재실행 대기열에 남아야 함");
    assert.equal(prog.isAllCompleted, false);

    const nextPick = srv.pickNextTaskQueueItem(job, matchingRuns);
    assert.equal(nextPick.taskIdx, 3);
    assert.equal(nextPick.taskArg, "--seed 3");

    // Once Task 2 & Task 3 also succeed -> isAllCompleted === true!
    const allDoneRuns = [
      { id: "101", containerName: "v9-sweep-s01-t02-1127", status: "SUCCEEDED" },
      { id: "104", containerName: "v9-sweep-s02-t03-1127", status: "SUCCEEDED" },
      { id: "103", containerName: "v9-sweep-s03-t04-1127", status: "SUCCEEDED" },
    ];
    const doneProg = srv.reconcileTaskQueueProgress(job, allDoneRuns);
    assert.equal(doneProg.isAllCompleted, true);
  });

  test("TC-62: [Batch 5 - Feature 2] `detectLossDivergence` 학습 중 NaN / Inf 발산 정밀 감지 및 정상 로그 오탐 방지 검증", () => {
    assert.equal(
      srv.detectLossDivergence("step 120/1000 | loss=0.3821 | grad_norm=1.24 | elapsed=12000ns (nanosecond timer)").isDiverged,
      false,
      "정상 수치 및 nanosecond 같은 일반 단어에서는 오탐하지 않아야 함"
    );
    const nanHit = srv.detectLossDivergence("step 121/1000 | train_loss=nan | lr=1e-4");
    assert.equal(nanHit.isDiverged, true);
    assert.equal(nanHit.matchedToken, "train_loss=nan");

    const infHit = srv.detectLossDivergence("[Rank 0] step=88 grad_norm: -inf");
    assert.equal(infHit.isDiverged, true);
  });

  test("TC-63: [Batch 5 - Feature 3] `summarizeOutputDirectoryEntries` 볼륨 산출물·체크포인트 폴더 요약 검증", () => {
    const nowMs = Date.parse("2026-11-27T06:00:00.000Z");
    const entries = [
      { name: "logs", isDir: true },
      { name: "ckpt_step_1000.pt", size: 10 * 1024 * 1024, modifiedAt: "2026-11-27T05:30:00.000Z" },
      { name: "ckpt_step_2000.pt", size: 15 * 1024 * 1024, modifiedAt: "2026-11-27T05:54:00.000Z" },
    ];
    const sum = srv.summarizeOutputDirectoryEntries(entries, nowMs);
    assert.equal(sum.fileCount, 2);
    assert.equal(sum.dirCount, 1);
    assert.equal(sum.totalSizeMB, 25);
    assert.equal(sum.latestFileName, "ckpt_step_2000.pt");
    assert.equal(sum.minutesSinceLastWrite, 6);
  });

  test("TC-64: [Batch 5 - Feature 4] 터미널 전용 CLI(`bin/gpu-ctl.mjs`) 구문 검사, `help` 및 라이브 `status` 동작 검증", () => {
    const cliPath = path.join(ROOT_DIR, "bin", "gpu-ctl.mjs");
    assert.equal(fs.existsSync(cliPath), true, "bin/gpu-ctl.mjs 파일이 존재해야 함");
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ["--check", cliPath], { encoding: "utf-8" });
    });
    const helpOut = execFileSync(process.execPath, [cliPath, "help"], { encoding: "utf-8" });
    assert.equal(helpOut.includes("SPACE GPU Runner Terminal CLI"), true);

    if (serverReachable) {
      const stOut = execFileSync(process.execPath, [cliPath, "status"], {
        encoding: "utf-8",
        env: { ...process.env, GPU_RUNNER_URL: BASE_URL, RUNNER_PASSWORD: ADMIN_PW },
      });
      assert.equal(stOut.includes("[SPACE GPU Runner]"), true);
    }
  });

  test("TC-65: [Batch 5 - Feature 5] `computeWorkerUptimeSec` & `buildRunConsoleLinks` 슬롯 생존 시간 및 웹 콘솔 링크 생성 검증", () => {
    const nowMs = Date.parse("2026-11-27T06:00:00.000Z");
    const runRunning = {
      id: "374823",
      status: "RUNNING",
      registerTime: "2026-11-27T04:50:00.000Z",
      startTime: "2026-11-27T05:00:00.000Z",
      webConsoleUrl: "https://console-viewer.n9.sr-cloud.com/term/374823",
    };
    const up = srv.computeWorkerUptimeSec(runRunning, nowMs);
    assert.equal(up.uptimeSec, 3600);
    assert.equal(up.queueWaitSec, 600);

    const links = srv.buildRunConsoleLinks(runRunning, { portalUrl: "https://space.n9.sr-cloud.com" });
    assert.equal(links.webConsoleUrl, "https://console-viewer.n9.sr-cloud.com/term/374823");
    assert.equal(links.portalRunUrl, "https://space.n9.sr-cloud.com/console/home");
  });

  test("TC-66: [Batch 5 - Feature 6] `computeHourlyClusterWeather` 24시간 클러스터 노드 배정·회수 날씨 히트맵 집계 검증", () => {
    const jobs = [{ id: "j-v9", name: "v9", executionCommand: "sh /user-volume/v9/run.sh" }];
    // 2026-11-26T18:10:00Z = 2026-11-27 03:10 KST (fast 1m wait, 2 promotions)
    // 2026-11-27T05:20:00Z = 2026-11-27 14:20 KST (2 preemptions)
    const runs = [
      { id: "1", containerName: "v9-s01-1127", registerTime: "2026-11-26T18:09:00Z", startTime: "2026-11-26T18:10:00Z" },
      { id: "2", containerName: "v9-s02-1127", registerTime: "2026-11-26T18:19:00Z", startTime: "2026-11-26T18:20:00Z" },
    ];
    const siteTel = {
      recentPreemptions: [
        { runId: "10", time: "2026-11-27T05:15:00Z" },
        { runId: "11", time: "2026-11-27T05:25:00Z" },
      ],
    };
    const weather = srv.computeHourlyClusterWeather(runs, siteTel, jobs);
    assert.equal(weather.hasData, true);
    assert.equal(weather.hours.length, 24);
    assert.equal(weather.hours[3].promotions, 2, "KST 03시에 배정 2건이 집계되어야 함");
    assert.equal(weather.hours[14].preemptions, 2, "KST 14시에 Spot 회수 2건이 집계되어야 함");
    assert.equal([...weather.bestHours].includes(3), true);
    assert.equal([...weather.busyHours].includes(14), true);
  });

  test("TC-67: [Batch 6 - Feature 1] `parseExpectedRunTimeSec` & `computeTtlPreWarmAllowance` 수명 만료(8h) 임박 감지 및 선제 예열 산출 검증", () => {
    assert.equal(srv.parseExpectedRunTimeSec("8h"), 28800);
    assert.equal(srv.parseExpectedRunTimeSec("168h"), 604800);
    assert.equal(srv.parseExpectedRunTimeSec("1h30m"), 5400);

    const nowMs = Date.parse("2026-11-27T08:00:00.000Z");
    const runningRuns = [
      // 7h 50m elapsed -> 10m left (< 15m lead) -> expiring soon!
      { id: "1", status: "RUNNING", startTime: "2026-11-27T00:10:00.000Z" },
      // 7h 52m elapsed -> 8m left (< 15m lead) -> expiring soon!
      { id: "2", status: "RUNNING", startTime: "2026-11-27T00:08:00.000Z" },
      // 2h elapsed -> 6h left -> healthy!
      { id: "3", status: "RUNNING", startTime: "2026-11-27T06:00:00.000Z" },
    ];
    const ttl = srv.computeTtlPreWarmAllowance(runningRuns, "8h", 15, 4, nowMs);
    assert.equal(ttl.expiringSoonCount, 2);
    assert.equal(ttl.preWarmAllowance, 2);
    assert.equal(ttl.minRemainingSec, 480);
  });

  test("TC-68: [Batch 6 - Feature 2] `evaluateJobBudgetCap` 규칙별 GPU-Hours 예산 80% 경보 및 100% 한도 도달 판정 검증", () => {
    const unlimited = srv.evaluateJobBudgetCap({ maxGpuHours: 0 }, 9999);
    assert.equal(unlimited.enabled, false);
    assert.equal(unlimited.isExceeded, false);

    const warn85 = srv.evaluateJobBudgetCap({ maxGpuHours: 1000, budgetCapAction: "drain" }, 850);
    assert.equal(warn85.enabled, true);
    assert.equal(warn85.usagePct, 85);
    assert.equal(warn85.isWarn80, true);
    assert.equal(warn85.isExceeded, false);
    assert.equal(warn85.remainingGpuHours, 150);

    const exceeded = srv.evaluateJobBudgetCap({ maxGpuHours: 1000, budgetCapAction: "stop" }, 1012.5);
    assert.equal(exceeded.isExceeded, true);
    assert.equal(exceeded.isWarn80, false);
    assert.equal(exceeded.action, "stop");
  });

  test("TC-69: [Batch 6 - Feature 3] `appendMetricSeriesSample` & `renderSvgPolyline` 실시간 Loss · 처리량 스파크라인 시계열 검증", () => {
    let series = [];
    series = srv.appendMetricSeriesSample(series, { time: "15:00", avgLoss: 1.24, totalThroughput: 82.4, speedUnit: "step/s" }, 3);
    series = srv.appendMetricSeriesSample(series, { time: "15:01", avgLoss: 0.98, totalThroughput: 85.1, speedUnit: "step/s" }, 3);
    series = srv.appendMetricSeriesSample(series, { time: "15:02", avgLoss: 0.76, totalThroughput: 86.0, speedUnit: "step/s" }, 3);
    series = srv.appendMetricSeriesSample(series, { time: "15:03", avgLoss: 0.65, totalThroughput: 87.2, speedUnit: "step/s" }, 3);
    assert.equal(series.length, 3, "최대 보관 개수(maxPoints)로 자동 슬라이싱되어야 함");
    assert.equal(series[2].avgLoss, 0.65);

    const svg = ui.renderSvgPolyline([1.24, 0.98, 0.76, 0.65], 170, 36);
    assert.equal(svg.includes("<svg") && svg.includes("<polyline"), true);
  });

  test("TC-70: [Batch 6 - Feature 4] `evaluateProblemNodeQuarantine` 반복 불량 노드 자동 격리 및 적응형 우회 쿨다운 확대 검증", () => {
    const nowMs = Date.parse("2026-11-27T07:00:00.000Z");
    const problemNodes = {
      "dgx-h100-bad07": { count: 3, lastError: "Xid 79", lastSeenAt: "2026-11-27T06:55:00.000Z" },
      "dgx-h100-old01": { count: 4, lastError: "ECC", lastSeenAt: "2026-11-26T00:00:00.000Z" }, // stale (>30m)
    };
    const q = srv.evaluateProblemNodeQuarantine(problemNodes, 1, nowMs, 25);
    assert.equal(q.isQuarantineActive, true);
    assert.equal(q.quarantinedNodes.length, 1);
    assert.equal(q.highestRepeatNode, "dgx-h100-bad07");
    assert.equal(q.escalatedCooldownSec > 25, true, "반복 장애 노드 감지 시 기본 25초보다 확대된 우회 쿨다운이 적용되어야 함");
  });

  test("TC-71: [Batch 6 - Feature 5] `slicePreviewContent` 볼륨 결과 파일(`.jsonl` 등) Head/Tail 슬라이싱 및 바이트 제한 검증", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `{"step": ${i + 1}, "score": 0.91}`).join("\n");
    const tailRes = srv.slicePreviewContent(lines, { mode: "tail", maxLines: 50 });
    assert.equal(tailRes.totalLines, 250);
    assert.equal(tailRes.shownLines, 50);
    assert.equal(tailRes.startLine, 201);
    assert.equal(tailRes.truncated, true);
    assert.equal(tailRes.previewText.includes('"step": 250'), true);
    assert.equal(tailRes.previewText.includes('"step": 1,'), false);

    const headRes = srv.slicePreviewContent(lines, { mode: "head", maxLines: 20 });
    assert.equal(headRes.shownLines, 20);
    assert.equal(headRes.previewText.includes('"step": 1,'), true);
  });

  test("TC-72: [Batch 6 - Feature 6] `parseQuickPaletteCommand` 빠른 키보드 명령 팔레트(`Ctrl+K`) 자연어 단축 명령 파서 검증", () => {
    const jobs = [{ id: "job-v9", name: "v9" }, { id: "job-v8", name: "v8" }];
    const c1 = ui.parseQuickPaletteCommand("v9 30", jobs);
    assert.equal(c1.type, "set_workers");
    assert.equal(c1.jobId, "job-v9");
    assert.equal(c1.workers, 30);

    const c2 = ui.parseQuickPaletteCommand("v9 120g", jobs);
    assert.equal(c2.type, "set_gpus");
    assert.equal(c2.gpus, 120);

    const c3 = ui.parseQuickPaletteCommand("log 5", jobs);
    assert.equal(c3.type, "log");
    assert.equal(c3.target, "5");

    const c4 = ui.parseQuickPaletteCommand("grep reward=", jobs);
    assert.equal(c4.type, "grep");
    assert.equal(c4.query, "reward=");
  });

  test("TC-73: [Batch 7 - Feature 1] `evaluateDueScheduledActions` 시각 예약 오토파일럿 사이트 격리 및 도래 순서 판정 검증", () => {
    const nowMs = Date.parse("2026-11-27T14:00:00.000Z");
    const actions = [
      { id: "a1", siteId: "n9", status: "pending", runAt: "2026-11-27T13:55:00.000Z", actionType: "set_target" },
      { id: "a2", siteId: "n9", status: "pending", runAt: "2026-11-27T13:30:00.000Z", actionType: "toggle_job" },
      { id: "a3", siteId: "n6", status: "pending", runAt: "2026-11-27T13:00:00.000Z", actionType: "set_target" },
      { id: "a4", siteId: "n9", status: "executed", runAt: "2026-11-27T12:00:00.000Z", actionType: "set_target" },
      { id: "a5", siteId: "n9", status: "pending", runAt: "2026-11-27T15:00:00.000Z", actionType: "set_target" }, // future
    ];
    const due = srv.evaluateDueScheduledActions(actions, nowMs, "n9");
    assert.deepEqual(
      [...due.map((x) => x.id)],
      ["a2", "a1"],
      "n9 사이트의 미실행 도래 건만 시간순(a2 -> a1)으로 추출되어야 함"
    );
  });

  test("TC-74: [Batch 7 - Feature 2] `buildClonedJobRule` & `diffJobRules` 원클릭 버전업 복제(`v9 ➔ v10`) 및 변경점 비교 검증", () => {
    const srcV9 = {
      id: "job-v9",
      name: "v9",
      enabled: true,
      draining: true,
      minConcurrentRuns: 24,
      coreCount: 4,
      targetPendingRuns: 6,
      allowSpot: true,
      executionCommand: "sh /user-volume/offpolicy-misranking/v9/run.sh",
      watchOutputDir: "/user-volume/offpolicy-misranking/v9/outputs",
      taskQueueCompletedIdx: [1, 2],
    };
    const cloned = srv.buildClonedJobRule(srcV9);
    assert.equal(cloned.name, "v10");
    assert.equal(cloned.enabled, false, "복제 직후에는 안전한 점검을 위해 일시정지(false) 상태여야 함");
    assert.equal(cloned.draining, false);
    assert.equal(cloned.executionCommand, "sh /user-volume/offpolicy-misranking/v10/run.sh");
    assert.equal(cloned.watchOutputDir, "/user-volume/offpolicy-misranking/v10/outputs");
    assert.equal(cloned.taskQueueCompletedIdx.length, 0);

    const diff = srv.diffJobRules(srcV9, cloned);
    assert.equal(diff.identical, false);
    assert.equal(diff.diffs.some((d) => d.field === "executionCommand"), true);
  });

  test("TC-75: [Batch 7 - Feature 3] 실시간 SSE 스트림(`GET /api/events`) 연결 핸드셰이크 및 백그라운드 탭 절전 폴링 검증", async (t) => {
    assert.equal(appJsSrc.includes("new EventSource("), true);
    assert.equal(appJsSrc.includes("document.hidden ? Math.max(baseSec * 5, 25)"), true);
    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 라이브 SSE 스트림 스킵");

    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/api/events?pw=${encodeURIComponent(ADMIN_PW)}`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.equal(String(res.headers.get("content-type") || "").includes("text/event-stream"), true);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const firstChunk = new TextDecoder().decode(value);
    await reader.cancel().catch(() => {});
    ac.abort();
    assert.equal(firstChunk.includes("event: connected"), true, "SSE 초기 연결 이벤트 프레임이 즉시 수신되어야 함");
  });

  test("TC-76: [Batch 7 - Feature 4] `generateJobExperimentReport` 및 `GET /api/jobs/report` Markdown·CSV 성적표 생성 검증", async (t) => {
    const job = {
      id: "job-v9",
      name: "v9",
      minConcurrentRuns: 24,
      coreCount: 4,
      allowSpot: true,
      expectedRunTime: "8h",
      executionCommand: "sh /user-volume/offpolicy-misranking/v9/run.sh",
    };
    const runs = [
      { id: "1", status: "RUNNING", registerTime: "2026-11-27T08:00:00Z", startTime: "2026-11-27T08:04:00Z" },
      { id: "2", status: "SUCCEEDED", registerTime: "2026-11-27T01:00:00Z", startTime: "2026-11-27T01:02:00Z" },
      { id: "3", status: "PREEMPTED" },
    ];
    const rep = srv.generateJobExperimentReport(
      job,
      runs,
      { jobGpuHours: { v9: 1180.5 }, todayJobGpuHours: { v9: 412.2 }, metricSeries: [{ avgLoss: 0.92 }, { avgLoss: 0.44 }] },
      { throughputSummary: { totalThroughput: 96.5, speedUnit: "step/s" } }
    );
    assert.equal(rep.totalGpuHours, 1180.5);
    assert.equal(rep.runningCount, 1);
    assert.equal(rep.succeededCount, 1);
    assert.equal(rep.preemptedCount, 1);
    assert.equal(rep.markdown.includes("1180.5 GPU-h"), true);
    assert.equal(rep.csv.includes("v9"), true);

    if (!serverReachable) return t.skip("로컬 4300 데몬 미실행 환경 — 라이브 리포트 API 스킵");
    const liveRes = await fetch(`${BASE_URL}/api/jobs/report`, { headers: { "X-Admin-Password": ADMIN_PW } });
    assert.equal(liveRes.status, 200);
    const liveJson = await liveRes.json();
    assert.equal(liveJson.ok, true);
    assert.equal(typeof liveJson.report?.markdown, "string");
  });

  test("TC-77: [Batch 7 - Feature 5] `aggregateJsonlMetrics` 분산 샤드 `.jsonl`/`.json` 샘플 수 및 수치 지표 자동 집계 검증", () => {
    const files = [
      {
        fileName: "shard_0.jsonl",
        content: [
          '{"step": 1, "reward": 0.8, "loss": 0.4}',
          '{"step": 2, "reward": 1.0, "loss": 0.2}',
          "BROKEN_JSON_LINE",
        ].join("\n"),
      },
      {
        fileName: "shard_1.jsonl",
        content: '{"step": 3, "reward": 0.6, "loss": 0.3}\n',
      },
    ];
    const agg = srv.aggregateJsonlMetrics(files);
    assert.equal(agg.scannedFiles, 2);
    assert.equal(agg.totalRecords, 3);
    assert.equal(agg.malformedLines, 1);
    const rewardStat = agg.metrics.find((m) => m.key === "reward");
    assert.equal(rewardStat.mean, 0.8);
    assert.equal(rewardStat.min, 0.6);
    assert.equal(rewardStat.max, 1.0);
  });

  test("TC-78: [Batch 7 - Feature 6] 모바일·태블릿 반응형 CSS(`@media (max-width: 768px)`) 무결성 검증", () => {
    const styleCss = fs.readFileSync(path.join(ROOT_DIR, "public", "style.css"), "utf-8");
    assert.equal(styleCss.includes("@media (max-width: 768px)"), true);
    assert.equal(styleCss.includes("@media (max-width: 480px)"), true);
  });

  test("TC-79: [회귀 방지] `computeNextAutoSpawnEligibility` 5분(300초) 생성 간격 엄수 및 `targetPending > 0`에서도 불량 노드 쿨다운 적용 검증", () => {
    const nowMs = Date.parse("2026-11-27T14:10:00.000Z");
    // 1) 40초 전에 생성된 직후라면 300초(5분) 간격 설정 시 절대 허용되지 않아야 함 (남은 대기 260초)
    const block5m = srv.computeNextAutoSpawnEligibility({
      nowMs,
      lastTriggeredAt: "2026-11-27T14:09:20.000Z",
      cooldownSec: 300,
      badNodeGuardEnabled: true,
      badNodeCooldownUntilMs: 0,
      manualImmediate: false,
    });
    assert.equal(block5m.allowedNow, false);
    assert.equal(block5m.blockedBy, "cooldown");
    assert.equal(block5m.waitSec, 260);

    // 2) 불량 노드 쿨다운(50초)보다 설정된 생성 간격(260초 남음)이 더 길면 더 긴 260초(Math.max)를 유지해야 함!
    const both = srv.computeNextAutoSpawnEligibility({
      nowMs,
      lastTriggeredAt: "2026-11-27T14:09:20.000Z",
      cooldownSec: 300,
      badNodeGuardEnabled: true,
      badNodeCooldownUntilMs: nowMs + 50000,
      manualImmediate: false,
    });
    assert.equal(both.allowedNow, false);
    assert.equal(both.waitSec, 260);

    // 3) 5분이 모두 경과했더라도 불량 노드 쿨다운이 활성 중이면 차단되어야 함
    const badOnly = srv.computeNextAutoSpawnEligibility({
      nowMs,
      lastTriggeredAt: "2026-11-27T14:00:00.000Z",
      cooldownSec: 300,
      badNodeGuardEnabled: true,
      badNodeCooldownUntilMs: nowMs + 95000,
      manualImmediate: false,
    });
    assert.equal(badOnly.allowedNow, false);
    assert.equal(badOnly.blockedBy, "bad_node_cooldown");
    assert.equal(badOnly.waitSec, 95);

    // 4) 5분 이상 경과하고 불량 노드 쿨다운도 없으면 정상 1개 생성 허용
    const ok = srv.computeNextAutoSpawnEligibility({
      nowMs,
      lastTriggeredAt: "2026-11-27T14:04:55.000Z",
      cooldownSec: 300,
      badNodeGuardEnabled: true,
      badNodeCooldownUntilMs: 0,
      manualImmediate: false,
    });
    assert.equal(ok.allowedNow, true);

    // 5) 코드 구조 검증: multi-spawn burst loop(`maxRefillSteps`) 및 `targetPending === 0 &&` 우회 조건이 완전히 제거되었는지 확인
    assert.equal(serverSrc.includes("maxRefillSteps"), false, "단일 틱 연사 루프(maxRefillSteps)가 제거되어야 함");
    assert.equal(
      serverSrc.includes("targetPending === 0 && state.config.badNodeGuardEnabled"),
      false,
      "targetPending > 0 일 때도 불량 노드 쿨다운이 동일하게 적용되어야 함"
    );
  });

  test("TC-80: [회귀 방지] 연속 5회 조기 실패 시 30분(1800s) 서킷 브레이커 작동 및 전역 `bypassCooldown: true` 우회 제거 검증", () => {
    const q5 = srv.evaluateProblemNodeQuarantine({}, 5, Date.now(), 25);
    assert.equal(q5.isCircuitOpen, true, "연속 5회 조기 크래시 시 서킷 브레이커가 열려야 함");
    assert.equal(q5.escalatedCooldownSec >= 1800, true, "무의미한 재신청 및 메일 폭주 차단을 위해 최소 30분(1800초) 대기해야 함");
    assert.equal(
      serverSrc.includes("runSchedulerTick(false, { bypassCooldown: true })"),
      false,
      "목표 하향·간격 수정 시 전역 쿨다운을 무시하는 호출이 없어야 함"
    );
  });
});
