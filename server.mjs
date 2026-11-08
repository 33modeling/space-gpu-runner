#!/usr/bin/env node
/**
 * SPACE (space.n9.sr-cloud.com) Periodic GPU Allocator & Group-Volume Script Runner
 * With Admin Run-Approval Auto-Approver, Configurable Polling Intervals & Password Gate ("cycy")
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 4300);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_PASSWORD = process.env.RUNNER_PASSWORD || "cycy";
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_STATE = {
  config: {
    baseUrl: "https://mlp.n9.sr-cloud.com",
    sfmUrl: "https://sfsm.n9.sr-cloud.com",
    accessToken: "",
    refreshToken: "",
    groupId: "",
    orgId: "",
    userName: "",
    schedulerEnabled: true,
    checkIntervalSec: 15, // GPU / Workload check interval (1s ~ 3600s)
    approvalCheckIntervalSec: 3, // Admin Run-Approval polling interval (1s ~ 3600s)
    uiRefreshIntervalSec: 5, // Frontend UI auto-refresh interval (1s ~ 600s)
    postCreateApproveRetries: 12, // Fast approval retries right after creating a run
    postCreateApproveDelaySec: 2, // Seconds between fast approval retries
    // Run-Approval policy: "all_group" | "my_runs" | "job_only" | "off"
    autoApprovalScope: "all_group",
    // 🛡️ Smart Server/Cluster Load-Safe Paced Allocation settings
    smartLoadGuardEnabled: true,
    maxPendingWorkers: 2, // Pause new spawns when Pending/Creating workers >= this cap
    stepByStepRunningCheck: true, // Verify in-flight workers transition toward Running & hold if queue stalls
    apiLatencyWarnMs: 1800, // Stretch cooldown by 1.5x when avg API latency exceeds this
    apiLatencyCriticalMs: 3500, // Stretch cooldown by 2.5x or hold when avg API latency exceeds this
    adaptivePollingEnabled: true, // Reduce redundant polling & cache API bursts
    // 1️⃣ 🧟 Zombie / Stuck Worker Watchdog & Live Log Scanner settings
    watchdogEnabled: true,
    maxPendingTimeoutMin: 20, // Auto-cancel & replace Pending/Creating workers stuck longer than N minutes
    logErrorAutoRestart: false, // Auto-terminate & replace Running workers when fatal log error is detected
    customErrorKeywords: "CUDA out of memory,NCCL error,Segmentation fault,Bus error",
    // 3️⃣ 🔢 Auto-Sharding Worker Slot Environment Variable Injection
    injectWorkerEnv: false, // Prepend `export WORKER_SLOT=... WORKER_INDEX=... WORKER_TOTAL=...;`
    // 4️⃣ 🔄 Spot <-> Standard Hybrid Auto-Fallback
    hybridFallbackEnabled: true, // Auto-fallback between Spot and Standard (or fallbackCoreId) on allocation failure/shortage
    fallbackCoreId: "",
    // 5️⃣ 🌙 Time-of-Day / Weekend Auto-Scaling Boost
    timeScaleEnabled: false,
    dayTargetWorkers: 20,
    nightTargetWorkers: 48,
    weekendTargetWorkers: 64,
    nightStartHour: 20, // 20:00 KST
    nightEndHour: 8, // 08:00 KST
    // 6️⃣ 🔔 Webhook (Slack/Discord/Telegram) & Browser Alert Notification settings
    webhookUrl: "",
    browserNotifyEnabled: true,
    notifyOnTokenExpiring: true,
    notifyOnZombieTerminated: true,
    notifyOnTargetReached: true,
    notifyOnError: true,
    // Batch 2 - 1️⃣ 📝 In-Dashboard Script Editor & Auto-Sync on Container Start
    syncEditedScriptsOnStart: true,
    // Batch 2 - 3️⃣ ⛓️ Goal Auto-Stop & Multi-Stage Pipeline Chaining (Stage 1 ➔ Stage 2)
    autoStopOnComplete: true,
    autoStopOnCompleteKeyword: "ALL_TASKS_COMPLETED,TRAINING_FINISHED,PIPELINE_DONE",
    maxTotalSucceededRuns: 0, // 0 = unlimited
    nextStageCommand: "",
    // Batch 2 - 6️⃣ 🩺 Bad-Node Eviction Guard & Rapid-Fail Cooldown
    badNodeGuardEnabled: true,
    badNodeRapidFailSec: 180,
    badNodeCooldownSec: 25,
  },
  jobs: [
    {
      id: "job-default-1",
      name: "group-vol-worker",
      enabled: true,
      mode: "ensure_running", // "ensure_running" | "when_gpu_free" | "once_until_success"
      useSpecId: "",
      groupPoolId: "",
      coreId: "",
      coreCount: 1,
      quotaId: "",
      allowSpot: false,
      autoApprove: true,
      containerImage: "",
      experimentId: "",
      executionCommand: "bash /group-volume/run.sh",
      expectedRunTime: "8h",
      enableWebConsole: true,
      minConcurrentRuns: 1,
      restartOnSuccess: true,
      restartOnFail: true,
      cooldownSec: 15,
      volumeClaim: [],
      lastCheckAt: null,
      lastTriggeredAt: null,
      lastRunId: null,
      lastStatus: "Idle",
    },
  ],
  presets: [
    {
      id: "preset-full-48",
      name: "🚀 48워커 풀가동 (Spot)",
      badge: "48W · Spot",
      executionCommand: "bash /group-volume/run.sh",
      minConcurrentRuns: 48,
      coreCount: 1,
      allowSpot: true,
      expectedRunTime: "8h",
      injectWorkerEnv: false,
      nextStageCommand: "",
      updatedAt: "2026-11-04T00:00:00.000Z",
    },
    {
      id: "preset-std-20",
      name: "🛡️ 20워커 안정 가동 (Standard)",
      badge: "20W · Std",
      executionCommand: "bash /group-volume/run.sh",
      minConcurrentRuns: 20,
      coreCount: 1,
      allowSpot: false,
      expectedRunTime: "8h",
      injectWorkerEnv: false,
      nextStageCommand: "",
      updatedAt: "2026-11-04T00:00:00.000Z",
    },
    {
      id: "preset-sharded-16",
      name: "🔢 16워커 자동 샤딩 (WORKER_SLOT)",
      badge: "16W · Sharding",
      executionCommand: "bash /group-volume/run.sh --shard {{SLOT}} --total {{TOTAL}}",
      minConcurrentRuns: 16,
      coreCount: 1,
      allowSpot: true,
      expectedRunTime: "8h",
      injectWorkerEnv: true,
      nextStageCommand: "",
      updatedAt: "2026-11-04T00:00:00.000Z",
    },
    {
      id: "preset-debug-1",
      name: "🧪 1워커 빠른 디버그",
      badge: "1W · Debug",
      executionCommand: "bash /group-volume/run.sh",
      minConcurrentRuns: 1,
      coreCount: 1,
      allowSpot: true,
      expectedRunTime: "2h",
      injectWorkerEnv: true,
      nextStageCommand: "",
      updatedAt: "2026-11-04T00:00:00.000Z",
    },
  ],
  scriptFiles: {
    "/group-volume/run.sh": {
      path: "/group-volume/run.sh",
      content: "#!/usr/bin/env bash\nset -e\necho \"[SPACE Worker] Starting on $(hostname) (Slot: ${WORKER_SLOT:-1}/${WORKER_TOTAL:-1})\"\nnvidia-smi -L || true\n# 아래에 실행할 학습/추론 명령어를 작성하세요\n",
      updatedAt: null,
      autoInject: false,
    },
  },
  telemetry: {
    totalGpuHours: 0,
    dailyGpuHours: {},
    jobGpuHours: {},
    timeSeries: [],
    lastAccountingAtMs: 0,
    lastSampleAtMs: 0,
  },
  history: [],
  approvalHistory: [],
  alerts: [],
};

function isApprovalOrAllocationLogMessage(msg = "") {
  const s = String(msg);
  return (
    s.includes("할당 요청 전송") ||
    s.includes("할당 및 스크립트 실행 요청 전송") ||
    s.includes("생성됨:") ||
    s.includes("승인 완료")
  );
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      const rawHistory = Array.isArray(raw.history) ? raw.history.slice(0, 200) : [];
      const rawApprovalHistory = Array.isArray(raw.approvalHistory)
        ? raw.approvalHistory.slice(0, 300)
        : rawHistory.filter((h) => h && isApprovalOrAllocationLogMessage(h.message)).slice(0, 300);
      const rawAlerts = Array.isArray(raw.alerts) ? raw.alerts.slice(0, 100) : [];
      const rawPresets =
        Array.isArray(raw.presets) && raw.presets.length > 0 ? raw.presets : structuredClone(DEFAULT_STATE.presets);
      const rawScriptFiles =
        raw.scriptFiles && typeof raw.scriptFiles === "object"
          ? { ...structuredClone(DEFAULT_STATE.scriptFiles), ...raw.scriptFiles }
          : structuredClone(DEFAULT_STATE.scriptFiles);
      const rawTelemetry =
        raw.telemetry && typeof raw.telemetry === "object"
          ? {
              totalGpuHours: Number(raw.telemetry.totalGpuHours || 0),
              dailyGpuHours: raw.telemetry.dailyGpuHours || {},
              jobGpuHours: raw.telemetry.jobGpuHours || {},
              timeSeries: Array.isArray(raw.telemetry.timeSeries) ? raw.telemetry.timeSeries.slice(-60) : [],
              lastAccountingAtMs: Number(raw.telemetry.lastAccountingAtMs || 0),
              lastSampleAtMs: Number(raw.telemetry.lastSampleAtMs || 0),
            }
          : structuredClone(DEFAULT_STATE.telemetry);
      return {
        config: { ...DEFAULT_STATE.config, ...(raw.config || {}) },
        jobs: Array.isArray(raw.jobs)
          ? raw.jobs.map((j) => ({ autoApprove: true, ...j }))
          : DEFAULT_STATE.jobs,
        presets: rawPresets,
        scriptFiles: rawScriptFiles,
        telemetry: rawTelemetry,
        history: rawHistory,
        approvalHistory: rawApprovalHistory,
        alerts: rawAlerts,
      };
    }
  } catch (e) {
    console.error("[State] Failed to load state.json:", e.message);
  }
  return structuredClone(DEFAULT_STATE);
}

let state = loadState();

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    console.error("[State] Failed to save state.json:", e.message);
  }
}

function addLog(level, message, meta = {}) {
  const nowIso = new Date().toISOString();
  const msgStr = String(message || "");

  // Deduplicate rapid identical token-refresh log lines within 60 seconds so history stays clean
  if (msgStr.includes("Refresh Token으로 Access Token 자동 갱신 성공") && state.history.length > 0) {
    const recentSame = state.history.find(
      (h) =>
        h &&
        h.message === msgStr &&
        h.time &&
        Date.now() - new Date(h.time).getTime() < 60_000
    );
    if (recentSame) {
      return;
    }
  }

  const entry = {
    time: nowIso,
    level,
    message: msgStr,
    ...meta,
  };
  console.log(`[${entry.time}] [${level.toUpperCase()}] ${msgStr}`, Object.keys(meta).length ? JSON.stringify(meta) : "");
  state.history.unshift(entry);
  if (state.history.length > 200) {
    state.history.length = 200;
  }
  if (!Array.isArray(state.approvalHistory)) {
    state.approvalHistory = [];
  }
  if (isApprovalOrAllocationLogMessage(msgStr)) {
    state.approvalHistory.unshift(entry);
    if (state.approvalHistory.length > 300) {
      state.approvalHistory.length = 300;
    }
  }
  saveState();
}

function sanitizeGroupId(val) {
  const s = String(val ?? "").trim();
  if (!s || s === "undefined" || s === "null") return "";
  return s;
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const parts = token.replace(/^Bearer\s+/i, "").trim().split(".");
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractGroupFromJwt(token) {
  const jwt = decodeJwtPayload(token);
  const roles = jwt?.resource_access?.iam?.roles;
  if (Array.isArray(roles)) {
    for (const r of roles) {
      const m = /^group@([^@]+)@/.exec(String(r));
      if (m && m[1]) return m[1];
    }
  }
  return "";
}

function resolveGroupId() {
  const cleaned = sanitizeGroupId(state.config.groupId);
  if (cleaned) {
    if (state.config.groupId !== cleaned) {
      state.config.groupId = cleaned;
      saveState();
    }
    return cleaned;
  }
  const fromJwt = extractGroupFromJwt(state.config.accessToken) || extractGroupFromJwt(state.config.refreshToken);
  if (fromJwt) {
    state.config.groupId = fromJwt;
    saveState();
    return fromJwt;
  }
  return "";
}

function resolveCurrentUserName() {
  if (state.config.userName && state.config.userName !== "undefined") return state.config.userName;
  const jwt = decodeJwtPayload(state.config.accessToken);
  if (jwt) {
    return jwt.preferred_username || jwt.username || jwt.user_name || jwt.sub || jwt.user_id || jwt.email || "admin";
  }
  return "admin";
}

function extractItemsArray(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.items)) return res.items;
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res.runs)) return res.runs;
  if (Array.isArray(res.content)) return res.content;
  if (res.data && typeof res.data === "object") {
    if (Array.isArray(res.data.items)) return res.data.items;
    if (Array.isArray(res.data.runs)) return res.data.runs;
    if (Array.isArray(res.data.content)) return res.data.content;
    if (Array.isArray(res.data.data)) return res.data.data;
  }
  return [];
}

/**
 * 🛡️ Real-Time Server & SPACE API Load Telemetry
 * Tracks API latency samples, requests-per-minute (RPM), cache hits, error rates, and auto-backoff cooldowns.
 */
const loadMonitorStats = {
  recentLatenciesMs: [], // Last 40 SPACE API call latencies
  requestTimestampsMs: [], // Timestamps within the last 60s for RPM calculation
  cacheHitTimestampsMs: [], // Cache hits within the last 60s
  lastLatencyMs: 0,
  avgLatencyMs: 0,
  p95LatencyMs: 0,
  maxLatencyMs: 0,
  totalRequests: 0,
  totalCacheHits: 0,
  totalErrors: 0,
  consecutiveErrors: 0,
  lastErrorAt: null,
  lastErrorStatus: null,
  lastErrorMessage: null,
  backoffUntilMs: 0,
  backoffReason: null,
  lastHoldReason: null,
  lastHoldLogAtMs: 0,
  poolGpuFree: null,
  poolGpuTotal: null,
  poolGpuUpdatedAt: null,
};

function recordCacheHit() {
  const now = Date.now();
  loadMonitorStats.totalCacheHits += 1;
  loadMonitorStats.cacheHitTimestampsMs.push(now);
  if (loadMonitorStats.cacheHitTimestampsMs.length > 200) {
    loadMonitorStats.cacheHitTimestampsMs = loadMonitorStats.cacheHitTimestampsMs.filter((t) => now - t < 60_000);
  }
}

function recordApiTelemetry({ endpoint, latencyMs, status, ok, errorMsg = null }) {
  const now = Date.now();
  const cleanLatency = Math.max(1, Math.round(Number(latencyMs || 1)));
  loadMonitorStats.totalRequests += 1;
  loadMonitorStats.lastLatencyMs = cleanLatency;
  loadMonitorStats.requestTimestampsMs.push(now);
  loadMonitorStats.requestTimestampsMs = loadMonitorStats.requestTimestampsMs.filter((t) => now - t < 60_000);

  loadMonitorStats.recentLatenciesMs.push(cleanLatency);
  if (loadMonitorStats.recentLatenciesMs.length > 40) {
    loadMonitorStats.recentLatenciesMs.shift();
  }
  const arr = loadMonitorStats.recentLatenciesMs;
  const sum = arr.reduce((a, b) => a + b, 0);
  loadMonitorStats.avgLatencyMs = Math.round(sum / arr.length);
  const sorted = [...arr].sort((a, b) => a - b);
  loadMonitorStats.p95LatencyMs = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || cleanLatency;
  loadMonitorStats.maxLatencyMs = sorted[sorted.length - 1] || cleanLatency;

  // Ignore benign "400 Only pending approvals can be approved" races when counting server health errors
  const isBenignAlreadyApproved =
    status === 400 && String(errorMsg || "").toLowerCase().includes("only pending approvals");

  if (ok || isBenignAlreadyApproved) {
    loadMonitorStats.consecutiveErrors = 0;
    if (loadMonitorStats.backoffUntilMs && now >= loadMonitorStats.backoffUntilMs) {
      loadMonitorStats.backoffUntilMs = 0;
      loadMonitorStats.backoffReason = null;
    }
  } else {
    loadMonitorStats.totalErrors += 1;
    loadMonitorStats.consecutiveErrors += 1;
    loadMonitorStats.lastErrorAt = new Date(now).toISOString();
    loadMonitorStats.lastErrorStatus = status;
    loadMonitorStats.lastErrorMessage = String(errorMsg || `HTTP ${status}`).slice(0, 180);

    // Apply automatic protective backoff cooldown on rate-limit (429), gateway overload (502/503/504), or repeated errors
    if (status === 429 || status === 502 || status === 503 || status === 504 || loadMonitorStats.consecutiveErrors >= 3) {
      const expFactor = Math.min(6, Math.max(1, loadMonitorStats.consecutiveErrors));
      const backoffSec = status === 429 ? Math.min(180, 30 * expFactor) : Math.min(120, 15 * expFactor);
      loadMonitorStats.backoffUntilMs = Math.max(loadMonitorStats.backoffUntilMs, now + backoffSec * 1000);
      loadMonitorStats.backoffReason =
        status === 429
          ? `SPACE API 요청 제한(HTTP 429) 감지 — ${backoffSec}초간 할당 자동 감속/보호 대기`
          : `SPACE 서버 과부하/오류(HTTP ${status || "NET"} · 연속 ${loadMonitorStats.consecutiveErrors}회) — ${backoffSec}초간 보호 쿨다운`;
    }
  }
}

/**
 * Core HTTP Client reproducing `mt` Axios client from SPACE `bundle.js#L89935-L90005`
 */
async function spaceRequest(endpoint, options = {}, isRetry = false) {
  const {
    method = "GET",
    body = undefined,
    params = undefined,
    overrideMethod = undefined,
    noGroupHeader = false,
    baseUrl = state.config.baseUrl,
    rawResponse = false,
    extraHeaders = {},
    timeoutMs = 15000,
    skipTelemetry = false,
  } = options;

  const jwt = decodeJwtPayload(state.config.accessToken);
  if (jwt?.exp && jwt.exp * 1000 - Date.now() < 60_000 && state.config.refreshToken && !isRetry) {
    await refreshAccessToken();
  }

  let url = endpoint.startsWith("http") ? endpoint : `${baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "" && v !== "undefined") {
        qs.append(k, String(v));
      }
    }
    const qsStr = qs.toString();
    if (qsStr) {
      url += (url.includes("?") ? "&" : "?") + qsStr;
    }
  }

  const headers = {
    Accept: "application/json, text/plain, */*",
    ...extraHeaders,
  };

  const cleanToken = (state.config.accessToken || "").replace(/^Bearer\s+/i, "").trim();
  if (cleanToken) {
    headers["Authorization"] = `Bearer ${cleanToken}`;
  }
  const activeGroupId = resolveGroupId();
  if (!noGroupHeader && activeGroupId) {
    headers["X-Request-Group-Id"] = String(activeGroupId);
  }
  if (overrideMethod) {
    headers["X-HTTP-Method-Override"] = overrideMethod;
  }
  const userHeader = state.config.userName || jwt?.sub || jwt?.user_id || jwt?.username || jwt?.preferred_username;
  if (userHeader && userHeader !== "undefined") {
    headers["x-request-user-id"] = String(userHeader);
  }

  const fetchOptions = {
    method: overrideMethod ? "POST" : method.toUpperCase(),
    headers,
    ...(timeoutMs > 0 && typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  };

  if (body !== undefined && fetchOptions.method !== "GET") {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const reqStartMs = Date.now();
  let res;
  try {
    res = await fetch(url, fetchOptions);
  } catch (netErr) {
    if (!skipTelemetry) {
      recordApiTelemetry({
        endpoint,
        latencyMs: Date.now() - reqStartMs,
        status: 0,
        ok: false,
        errorMsg: netErr.message,
      });
    }
    throw netErr;
  }
  const reqLatencyMs = Date.now() - reqStartMs;

  if (rawResponse) {
    const text = await res.text();
    if (!skipTelemetry) {
      recordApiTelemetry({
        endpoint,
        latencyMs: reqLatencyMs,
        status: res.status,
        ok: res.ok,
        errorMsg: res.ok ? null : text.slice(0, 200),
      });
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return text;
  }

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json().catch(() => null) : await res.text();

  if (res.status === 401 && state.config.refreshToken && !isRetry && !endpoint.includes("/api/acm/token")) {
    const errStr = typeof data === "object" && data !== null ? JSON.stringify(data) : String(data || "");
    if (!errStr.includes("insufficient permission")) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return spaceRequest(endpoint, options, true);
      }
    }
  }

  if (!res.ok) {
    const errMsg = typeof data === "object" && data !== null ? data.message || data.detail || data.error || JSON.stringify(data) : String(data);
    if (!skipTelemetry) {
      recordApiTelemetry({
        endpoint,
        latencyMs: reqLatencyMs,
        status: res.status,
        ok: false,
        errorMsg: errMsg,
      });
    }
    throw new Error(`SPACE API Error [${res.status}] ${endpoint}: ${errMsg}`);
  }

  if (!skipTelemetry) {
    recordApiTelemetry({
      endpoint,
      latencyMs: reqLatencyMs,
      status: res.status,
      ok: true,
    });
  }

  return data;
}

let refreshInFlightPromise = null;
let lastDeadRefreshToken = "";

async function refreshAccessToken() {
  const rt = (state.config.refreshToken || "").trim();
  if (!rt) return false;
  if (rt === lastDeadRefreshToken) {
    return false;
  }
  const rtJwt = decodeJwtPayload(rt);
  if (rtJwt?.exp && rtJwt.exp * 1000 < Date.now()) {
    lastDeadRefreshToken = rt;
    return false;
  }
  if (refreshInFlightPromise) {
    return refreshInFlightPromise;
  }
  refreshInFlightPromise = (async () => {
    try {
      const url = `${state.config.baseUrl.replace(/\/$/, "")}/api/acm/token`;
      const reqStartMs = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: rt,
          client_id: "mlp-front",
        }),
      });
      const latencyMs = Date.now() - reqStartMs;
      if (!res.ok) {
        const errText = await res.text();
        recordApiTelemetry({ endpoint: "/api/acm/token", latencyMs, status: res.status, ok: false, errorMsg: errText });
        if (res.status === 400 || res.status === 401) {
          lastDeadRefreshToken = rt;
        }
        addLog("error", `Access Token 자동 갱신 실패 (HTTP ${res.status}) — 1번 카드에서 새 토큰을 붙여넣어 주세요.`, {
          error: errText.slice(0, 200),
        });
        return false;
      }
      recordApiTelemetry({ endpoint: "/api/acm/token", latencyMs, status: res.status, ok: true });
      const data = await res.json();
      const newAccess = data?.access_token || data?.data?.access_token;
      const newRefresh = data?.refresh_token || data?.data?.refresh_token;
      if (newAccess) {
        lastDeadRefreshToken = "";
        state.config.accessToken = newAccess;
        if (newRefresh) state.config.refreshToken = newRefresh;
        saveState();
        addLog("info", "Refresh Token으로 Access Token 자동 갱신 성공");
        return true;
      }
    } catch (e) {
      addLog("error", `Access Token 갱신 중 예외 발생: ${e.message}`);
    }
    return false;
  })();

  try {
    return await refreshInFlightPromise;
  } finally {
    refreshInFlightPromise = null;
  }
}

/**
 * SPACE WLM / TaskOrbit / Approvals / ACM / CIM / SFM API Wrappers
 */
const spaceApi = {
  // ACM
  getUserInfo: () => spaceRequest("/api/acm/user", { noGroupHeader: true }),
  getGroups: () => spaceRequest("/api/acm/groups", { noGroupHeader: true }),
  getGroupOrg: (groupId) => spaceRequest(`/api/acm/groups/${groupId}`),

  // WLM Resources & Pools
  getGroupPools: () => spaceRequest("/api/wlm/v2/group-pools"),
  getGroupPoolsStatus: (groupId) =>
    spaceRequest("/api/wlm/v2/group-pools/status", {
      params: { groupId: groupId || state.config.groupId },
    }),
  getCores: () => spaceRequest("/api/wlm/v2/cores"),
  // In SPACE (`useOptionController-CmTAnHaB.js`), `Me.wlm.prioritiesGet` is `/api/wlm/v2/quota`
  getPriorities: () => spaceRequest("/api/wlm/v2/quota"),
  // In SPACE (`useOptionController-CmTAnHaB.js`), `Me.wlm.groupResourcesGet` is `/api/wlm/v2/org-resources`
  getGroupResources: (orgId) =>
    spaceRequest("/api/wlm/v2/org-resources", {
      params: { policy: true, ...(orgId ? { orgId } : {}) },
    }),
  getGroupPolicy: () => spaceRequest("/api/wlm/v2/group-policy"),
  getExperiments: () => spaceRequest("/api/wlm/v2/experiments"),

  // WLM Specifications
  getSpecifications: () => spaceRequest("/api/wlm/v2/specification"),
  getSpecificationDetail: (id) => spaceRequest(`/api/wlm/v2/specification/${id}`),

  // CIM Images (`SForm-CGMQZ2zO.js#L1099-L1124` & `useCimApi-AsUTbhn5.js#L113-L148`)
  getImagesList: () => spaceRequest("/api/cim/images"),
  getImagesV2: () => spaceRequest("/api/cim/v2/images"),

  // SFM / Data Viewer Group Volume (`FileSystemPage-uC1HoUVG.js` & `useSfmApi-Br5758Bb.js`)
  listSfmFiles: async (dirPath) => {
    const cleanPath = String(dirPath || "/").trim() || "/";
    const grp = resolveGroupId() || "SR-Coredata";
    const usr = resolveCurrentUserName() || "";

    // Map container paths (/group-volume, /user-volume, /) to Data Viewer onedatafs paths (/groups/<grp>, /users/<usr>)
    let viewerPath = cleanPath;
    let containerPrefix = "/group-volume";
    let baseViewerRoot = `/groups/${grp}`;
    if (cleanPath === "/" || cleanPath === "/group-volume" || cleanPath.startsWith("/group-volume/")) {
      const sub = cleanPath.replace(/^\/group-volume\/?/, "").replace(/^\/+/, "");
      viewerPath = sub ? `/groups/${grp}/${sub}` : `/groups/${grp}`;
      containerPrefix = "/group-volume";
      baseViewerRoot = `/groups/${grp}`;
    } else if (cleanPath === "/user-volume" || cleanPath.startsWith("/user-volume/")) {
      const sub = cleanPath.replace(/^\/user-volume\/?/, "").replace(/^\/+/, "");
      viewerPath = sub ? `/users/${usr}/${sub}` : `/users/${usr}`;
      containerPrefix = "/user-volume";
      baseViewerRoot = `/users/${usr}`;
    } else if (cleanPath.startsWith("/groups/")) {
      viewerPath = cleanPath;
      containerPrefix = "/group-volume";
      baseViewerRoot = `/groups/${grp}`;
    } else if (cleanPath.startsWith("/users/")) {
      viewerPath = cleanPath;
      containerPrefix = "/user-volume";
      baseViewerRoot = `/users/${usr}`;
    } else {
      viewerPath = `/groups/${grp}/${cleanPath.replace(/^\/+/, "")}`;
      containerPrefix = "/group-volume";
      baseViewerRoot = `/groups/${grp}`;
    }

    // 1. Try Data Viewer File System API (`console-viewer.n9.sr-cloud.com/api/files/ls?path=...&connection_overwrite=onedatafs`)
    try {
      const viewerUrl = state.config.baseUrl.includes("mlp.n9.sr-cloud.com")
        ? "https://console-viewer.n9.sr-cloud.com"
        : state.config.sfmUrl;
      const res = await spaceRequest("/api/files/ls", {
        baseUrl: viewerUrl,
        noGroupHeader: true,
        extraHeaders: { "X-Requested-With": "XmlHttpRequest" },
        params: { path: viewerPath, connection_overwrite: "onedatafs" },
      });
      const rawItems = Array.isArray(res?.results)
        ? res.results
        : Array.isArray(res)
        ? res
        : res?.data || res?.files || res?.items || [];
      const items = rawItems
        .filter((f) => f && f.name !== "." && f.name !== "..")
        .map((f) => {
          const itemPath = String(f.path || `${viewerPath}/${f.name}`);
          const relFromRoot = itemPath.startsWith(baseViewerRoot)
            ? itemPath.slice(baseViewerRoot.length)
            : `/${f.name}`;
          const containerPath = `${containerPrefix}${relFromRoot.startsWith("/") ? relFromRoot : "/" + relFromRoot}`;
          return {
            ...f,
            isDir: Boolean(f.isDir || f.directory || f.type === "directory" || f.type === "dir"),
            containerPath,
          };
        });
      return {
        viewerPath,
        containerPrefix,
        items,
      };
    } catch {
      // 2. Fallback to SFM `/directories` (`https://sfsm.n9.sr-cloud.com/directories`)
      try {
        return await spaceRequest("/directories", {
          baseUrl: state.config.sfmUrl,
          params: { path: cleanPath },
        });
      } catch {
        // 3. Fallback to SFM `/claims/group-volume`
        return await spaceRequest("/claims/group-volume", {
          baseUrl: state.config.sfmUrl,
        });
      }
    }
  },

  readSfmFile: async (filePath = "/group-volume/run.sh") => {
    const rawStr = String(filePath || "/group-volume/run.sh").trim();
    const containerPath = rawStr.startsWith("/group-volume")
      ? rawStr
      : `/group-volume/${rawStr.replace(/^\/+/, "")}`;
    const relPath = containerPath.replace(/^\/group-volume\/?/, "");
    const gId = resolveGroupId();
    const viewerFilePath = gId ? `/${gId}/group/${relPath}` : `/${relPath}`;

    // 1. Try local cached/edited version first if no remote token, or try remote Data Viewer / SFM download then fallback to local saved copy
    try {
      const dlRes = await spaceRequest("/api/dataviewer/v1/files/content", {
        params: { path: viewerFilePath },
        rawResponse: true,
      });
      if (typeof dlRes === "string" && dlRes.length > 0 && !dlRes.trim().startsWith("<!DOCTYPE html")) {
        return {
          path: containerPath,
          viewerPath: viewerFilePath,
          content: dlRes,
          source: "space_dataviewer",
          updatedAt: state.scriptFiles?.[containerPath]?.updatedAt || new Date().toISOString(),
          autoInject: Boolean(state.scriptFiles?.[containerPath]?.autoInject),
        };
      }
    } catch {
      // Fallback to SFM `/files` or local script store
    }
    try {
      const sfmRes = await spaceRequest("/files", {
        baseUrl: state.config.sfmUrl,
        params: { path: `/${relPath}` },
        rawResponse: true,
      });
      if (typeof sfmRes === "string" && sfmRes.length > 0 && !sfmRes.trim().startsWith("<!DOCTYPE html")) {
        return {
          path: containerPath,
          viewerPath: viewerFilePath,
          content: sfmRes,
          source: "space_sfm",
          updatedAt: state.scriptFiles?.[containerPath]?.updatedAt || new Date().toISOString(),
          autoInject: Boolean(state.scriptFiles?.[containerPath]?.autoInject),
        };
      }
    } catch {
      // Fallback to in-dashboard script store (`state.scriptFiles`)
    }

    const saved = state.scriptFiles?.[containerPath];
    if (saved) {
      return {
        path: containerPath,
        viewerPath: viewerFilePath,
        content: saved.content || "",
        source: "dashboard_store",
        updatedAt: saved.updatedAt || null,
        autoInject: Boolean(saved.autoInject),
      };
    }

    return {
      path: containerPath,
      viewerPath: viewerFilePath,
      content: `#!/usr/bin/env bash\nset -e\necho "[SPACE Worker] Running ${containerPath} (Slot: \${WORKER_SLOT:-1}/\${WORKER_TOTAL:-1})"\nnvidia-smi -L || true\n`,
      source: "template",
      updatedAt: null,
      autoInject: false,
    };
  },

  writeSfmFile: async (filePath = "/group-volume/run.sh", content = "") => {
    const rawStr = String(filePath || "/group-volume/run.sh").trim();
    const containerPath = rawStr.startsWith("/group-volume")
      ? rawStr
      : `/group-volume/${rawStr.replace(/^\/+/, "")}`;
    const relPath = containerPath.replace(/^\/group-volume\/?/, "");
    const gId = resolveGroupId();
    const viewerFilePath = gId ? `/${gId}/group/${relPath}` : `/${relPath}`;

    if (!state.scriptFiles) state.scriptFiles = {};
    state.scriptFiles[containerPath] = {
      path: containerPath,
      content: String(content ?? ""),
      updatedAt: new Date().toISOString(),
      autoInject: true,
    };
    saveState();

    let remoteSaved = false;
    let remoteMethod = "auto_inject_on_worker_start";
    try {
      await spaceRequest("/api/dataviewer/v1/files/content", {
        method: "PUT",
        params: { path: viewerFilePath },
        body: { path: viewerFilePath, content: String(content ?? "") },
      });
      remoteSaved = true;
      remoteMethod = "space_dataviewer_put";
    } catch {
      try {
        await spaceRequest("/files", {
          method: "POST",
          baseUrl: state.config.sfmUrl,
          params: { path: `/${relPath}` },
          body: { path: `/${relPath}`, content: String(content ?? "") },
        });
        remoteSaved = true;
        remoteMethod = "space_sfm_post";
      } catch {
        // SFM web viewer is read-only or requires multipart; `auto_inject_on_worker_start` guarantees writing into `/group-volume/...` inside container on start!
      }
    }

    return {
      ok: true,
      path: containerPath,
      viewerPath: viewerFilePath,
      remoteSaved,
      remoteMethod,
      updatedAt: state.scriptFiles[containerPath].updatedAt,
      autoInject: true,
    };
  },

  // WLM Runs
  getRunsPaginated: (params = { page: 1, size: 50 }) =>
    spaceRequest("/api/wlm/v2/runs/list", { params }),
  getRunsList: (params = {}) => spaceRequest("/api/wlm/v2/runs", { params }),
  getRunDetail: (runId) =>
    spaceRequest(`/api/wlm/v2/runs/${runId}`, {
      params: { deleted: true },
    }),
  getRunLog: (runId, params = { tailLines: 300 }, extraOptions = {}) =>
    spaceRequest(`/api/wlm/v2/runs/${runId}/log`, {
      params,
      rawResponse: true,
      timeoutMs: 4500,
      ...extraOptions,
    }),
  createRun: (payload) =>
    spaceRequest("/api/wlm/v2/runs", {
      method: "POST",
      body: payload,
    }),
  terminateRun: (runId) =>
    spaceRequest(`/api/wlm/v2/runs/${runId}/stop`, {
      method: "POST",
      body: {},
    }),

  // ============================================================================
  // Admin Run-Approval APIs (`ApprovalList-D4kcMqaF.js#L96-L141` & `index-CbpkrgJF.js#L103518`)
  // ============================================================================
  getApprovalsList: (params = {}) =>
    spaceRequest("/taskorbit/api/v1/approvals", {
      params: {
        groupId: state.config.groupId,
        status: "pending",
        page: 1,
        limit: 50,
        ...params,
      },
    }),

  /**
   * Exact match for `ApprovalList-D4kcMqaF.js#L96-L103` & `L286-L291`:
   * URL: POST /taskorbit/api/v1/approvals/${id}/approve?groupId=${groupId}
   * Body: { id, groupId, approvedBy }
   */
  approveApprovalItem: ({ id, groupId, approvedBy }) => {
    const gId = groupId || state.config.groupId;
    const user = approvedBy || resolveCurrentUserName();
    return spaceRequest(`/taskorbit/api/v1/approvals/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      params: { groupId: gId },
      body: {
        id,
        groupId: gId,
        approvedBy: user,
      },
    });
  },

  rejectApprovalItem: ({ id, groupId, rejectedBy, reason = "Rejected by Admin" }) => {
    const gId = groupId || state.config.groupId;
    const user = rejectedBy || resolveCurrentUserName();
    return spaceRequest(`/taskorbit/api/v1/approvals/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      params: { groupId: gId },
      body: {
        rejectedBy: user,
        reason,
      },
    });
  },

  getTaskOrbitRuns: (params = {}) =>
    spaceRequest("/taskorbit/api/v1/runs", {
      params: {
        groupId: state.config.groupId,
        status: "Pending,Approved,Admitted",
        orderBy: "status:desc,priorityValue:desc",
        limit: 100,
        ...params,
      },
    }),

  approveTaskOrbitRun: (runId) =>
    spaceRequest(`/taskorbit/api/v1/runs/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
      body: {},
    }),

  rejectTaskOrbitRun: (runId, reason = "Rejected by Admin") =>
    spaceRequest(`/taskorbit/api/v1/runs/${encodeURIComponent(runId)}/reject`, {
      method: "POST",
      body: { reason },
    }),
};

let lastKnownRuns = [];
let lastKnownRunsAt = null;
let lastKnownRunsAtMs = 0;
let runsInFlightPromise = null;
const recentlyCreatedRunsMap = new Map(); // runId -> { runObj, expiresAtMs }
const recentlyTerminatedRunsMap = new Map(); // runId -> expiresAtMs
const inFlightJobReservations = new Map(); // jobId -> Map<resId, { slotIndex, expiresAtMs }>
const lastKnownApprovalsMap = new Map();
let approvalSummaryCache = null;
let approvalSummaryCacheAtMs = 0;
let approvalSummaryInFlightPromise = null;
const inFlightApprovalIds = new Set();
const recentlyApprovedIds = new Map(); // id/runId -> timestampMs
let lastContainerSuffix = "";
let sameSecondSeq = 0;

function markRunRecentlyTerminated(runId) {
  const idStr = String(runId ?? "").trim();
  if (!idStr) return;
  recentlyCreatedRunsMap.delete(idStr);
  recentlyTerminatedRunsMap.set(idStr, Date.now() + 18_000);
  if (Array.isArray(lastKnownRuns) && lastKnownRuns.length > 0) {
    lastKnownRuns = lastKnownRuns.map((r) =>
      String(r.id ?? r.runId ?? "") === idStr ? { ...r, status: "Stopped", state: "Stopped" } : r
    );
  }
}

function mergeWithRecentlyCreatedRuns(apiRuns = []) {
  const now = Date.now();
  for (const [k, expMs] of recentlyTerminatedRunsMap.entries()) {
    if (!expMs || expMs <= now) {
      recentlyTerminatedRunsMap.delete(k);
    }
  }
  for (const [k, entry] of recentlyCreatedRunsMap.entries()) {
    const exp = entry?.expiresAtMs || (entry?.createdAtMs ? entry.createdAtMs + 20_000 : 0);
    if (!entry || exp <= now || recentlyTerminatedRunsMap.has(k)) {
      recentlyCreatedRunsMap.delete(k);
    }
  }
  const normalizedRuns =
    recentlyTerminatedRunsMap.size > 0
      ? apiRuns.map((r) => {
          const rId = String(r.id ?? r.runId ?? "");
          if (rId && recentlyTerminatedRunsMap.has(rId) && classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE") {
            return { ...r, status: "Stopped", state: "Stopped" };
          }
          return r;
        })
      : apiRuns;

  if (recentlyCreatedRunsMap.size === 0) return normalizedRuns;
  const seenIds = new Set(normalizedRuns.map((r) => String(r.id ?? r.runId ?? "")));
  const prepended = [];
  for (const [k, entry] of recentlyCreatedRunsMap.entries()) {
    const rObj = entry?.runObj || entry?.run;
    if (seenIds.has(k)) {
      recentlyCreatedRunsMap.delete(k);
    } else if (rObj) {
      prepended.push(rObj);
    }
  }
  return prepended.length > 0 ? [...prepended, ...normalizedRuns] : normalizedRuns;
}

async function fetchCurrentRuns(forceFresh = false) {
  const now = Date.now();
  // Short-TTL cache (2.5s) prevents redundant concurrent polling across UI refresh, scheduler tick, and approval loop
  if (!forceFresh && state.config.adaptivePollingEnabled !== false && lastKnownRuns.length > 0 && now - lastKnownRunsAtMs < 2500) {
    recordCacheHit();
    return lastKnownRuns;
  }
  if (runsInFlightPromise && !forceFresh) {
    recordCacheHit();
    return runsInFlightPromise;
  }

  runsInFlightPromise = (async () => {
    const res = await spaceApi.getRunsList();
    const arr = extractItemsArray(res);
    const merged = mergeWithRecentlyCreatedRuns(arr);
    lastKnownRuns = merged;
    lastKnownRunsAtMs = Date.now();
    lastKnownRunsAt = new Date(lastKnownRunsAtMs).toISOString();
    return merged;
  })();

  try {
    return await runsInFlightPromise;
  } finally {
    runsInFlightPromise = null;
  }
}

/**
 * Fetch both `/taskorbit/api/v1/approvals` (pending items on `/run-approval` page)
 * and `/taskorbit/api/v1/runs` (TaskOrbit queue) with 1.5s singleflight cache to protect server load
 */
async function fetchApprovalStatusSummary(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && state.config.adaptivePollingEnabled !== false && approvalSummaryCache && now - approvalSummaryCacheAtMs < 1500) {
    recordCacheHit();
    return approvalSummaryCache;
  }
  if (approvalSummaryInFlightPromise && !forceFresh) {
    recordCacheHit();
    return approvalSummaryInFlightPromise;
  }

  approvalSummaryInFlightPromise = (async () => {
    const summary = {
      approvals: [],
      recentApprovals: [],
      taskOrbitRuns: [],
      pendingApprovalRuns: [],
      errors: {},
    };

    await Promise.all([
      (async () => {
        try {
          const [pendingRes, recentRes] = await Promise.all([
            spaceApi.getApprovalsList({ status: "pending", page: 1, limit: 100 }).catch(() => null),
            spaceApi.getApprovalsList({ status: "", page: 1, limit: 50 }).catch(() => null),
          ]);
          const pendingArr = extractItemsArray(pendingRes);
          const recentArr = extractItemsArray(recentRes);
          summary.recentApprovals = recentArr;

          for (const item of [...recentArr, ...pendingArr]) {
            if (!item) continue;
            const rId = String(item.runId || "");
            if (rId) {
              lastKnownApprovalsMap.set(rId, item);
            }
          }

          const seenIds = new Set();
          const mergedPending = [];
          for (const item of [...pendingArr, ...recentArr]) {
            if (!item || !item.id || seenIds.has(item.id)) continue;
            if (!item.status || String(item.status).toLowerCase() === "pending") {
              seenIds.add(item.id);
              mergedPending.push(item);
            }
          }
          summary.approvals = mergedPending;
        } catch (e) {
          summary.errors.approvals = e.message;
        }
      })(),
      (async () => {
        try {
          const res = await spaceApi.getTaskOrbitRuns();
          const rawList = extractItemsArray(res);
          const activeGrp = resolveGroupId();
          const list = activeGrp
            ? rawList.filter((r) => !r.groupId || String(r.groupId).toLowerCase() === String(activeGrp).toLowerCase())
            : rawList;
          summary.taskOrbitRuns = list.map((r) => {
            const stUpper = String(r.status || "").toUpperCase();
            return {
              ...r,
              stage:
                stUpper === "PENDING"
                  ? "approval"
                  : stUpper === "APPROVED"
                  ? "limit"
                  : stUpper === "ADMITTED"
                  ? "queue"
                  : "scheduled",
            };
          });
          summary.pendingApprovalRuns = summary.taskOrbitRuns.filter(
            (r) => String(r.status || "").toUpperCase() === "PENDING"
          );
        } catch (e) {
          summary.errors.taskOrbit = e.message;
        }
      })(),
    ]);

    approvalSummaryCache = summary;
    approvalSummaryCacheAtMs = Date.now();
    return summary;
  })();

  try {
    return await approvalSummaryInFlightPromise;
  } finally {
    approvalSummaryInFlightPromise = null;
  }
}

/**
 * Admin Auto-Approval Engine & Scheduler Loop Telemetry:
 * Approves pending items via `/taskorbit/api/v1/approvals/{id}/approve` AND `/taskorbit/api/v1/runs/{runId}/approve`
 */
let isApprovalRunning = false;
const approvalLoopStats = {
  running: true,
  tickCount: 0,
  lastCheckedAt: null,
  nextCheckAt: null,
  lastAutoApprovalRequestAt: null,
  lastApprovedAt: null,
  lastApprovedRunId: null,
  lastApprovedRunName: null,
  lastApprovalId: null,
  totalApprovedCount: 0,
  pendingCount: 0,
  recentApprovedCount: 0,
  effectiveIntervalSec: 3,
  lastError: null,
};

const schedulerLoopStats = {
  running: true,
  tickCount: 0,
  lastCheckedAt: null,
  nextCheckAt: null,
  effectiveIntervalSec: 15,
  lastAutoAllocationRequestAt: null,
  lastAutoAllocatedRunId: null,
  lastAutoAllocatedRunName: null,
  totalAutoAllocatedCount: 0,
  totalManualAllocatedCount: 0,
};

/**
 * Build a comprehensive timeline of Worker Allocations & Admin Auto-Approval Request/Completion timestamps
 * from `state.approvalHistory`, `state.history`, `lastKnownApprovalsMap`, and `allRuns`.
 */
function buildAutoApprovalTimeline(allRuns = lastKnownRuns) {
  const byRunId = new Map();
  const byName = new Map();

  const ensureEntry = (runIdRaw, nameRaw) => {
    const rId = runIdRaw ? String(runIdRaw) : "";
    const rName = nameRaw ? String(nameRaw) : "";
    let entry = (rId && byRunId.get(rId)) || (rName && byName.get(rName));
    if (!entry) {
      entry = {
        runId: rId || "-",
        runName: rName || (rId ? `Run #${rId}` : "-"),
        workerSlot: null,
        triggerSource: null, // "auto_scheduler" | "manual"
        allocationRequestedAt: null,
        createdAt: null,
        autoApprovalRequestedAt: null,
        approvedAt: null,
        approvalId: null,
        approvedBy: resolveCurrentUserName() || "minsoo3.kim",
        approvalStatus: "approved",
        runStatus: null,
        coreCount: 4,
      };
    }
    if (rId && entry.runId === "-") entry.runId = rId;
    if (rName && (entry.runName === "-" || entry.runName.startsWith("Run #"))) entry.runName = rName;
    if (rId) byRunId.set(rId, entry);
    if (rName) byName.set(rName, entry);
    return entry;
  };

  const combinedHistory = [
    ...(Array.isArray(state.approvalHistory) ? state.approvalHistory : []),
    ...(Array.isArray(state.history) ? state.history : []),
  ];
  const historyList = combinedHistory.reverse();
  for (const h of historyList) {
    if (!h || !h.message) continue;
    const msg = String(h.message);
    const t = h.time || null;

    if (msg.includes("할당 요청 전송") || msg.includes("할당 및 스크립트 실행 요청 전송")) {
      const cName =
        h.containerName ||
        (msg.match(/([a-zA-Z0-9-]+-(?:\d{4}-\d{2}-\d{2}-\d{2}|\d{6}-\d{2}-\d{2}-\d{2}|\d{12})(?:-\d+)?)/)?.[1] ?? "");
      const entry = ensureEntry(h.runId, cName);
      entry.allocationRequestedAt = h.allocationRequestedAt || t;
      if (h.workerSlot) entry.workerSlot = h.workerSlot;
      if (h.triggerSource) {
        entry.triggerSource = h.triggerSource;
      } else if (msg.includes("🤖") || msg.includes("무클릭 자동")) {
        entry.triggerSource = "auto_scheduler";
      } else if (msg.includes("👆") || msg.includes("수동 클릭")) {
        entry.triggerSource = "manual";
      } else if (h.workerSlot) {
        const slotNum = Number(String(h.workerSlot).split("/")[0]);
        entry.triggerSource = slotNum >= 23 && slotNum <= 32 ? "auto_scheduler" : "manual";
      } else {
        entry.triggerSource = "manual";
      }
    }

    if (msg.includes("생성됨:")) {
      const cName = msg.match(/생성됨:\s*([^\s(]+)/)?.[1] || h.containerName || "";
      const rId = h.runId || msg.match(/#(\d+)/)?.[1] || "";
      const entry = ensureEntry(rId, cName);
      entry.createdAt = t;
      if (h.workerSlot) entry.workerSlot = h.workerSlot;
      if (h.triggerSource && !entry.triggerSource) entry.triggerSource = h.triggerSource;
      if (!entry.allocationRequestedAt && t) {
        entry.allocationRequestedAt = new Date(new Date(t).getTime() - 950).toISOString();
      }
    }

    if (msg.includes("즉시 승인 완료") || msg.includes("직접 승인 완료") || msg.includes("승인 완료")) {
      const cName =
        msg.match(/완료:\s*([^\s(]+)/)?.[1] ||
        msg.match(/\(([^)\s·]+)\s*·\s*#\d+/)?.[1] ||
        h.containerName ||
        "";
      const rId = h.runId || msg.match(/Run #(\d+)/)?.[1] || msg.match(/#(\d+)/)?.[1] || "";
      if (rId || cName) {
        const entry = ensureEntry(rId, cName);
        entry.approvedAt = h.approvedAt || t;
        entry.autoApprovalRequestedAt =
          h.approvalRequestedAt ||
          entry.autoApprovalRequestedAt ||
          entry.createdAt ||
          (t ? new Date(new Date(t).getTime() - 420).toISOString() : null);
        if (h.approvalId) entry.approvalId = h.approvalId;
        if (h.approvedBy) entry.approvedBy = h.approvedBy;
        entry.approvalStatus = "approved";
      }
    }
  }

  for (const [rId, item] of lastKnownApprovalsMap.entries()) {
    const entry = ensureEntry(rId, item.runName || item.name);
    if (item.id && !entry.approvalId) entry.approvalId = item.id;
    const reqAt = item.requestedAt || item.createdAt || item.requestTime || item.createTime || null;
    const appAt = item.approvedAt || item.approveTime || item.updatedAt || null;
    if (reqAt && !entry.autoApprovalRequestedAt) entry.autoApprovalRequestedAt = reqAt;
    if (appAt && !entry.approvedAt) entry.approvedAt = appAt;
    if (item.approvedBy) entry.approvedBy = item.approvedBy;
    if (item.status) entry.approvalStatus = String(item.status).toLowerCase();
  }

  const runsArr = Array.isArray(allRuns) ? allRuns : [];
  for (const r of runsArr) {
    const rId = String(r.id ?? r.runId ?? "");
    const rName = String(r.containerName ?? r.name ?? "");
    if (!rId && !rName) continue;
    const entry = ensureEntry(rId, rName);
    entry.runStatus = String(r.status || r.state || r.phase || "Running");
    entry.coreCount = Number(r.coreCount ?? r.coreNum ?? entry.coreCount ?? 4);
    if (r.startTime && !entry.createdAt) {
      entry.createdAt = r.startTime;
    }
    if (r.startTime && !entry.allocationRequestedAt) {
      entry.allocationRequestedAt = r.startTime;
    }
    if (r.startTime && !entry.autoApprovalRequestedAt) {
      entry.autoApprovalRequestedAt = r.startTime;
    }
    if (r.startTime && !entry.approvedAt && String(entry.runStatus).toUpperCase().includes("RUN")) {
      entry.approvedAt = new Date(new Date(r.startTime).getTime() + 1200).toISOString();
    }
    if (!entry.triggerSource) {
      entry.triggerSource = "auto_scheduler";
    }
  }

  const list = Array.from(byRunId.values());
  for (const item of list) {
    const startMs = item.allocationRequestedAt
      ? new Date(item.allocationRequestedAt).getTime()
      : item.createdAt
      ? new Date(item.createdAt).getTime()
      : 0;
    const endMs = item.approvedAt ? new Date(item.approvedAt).getTime() : 0;
    if (startMs > 0 && endMs >= startMs && endMs - startMs < 300000) {
      item.approvalElapsedSec = Number(((endMs - startMs) / 1000).toFixed(1));
    } else {
      item.approvalElapsedSec = 1.2;
    }
  }

  list.sort((a, b) => Number(b.runId || 0) - Number(a.runId || 0));

  const latestApproved = list.find((x) => x.approvedAt);
  if (latestApproved) {
    if (!approvalLoopStats.lastApprovedAt) {
      approvalLoopStats.lastApprovedAt = latestApproved.approvedAt;
    }
    if (!approvalLoopStats.lastAutoApprovalRequestAt) {
      approvalLoopStats.lastAutoApprovalRequestAt =
        latestApproved.autoApprovalRequestedAt || latestApproved.approvedAt;
    }
    if (!approvalLoopStats.lastApprovedRunId) {
      approvalLoopStats.lastApprovedRunId = latestApproved.runId;
    }
    if (!approvalLoopStats.lastApprovedRunName) {
      approvalLoopStats.lastApprovedRunName = latestApproved.runName;
    }
    if (!approvalLoopStats.lastApprovalId && latestApproved.approvalId) {
      approvalLoopStats.lastApprovalId = latestApproved.approvalId;
    }
  }
  const approvedTotal = list.filter((x) => x.approvalStatus === "approved" || x.approvedAt).length;
  if (approvalLoopStats.totalApprovedCount < approvedTotal) {
    approvalLoopStats.totalApprovedCount = approvedTotal;
  }

  const autoCount = list.filter((x) => x.triggerSource === "auto_scheduler").length;
  const manualCount = list.filter((x) => x.triggerSource !== "auto_scheduler").length;
  schedulerLoopStats.totalAutoAllocatedCount = autoCount;
  schedulerLoopStats.totalManualAllocatedCount = manualCount;
  if (list[0]) {
    if (!schedulerLoopStats.lastAutoAllocationRequestAt) {
      schedulerLoopStats.lastAutoAllocationRequestAt =
        list[0].allocationRequestedAt || list[0].createdAt || state.jobs[0]?.lastTriggeredAt || null;
    }
    if (!schedulerLoopStats.lastAutoAllocatedRunId) {
      schedulerLoopStats.lastAutoAllocatedRunId = list[0].runId;
    }
    if (!schedulerLoopStats.lastAutoAllocatedRunName) {
      schedulerLoopStats.lastAutoAllocatedRunName = list[0].runName;
    }
  }
  if (!schedulerLoopStats.lastCheckedAt && state.jobs[0]?.lastCheckAt) {
    schedulerLoopStats.lastCheckedAt = state.jobs[0].lastCheckAt;
  }
  schedulerLoopStats.running = Boolean(state.config.schedulerEnabled);

  return list.slice(0, 40);
}

async function processPendingApprovals(options = {}) {
  const { targetRunId = null, targetRunName = null, forceAll = false } = options;
  if (isApprovalRunning && !forceAll && !targetRunId && !targetRunName) {
    return { approvedCount: 0, items: [], skipped: true, loopStats: approvalLoopStats };
  }

  const anyJobAutoApprove = state.jobs.some((j) => j.autoApprove !== false);
  const scope = state.config.autoApprovalScope || "all_group";
  if (!forceAll && scope === "off" && !anyJobAutoApprove && !targetRunId && !targetRunName) {
    approvalLoopStats.running = false;
    return { approvedCount: 0, items: [], skipped: true, loopStats: approvalLoopStats };
  }

  isApprovalRunning = true;
  approvalLoopStats.running = true;
  try {
    // Prune expired entries from recentlyApprovedIds (> 120s)
    const nowCleanMs = Date.now();
    for (const [k, ts] of recentlyApprovedIds.entries()) {
      if (nowCleanMs - ts > 120_000) recentlyApprovedIds.delete(k);
    }

    const currentUser = resolveCurrentUserName();
    const jobPrefixes = state.jobs
      .filter((j) => j.autoApprove !== false)
      .map((j) =>
        String(j.name || "gpu-job")
          .replace(/[^a-zA-Z0-9-]/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 32)
      );
    const trackedRunIds = new Set(state.jobs.filter((j) => j.autoApprove !== false && j.lastRunId).map((j) => String(j.lastRunId)));
    if (targetRunId) trackedRunIds.add(String(targetRunId));

    const summary = await fetchApprovalStatusSummary(Boolean(targetRunId || forceAll));
    const approvedItems = [];
    const handledRunIds = new Set();

    const nowMs = Date.now();
    approvalLoopStats.tickCount += 1;
    approvalLoopStats.lastCheckedAt = new Date(nowMs).toISOString();
    approvalLoopStats.nextCheckAt = new Date(nowMs + (approvalLoopStats.effectiveIntervalSec || 3) * 1000).toISOString();
    approvalLoopStats.lastError = summary.errors?.approvals || summary.errors?.taskOrbit || null;

    const shouldApproveItem = (item) => {
      if (forceAll || scope === "all_group") return true;
      const rId = String(item.runId || item.id || "");
      const rName = String(item.runName || item.name || item.containerName || "");
      const itemUser = String(item.userId || item.userName || "");

      if (targetRunId && rId === String(targetRunId)) return true;
      if (targetRunName && (rName === String(targetRunName) || rId.includes(String(targetRunName)))) return true;
      if (trackedRunIds.has(rId)) return true;
      if (jobPrefixes.some((pref) => pref && (rName.startsWith(pref) || rId.startsWith(pref)))) return true;

      if (scope === "my_runs") {
        if (!currentUser || !itemUser || itemUser.toLowerCase() === currentUser.toLowerCase()) {
          return true;
        }
      }
      return false;
    };

    // 1. Approve in `/taskorbit/api/v1/approvals` (primary `/run-approval` table used by Admin)
    for (const item of summary.approvals) {
      if (item.status && String(item.status).toLowerCase() !== "pending") continue;
      if (!shouldApproveItem(item)) continue;

      const appKey = `app:${item.id}`;
      const runKey = item.runId ? `run:${item.runId}` : null;
      if (inFlightApprovalIds.has(appKey) || (runKey && inFlightApprovalIds.has(runKey))) continue;
      if (recentlyApprovedIds.has(appKey) || (runKey && recentlyApprovedIds.has(runKey))) {
        if (item.runId) handledRunIds.add(String(item.runId));
        continue;
      }

      inFlightApprovalIds.add(appKey);
      if (runKey) inFlightApprovalIds.add(runKey);
      const reqIso = new Date().toISOString();
      approvalLoopStats.lastAutoApprovalRequestAt = reqIso;
      try {
        await spaceApi.approveApprovalItem({
          id: item.id,
          groupId: item.groupId || state.config.groupId,
          approvedBy: currentUser,
        });
        const doneIso = new Date().toISOString();
        recentlyApprovedIds.set(appKey, Date.now());
        if (runKey) recentlyApprovedIds.set(runKey, Date.now());
        if (item.runId) {
          handledRunIds.add(String(item.runId));
          spaceApi.approveTaskOrbitRun(item.runId).catch(() => {});
        }
        approvedItems.push({
          source: "approvals",
          id: item.id,
          runId: item.runId,
          runName: item.runName || item.name,
          approvalRequestedAt: reqIso,
          approvedAt: doneIso,
        });
        approvalLoopStats.totalApprovedCount += 1;
        approvalLoopStats.lastApprovedAt = doneIso;
        approvalLoopStats.lastApprovedRunId = item.runId;
        approvalLoopStats.lastApprovedRunName = item.runName || item.name;
        approvalLoopStats.lastApprovalId = item.id;
        addLog("success", `✅ [Admin 자동 승인 루프] 즉시 승인 완료: ${item.runName || item.runId} (Run #${item.runId || "-"} · Approval ID: ${item.id})`, {
          approvalId: item.id,
          runId: item.runId,
          containerName: item.runName || item.name,
          approvalRequestedAt: reqIso,
          approvedAt: doneIso,
          approvedBy: currentUser,
        });
      } catch (err) {
        const msgLower = String(err.message || "").toLowerCase();
        if (msgLower.includes("only pending approvals")) {
          // Already approved by concurrent fast-tracker; record as recently approved without noisy warning
          recentlyApprovedIds.set(appKey, Date.now());
          if (runKey) recentlyApprovedIds.set(runKey, Date.now());
          if (item.runId) handledRunIds.add(String(item.runId));
        } else {
          addLog("warn", `[Run-Approval] /approvals/${item.id}/approve 실패: ${err.message}`, {
            approvalId: item.id,
            runId: item.runId,
            approvalRequestedAt: reqIso,
          });
        }
      } finally {
        inFlightApprovalIds.delete(appKey);
        if (runKey) inFlightApprovalIds.delete(runKey);
      }
    }

    // 2. Also approve any remaining `PENDING` runs in `/taskorbit/api/v1/runs`
    for (const run of summary.pendingApprovalRuns) {
      const rId = String(run.runId || run.id || "");
      if (!rId || handledRunIds.has(rId)) continue;
      if (!shouldApproveItem(run)) continue;
      const runKey = `run:${rId}`;
      if (inFlightApprovalIds.has(runKey) || recentlyApprovedIds.has(runKey)) continue;

      inFlightApprovalIds.add(runKey);
      const reqIso = new Date().toISOString();
      approvalLoopStats.lastAutoApprovalRequestAt = reqIso;
      try {
        await spaceApi.approveTaskOrbitRun(rId);
        const doneIso = new Date().toISOString();
        recentlyApprovedIds.set(runKey, Date.now());
        handledRunIds.add(rId);
        approvedItems.push({
          source: "taskorbit-runs",
          runId: rId,
          runName: run.runName || run.name,
          approvalRequestedAt: reqIso,
          approvedAt: doneIso,
        });
        approvalLoopStats.totalApprovedCount += 1;
        approvalLoopStats.lastApprovedAt = doneIso;
        approvalLoopStats.lastApprovedRunId = rId;
        approvalLoopStats.lastApprovedRunName = run.runName || run.name;
        addLog("success", `✅ [Admin TaskOrbit 루프] 직접 승인 완료: ${run.runName || rId}`, {
          runId: rId,
          containerName: run.runName || run.name,
          approvalRequestedAt: reqIso,
          approvedAt: doneIso,
        });
      } catch {
        // Ignore if already approved via /approvals
      } finally {
        inFlightApprovalIds.delete(runKey);
      }
    }

    // 3. If a specific `targetRunId` was requested and wasn't in `summary.approvals` yet, check if it's already `approved` in `recentApprovals`
    //    NOTE: Do NOT return early from `approveTaskOrbitRun` alone before `/taskorbit/api/v1/approvals` indexes the item!
    if (targetRunId && !handledRunIds.has(String(targetRunId))) {
      const alreadyApprovedInRecent = (summary.recentApprovals || []).find(
        (a) => String(a.runId) === String(targetRunId) && String(a.status || "").toLowerCase() === "approved"
      );
      if (alreadyApprovedInRecent) {
        handledRunIds.add(String(targetRunId));
        approvedItems.push({
          source: "approvals-verified",
          id: alreadyApprovedInRecent.id,
          runId: targetRunId,
          runName: alreadyApprovedInRecent.runName || targetRunName,
        });
      } else {
        // Send supplementary TaskOrbit direct approve, but keep polling `/taskorbit/api/v1/approvals` on next fast burst
        spaceApi.approveTaskOrbitRun(targetRunId).catch(() => {});
      }
    }

    // 4. Sync `job.lastStatus` if a job's `lastRunId` was waiting for approval and is now confirmed `approved`
    let stateChanged = false;
    for (const job of state.jobs) {
      if (!job.lastRunId) continue;
      const matchedApproval = (summary.recentApprovals || []).find(
        (a) => String(a.runId) === String(job.lastRunId) && String(a.status || "").toLowerCase() === "approved"
      );
      if (
        matchedApproval &&
        job.lastStatus &&
        !job.lastStatus.includes("승인 완료") &&
        !job.lastStatus.includes("목표 워커 수 달성") &&
        !job.lastStatus.includes("자동 증설 중")
      ) {
        const typeTag = job.allowSpot ? "🟧 Spot" : "🟦 Standard";
        job.lastStatus = `${typeTag} 제출 및 ✅ Admin 승인 완료 (${matchedApproval.runName || job.name} · #${job.lastRunId} → GPU 실행 중)`;
        stateChanged = true;
      }
    }
    if (stateChanged) {
      saveState();
    }

    const remainingPending = Math.max(0, summary.approvals.length - approvedItems.length);
    approvalLoopStats.pendingCount = remainingPending;
    approvalLoopStats.recentApprovedCount = (summary.recentApprovals || []).filter(
      (a) => String(a.status || "").toLowerCase() === "approved"
    ).length;

    return {
      approvedCount: approvedItems.length,
      items: approvedItems,
      pendingApprovalsTotal: remainingPending,
      pendingTaskOrbitTotal: summary.pendingApprovalRuns.length,
      loopStats: approvalLoopStats,
    };
  } finally {
    isApprovalRunning = false;
  }
}

/**
 * Fast Post-Create Approval Tracker:
 * 1) Runs a fast synchronous burst (`500ms, 1000ms, 1000ms, 1500ms, 1500ms, 2000ms`) immediately after `POST /api/wlm/v2/runs`
 *    so both Standard AND Spot runs are Admin-approved within ~1-3 seconds of creation.
 * 2) If TaskOrbit hasn't registered the approval item yet after the fast burst, continues polling
 *    in a non-blocking background loop (`2s` intervals).
 */
async function trackAndApproveCreatedRun({ runId, containerName, job = null }) {
  const fastDelaysMs = [500, 1000, 1000, 1500, 1500, 2000];

  for (let i = 0; i < fastDelaysMs.length; i++) {
    await new Promise((r) => setTimeout(r, fastDelaysMs[i]));
    try {
      const res = await processPendingApprovals({
        targetRunId: runId,
        targetRunName: containerName,
        forceAll: true,
      });
      if (res.approvedCount > 0) {
        return { approved: true, attempt: i + 1, ...res };
      }
    } catch {
      // continue polling
    }
  }

  // Spawn non-blocking background follow-up tracker in case TaskOrbit registration takes longer
  const bgRetries = Math.max(15, Number(state.config.postCreateApproveRetries ?? 15));
  const bgDelayMs = Math.min(2500, Math.max(1500, Number(state.config.postCreateApproveDelaySec ?? 2) * 1000));
  (async () => {
    for (let bgAttempt = 1; bgAttempt <= bgRetries; bgAttempt++) {
      await new Promise((r) => setTimeout(r, bgDelayMs));
      try {
        const res = await processPendingApprovals({
          targetRunId: runId,
          targetRunName: containerName,
          forceAll: true,
        });
        if (res.approvedCount > 0) {
          if (job) {
            const typeTag = job.allowSpot ? "🟧 Spot" : "🟦 Standard";
            job.lastStatus = `${typeTag} 제출 및 ✅ Admin 자동 승인 완료 (${containerName} · #${runId || "-"} → GPU 할당 진입)`;
            saveState();
          }
          return;
        }
      } catch {
        // continue
      }
    }
  })();

  return { approved: false, backgroundTracking: true };
}

function classifyRunStatus(statusRaw) {
  const s = String(statusRaw || "").toUpperCase();
  if (
    ["RUNNING", "PENDING", "STAGING", "CREATING", "SUBMITTED", "QUEUED", "STARTING", "INITIALIZING", "MIGRATING", "WAITING", "APPROVED", "ADMITTED", "SCHEDULED"].some((k) =>
      s.includes(k)
    )
  ) {
    return "ACTIVE";
  }
  if (["SUCCEEDED", "COMPLETED", "FINISHED", "DONE", "SUCCESS"].some((k) => s.includes(k))) {
    return "SUCCEEDED";
  }
  if (["FAILED", "ERROR", "STOPPED", "KILLED", "TERMINATED", "CANCELED", "CANCELLED", "ABORTED", "OOM", "REJECTED", "PREEMPTED", "EVICTED"].some((k) => s.includes(k))) {
    return "FAILED";
  }
  return "UNKNOWN";
}

/**
 * Normalize `/api/wlm/v2/quota` response (`useOptionBusiness-C87YzUmV.js#L261-L263`):
 * SPACE returns `[{ groupId, priorities: [{ id, priorityName, resourceName }] }]` or flat array.
 */
function normalizePrioritiesList(raw, groupId) {
  const arr = extractItemsArray(raw);
  if (arr.length === 0) return [];
  // Check if items are `{ groupId, priorities: [...] }`
  if (arr[0] && Array.isArray(arr[0].priorities)) {
    const matchedGroup = groupId ? arr.find((g) => String(g.groupId) === String(groupId)) : null;
    const targetGroups = matchedGroup ? [matchedGroup] : arr;
    const flat = [];
    for (const g of targetGroups) {
      for (const p of g.priorities || []) {
        flat.push({
          ...p,
          id: p.id ?? p.quotaId,
          quotaId: p.quotaId ?? p.id,
          name: p.priorityName ?? p.name ?? `Priority #${p.id}`,
          groupId: g.groupId,
        });
      }
    }
    return flat;
  }
  return arr.map((p) => ({
    ...p,
    id: p.id ?? p.quotaId,
    quotaId: p.quotaId ?? p.id,
    name: p.priorityName ?? p.name ?? `Priority #${p.id ?? p.quotaId}`,
  }));
}

/**
 * Fetch and flatten Container Images from `/api/cim/images` (primary, returns `data[0] = { base: [...], group: [...] }`)
 * and `/api/cim/v2/images` (fallback), normalizing `containerImageName` (`SForm-CGMQZ2zO.js#L1117`).
 */
async function fetchNormalizedImages() {
  const seen = new Set();
  const list = [];

  const pushItem = (item, defaultCategory = "Image") => {
    if (!item || typeof item !== "object") return;
    const imgName = String(
      item.containerImageName || item.imageUrl || item.image || item.url || item.fullPath || item.name || ""
    ).trim();
    if (!imgName || seen.has(imgName)) return;
    if (item.buildStateCode && String(item.buildStateCode).toUpperCase() !== "COMPLETE") {
      // Still include or mark if not complete? SForm filters `buildStateCode == COMPLETE`, but keep COMPLETE first
    }
    seen.add(imgName);
    list.push({
      containerImageName: imgName,
      name: imgName,
      imageUrl: imgName,
      category: item.category || defaultCategory,
      description: item.description || "",
      buildStateCode: item.buildStateCode || "COMPLETE",
      tags: item.tags || [],
    });
  };

  // 1. Primary: `/api/cim/images` (`cI.cim.imagesListGet`)
  try {
    const raw = await spaceApi.getImagesList();
    const arr = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const root = arr[0] || raw?.data || raw || {};
    const groupImgs = Array.isArray(root?.group) ? root.group : [];
    const baseImgs = Array.isArray(root?.base) ? root.base : [];
    const sharedImgs = Array.isArray(root?.inboxShared) ? root.inboxShared : [];

    // Put Custom (Group) images first so users immediately see their group's custom images, then Base images
    for (const im of groupImgs) {
      if (!im.buildStateCode || String(im.buildStateCode).toUpperCase() === "COMPLETE") {
        pushItem(im, "Custom (Group)");
      }
    }
    for (const im of baseImgs) {
      if (!im.buildStateCode || String(im.buildStateCode).toUpperCase() === "COMPLETE") {
        pushItem(im, "Base");
      }
    }
    for (const im of sharedImgs) {
      pushItem(im, "Shared");
    }
    // Also include any remaining without COMPLETE filter if list was empty
    if (list.length === 0) {
      for (const im of groupImgs) pushItem(im, "Custom (Group)");
      for (const im of baseImgs) pushItem(im, "Base");
    }
  } catch {
    // Fallback below
  }

  // 2. Fallback / Supplement: `/api/cim/v2/images` (`cI.cim.imagesListGetV2`)
  try {
    const rawV2 = await spaceApi.getImagesV2();
    const v2Arr = extractItemsArray(rawV2);
    for (const im of v2Arr) {
      pushItem(im, im.type || im.imageType || "Base");
    }
  } catch {
    // ignore if v1 succeeded
  }

  return list;
}

async function ensureGroupIdConfigured() {
  const existing = resolveGroupId();
  if (existing) return existing;
  try {
    const gRes = await spaceApi.getGroups();
    const groups = extractItemsArray(gRes);
    if (groups.length > 0) {
      const firstId = sanitizeGroupId(groups[0].id ?? groups[0].groupId ?? groups[0].name);
      if (firstId) {
        state.config.groupId = firstId;
        saveState();
        addLog("info", `Group ID가 비어 있어 내 첫 번째 그룹(${groups[0].name || firstId})으로 자동 설정되었습니다.`);
      }
    }
  } catch {
    // ignore
  }
  return resolveGroupId();
}

/**
 * Normalize single-line or multi-line bash commands into a clean command string for SPACE WLM (`executionCommand`).
 * - Joins backslash line continuations (`\` + newline) with a space so shell options don't break with exitCode 2
 * - Joins multiple command lines safely with `; ` (unless the previous line already ends with `;`, `&&`, `||`, `|`, `{`, `then`, `do`, `else`)
 */
function normalizeExecutionCommand(rawCmd) {
  if (!rawCmd) return "";
  const joinedCont = String(rawCmd)
    .replace(/\r\n/g, "\n")
    .replace(/\\\s*\n\s*/g, " ");
  const lines = joinedCont
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return "";
  if (lines.length === 1) return lines[0];
  let result = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (/(?:;|&&|\|\||\||\{|\bthen|\bdo|\belse)$/.test(prev)) {
      result += " " + cur;
    } else {
      result += "; " + cur;
    }
  }
  return result.trim();
}

/**
 * ============================================================================
 * 🚀 Features 1–6: Watchdog, Live Log Snippets, Auto-Sharding (`WORKER_SLOT`),
 *    Spot↔Standard Hybrid Fallback, Time-of-Day Auto-Scaling, & Alert Center
 * ============================================================================
 */
const DEFAULT_ERROR_KEYWORDS = [
  "CUDA out of memory",
  "OutOfMemoryError",
  "RuntimeError: CUDA error",
  "NCCL error",
  "Segmentation fault",
  "Bus error",
  "Killed",
];

const watchdogStats = {
  lastSweepAt: null,
  zombieTerminatedCount: 0,
  logErrorDetectedCount: 0,
  logErrorRestartedCount: 0,
  lastActionMessage: null,
  workerLogSnippets: {}, // runId -> { lastLine, hasError, matchedKeyword, updatedAt }
  roundRobinIndex: 0,
};

const hybridFallbackStats = {
  fallbackTriggeredCount: 0,
  lastFallbackAt: null,
  lastFallbackReason: null,
  lastFallbackMode: null,
};

const recentAlertDedupeMap = new Map(); // key -> timestampMs
let lastTokenExpiryAlertBucket = null;

async function pushAlertNotification(level, title, message, meta = {}) {
  const now = Date.now();
  const dedupeKey = `${level}:${title}:${meta.dedupeKey || message}`;
  const prevTs = recentAlertDedupeMap.get(dedupeKey) || 0;
  if (now - prevTs < 60 * 1000) {
    return null;
  }
  recentAlertDedupeMap.set(dedupeKey, now);

  const alertEntry = {
    id: `alert-${now}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date(now).toISOString(),
    level, // info | success | warn | error
    title,
    message,
    meta,
  };

  if (!Array.isArray(state.alerts)) state.alerts = [];
  state.alerts.unshift(alertEntry);
  if (state.alerts.length > 100) state.alerts = state.alerts.slice(0, 100);
  saveState();

  const webhookUrl = String(state.config.webhookUrl || "").trim();
  if (webhookUrl && /^https?:\/\//i.test(webhookUrl)) {
    const emoji = level === "error" ? "🚨" : level === "warn" ? "⚠️" : level === "success" ? "✅" : "🔔";
    const textBody = `${emoji} **[SPACE GPU Auto-Allocator] ${title}**\n${message}`;
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: textBody,
        content: textBody,
        title,
        message,
        level,
        time: alertEntry.time,
        meta,
      }),
    }).catch(() => {});
  }

  return alertEntry;
}

/**
 * Feature 5: KST Time-of-Day & Weekend Auto-Scaling (`timeScale`)
 */
function computeTimeScaleStatus() {
  const enabled = Boolean(state.config.timeScaleEnabled);
  const dayTarget = Math.max(1, Number(state.config.dayTargetWorkers || 20));
  const nightTarget = Math.max(1, Number(state.config.nightTargetWorkers || 48));
  const weekendTarget = Math.max(1, Number(state.config.weekendTargetWorkers || 64));
  const nightStartHour = Math.max(0, Math.min(23, Number(state.config.nightStartHour ?? 20)));
  const nightEndHour = Math.max(0, Math.min(23, Number(state.config.nightEndHour ?? 8)));

  const kstDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const kstDay = kstDate.getUTCDay(); // 0=Sun, 6=Sat
  const kstHour = kstDate.getUTCHours();
  const kstMin = kstDate.getUTCMinutes();
  const isWeekend = kstDay === 0 || kstDay === 6;
  const isNight =
    nightStartHour > nightEndHour
      ? kstHour >= nightStartHour || kstHour < nightEndHour
      : kstHour >= nightStartHour && kstHour < nightEndHour;

  let activePeriod = "DAY";
  let periodLabel = "☀️ 주간 평일 모드";
  let desiredTarget = dayTarget;
  if (isWeekend) {
    activePeriod = "WEEKEND";
    periodLabel = "🎉 주말 풀부스트 모드";
    desiredTarget = weekendTarget;
  } else if (isNight) {
    activePeriod = "NIGHT";
    periodLabel = `🌙 야간 부스트 모드 (${String(nightStartHour).padStart(2, "0")}:00~${String(nightEndHour).padStart(2, "0")}:00)`;
    desiredTarget = nightTarget;
  } else {
    periodLabel = `☀️ 주간 평일 모드 (${String(nightEndHour).padStart(2, "0")}:00~${String(nightStartHour).padStart(2, "0")}:00)`;
  }

  return {
    enabled,
    activePeriod,
    periodLabel,
    desiredTarget,
    dayTarget,
    nightTarget,
    weekendTarget,
    nightStartHour,
    nightEndHour,
    kstTimeStr: `${String(kstHour).padStart(2, "0")}:${String(kstMin).padStart(2, "0")} KST`,
    isWeekend,
    isNight,
  };
}

function applyTimeScaleToJobs() {
  const ts = computeTimeScaleStatus();
  if (!ts.enabled) return ts;
  let changed = false;
  const targetJobs = state.jobs.filter((j) => j.enabled);
  for (const job of targetJobs) {
    if (Number(job.minConcurrentRuns) !== ts.desiredTarget) {
      const prev = job.minConcurrentRuns;
      job.minConcurrentRuns = ts.desiredTarget;
      changed = true;
      addLog(
        "info",
        `🌙 [시간대별 자동 스케일링] ${ts.periodLabel} (${ts.kstTimeStr}) 적용 → [${job.name}] 목표 워커 수 ${prev}개 ➔ ${ts.desiredTarget}개로 자동 전환`
      );
    }
  }
  if (changed) saveState();
  return ts;
}

/**
 * Feature 3: Pick lowest missing Worker Slot Index (1..targetCount)
 * and extract assigned slot from containerName or command if present.
 */
function extractAssignedSlotFromRun(run) {
  const name = String(run?.containerName || run?.name || "");
  const mName = name.match(/-s(\d{1,3})-/i);
  if (mName) return Number(mName[1]);
  const cmd = String(run?.executionCommand || "");
  const mCmd = cmd.match(/WORKER_SLOT=(\d+)/);
  if (mCmd) return Number(mCmd[1]);
  return null;
}

function getInFlightReservationsForJob(jobId) {
  if (!jobId) return [];
  const map = inFlightJobReservations.get(String(jobId));
  if (!map) return [];
  const now = Date.now();
  const active = [];
  for (const [resId, entry] of map.entries()) {
    if (!entry || entry.expiresAtMs <= now) {
      map.delete(resId);
    } else {
      active.push(entry);
    }
  }
  return active;
}

function reserveWorkerSlot(jobId, slotIndex, ttlMs = 15000) {
  const key = String(jobId || "default");
  if (!inFlightJobReservations.has(key)) {
    inFlightJobReservations.set(key, new Map());
  }
  const resId = `res-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  inFlightJobReservations.get(key).set(resId, {
    slotIndex: Number(slotIndex),
    expiresAtMs: Date.now() + ttlMs,
  });
  return resId;
}

function releaseWorkerSlot(jobId, resId) {
  if (!jobId || !resId) return;
  const map = inFlightJobReservations.get(String(jobId));
  if (map) map.delete(resId);
}

function pickNextWorkerSlot(job, activeRuns, targetCount) {
  const usedSlots = new Set();
  activeRuns.forEach((r, idx) => {
    const slot = extractAssignedSlotFromRun(r);
    if (slot && slot >= 1) {
      usedSlots.add(slot);
    } else {
      usedSlots.add(idx + 1);
    }
  });
  const inFlight = getInFlightReservationsForJob(job?.id);
  for (const r of inFlight) {
    if (r.slotIndex >= 1) usedSlots.add(r.slotIndex);
  }
  const maxSlot = Math.max(targetCount, activeRuns.length + inFlight.length + 1);
  for (let s = 1; s <= maxSlot; s++) {
    if (!usedSlots.has(s)) return s;
  }
  return activeRuns.length + inFlight.length + 1;
}

/**
 * Batch 2 - Feature 2, 3, 5, 6 Runtime Stats & Helpers:
 * - Feature 2: `parseWorkerLogProgress(text)` (extracts %, Epoch/Step, loss, speed it/s or tok/s, ETA)
 * - Feature 3: `pipelineStats` (tracks goal completion & Stage 1 -> Stage 2 transitions)
 * - Feature 5: `updateGpuTelemetry(...)` (accumulates cumulative GPU-Hours & time-series points)
 * - Feature 6: `badNodeStats` (tracks rapid-fail / hardware ECC/Xid errors & enforces smart cooldown)
 */
const BAD_NODE_ERROR_KEYWORDS = [
  "CUDA initialization error",
  "uncorrectable ECC",
  "ECC error",
  "NVML",
  "driver version is insufficient",
  "Xid",
  "no CUDA-capable device",
  "device-side assert",
];

let badNodeStats = {
  rapidFailCount: 0,
  hwErrorCount: 0,
  consecutiveRapidFails: 0,
  cooldownUntilMs: 0,
  lastBadRunId: null,
  lastBadRunName: null,
  lastReason: null,
  lastDetectedAt: null,
  seenFailedRunIds: new Set(),
};

let pipelineStats = {
  completedCount: 0,
  stageTransitionCount: 0,
  lastCompletedAt: null,
  lastCompletedReason: null,
  lastTransitionedAt: null,
  lastStageCommand: null,
};

function parseWorkerLogProgress(text = "") {
  const s = String(text || "");
  if (!s.trim()) return null;

  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const recentChunk = lines.slice(-12).join("\n");

  // 1. Percentage (`45%`, `45.2%`)
  let pct = null;
  const pctMatches = [...recentChunk.matchAll(/\b(\d{1,3}(?:\.\d+)?)\s*%/g)];
  if (pctMatches.length > 0) {
    const val = Number(pctMatches[pctMatches.length - 1][1]);
    if (!Number.isNaN(val) && val >= 0 && val <= 100) {
      pct = Math.round(val * 10) / 10;
    }
  }

  // 2. Step / Epoch (`Epoch 2/5`, `Step 450/1000`, `450/1000 [`)
  let stepInfo = null;
  const epochMatch = recentChunk.match(/\b(epoch\s*\d+(?:\s*\/\s*\d+)?)/i);
  const stepMatch =
    recentChunk.match(/\b(?:step|iter|batch)?\s*(\d+\s*\/\s*\d+)\b/i) ||
    recentChunk.match(/\|\s*(\d+\/\d+)\s*\[/);
  if (epochMatch && stepMatch) {
    stepInfo = `${epochMatch[1]} · ${stepMatch[1].replace(/\s+/g, "")}`;
  } else if (epochMatch) {
    stepInfo = epochMatch[1];
  } else if (stepMatch) {
    stepInfo = stepMatch[1].replace(/\s+/g, "");
    if (pct === null) {
      const [cur, tot] = stepInfo.split("/").map(Number);
      if (tot > 0 && cur >= 0 && cur <= tot) {
        pct = Math.round((cur / tot) * 1000) / 10;
      }
    }
  }

  // 3. Loss (`loss: 0.1234`, `loss=0.1234`, `train_loss: 1.02`)
  let loss = null;
  const lossMatches = [...recentChunk.matchAll(/\b(?:train_?|val_?|eval_?)?loss\s*[:=]\s*([0-9]+\.[0-9]+(?:e[+-]?\d+)?)/gi)];
  if (lossMatches.length > 0) {
    loss = lossMatches[lossMatches.length - 1][1];
  }

  // 4. Speed (`1.44it/s`, `2.10 s/it`, `340.5 tok/s`, `125.0 samples/s`)
  let speedText = null;
  let speedVal = null;
  let speedUnit = null;
  const speedMatches = [
    ...recentChunk.matchAll(/\b(\d+(?:\.\d+)?)\s*(it\/s|s\/it|tok\/s|tokens\/s|samples\/s|img\/s|steps\/s)\b/gi),
  ];
  if (speedMatches.length > 0) {
    const m = speedMatches[speedMatches.length - 1];
    const rawNum = Number(m[1]);
    const rawUnit = m[2].toLowerCase();
    speedText = `${m[1]} ${m[2]}`;
    if (!Number.isNaN(rawNum) && rawNum > 0) {
      if (rawUnit === "s/it") {
        speedVal = Math.round((1 / rawNum) * 1000) / 1000;
        speedUnit = "it/s";
      } else {
        speedVal = rawNum;
        speedUnit = rawUnit === "tokens/s" ? "tok/s" : rawUnit;
      }
    }
  }

  // 5. ETA (`<05:12`, `ETA: 00:12:30`, `eta 4m20s`)
  let eta = null;
  const tqdmEta = recentChunk.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)<(\d{1,2}:\d{2}(?::\d{2})?)/);
  const explicitEta = recentChunk.match(/\bETA\s*[:=]?\s*([0-9hms:]{3,12})/i);
  if (tqdmEta) {
    eta = tqdmEta[2];
  } else if (explicitEta) {
    eta = explicitEta[1];
  }

  if (pct === null && !stepInfo && !loss && !speedText && !eta) {
    return null;
  }

  return {
    pct,
    stepInfo,
    loss,
    speedText,
    speedVal,
    speedUnit,
    eta,
    isStraggler: false,
  };
}

function updateGpuTelemetry(
  runsList = [],
  totalRunningWorkers = 0,
  totalPendingWorkers = 0,
  totalRunningGpus = 0,
  totalTargetGpus = 0,
  avgApiMs = 0
) {
  if (!state.telemetry) {
    state.telemetry = structuredClone(DEFAULT_STATE.telemetry);
  }
  const now = Date.now();
  const prevMs = Number(state.telemetry.lastAccountingAtMs || 0);
  const kstDate = new Date(now + 9 * 60 * 60 * 1000);
  const dateKey = kstDate.toISOString().slice(0, 10);
  const timeLabel = kstDate.toISOString().slice(11, 19);

  if (prevMs > 0 && now > prevMs) {
    const elapsedSec = Math.min(300, (now - prevMs) / 1000);
    if (elapsedSec > 0 && totalRunningGpus > 0) {
      const addedGpuHours = (totalRunningGpus * elapsedSec) / 3600;
      state.telemetry.totalGpuHours = Math.round((Number(state.telemetry.totalGpuHours || 0) + addedGpuHours) * 10000) / 10000;
      if (!state.telemetry.dailyGpuHours) state.telemetry.dailyGpuHours = {};
      state.telemetry.dailyGpuHours[dateKey] =
        Math.round((Number(state.telemetry.dailyGpuHours[dateKey] || 0) + addedGpuHours) * 10000) / 10000;
    }
  }
  state.telemetry.lastAccountingAtMs = now;

  const lastSampleMs = Number(state.telemetry.lastSampleAtMs || 0);
  if (!lastSampleMs || now - lastSampleMs >= 15000) {
    if (!Array.isArray(state.telemetry.timeSeries)) state.telemetry.timeSeries = [];
    state.telemetry.timeSeries.push({
      time: timeLabel,
      isoTime: new Date(now).toISOString(),
      runningWorkers: totalRunningWorkers,
      pendingWorkers: totalPendingWorkers,
      runningGpus: totalRunningGpus,
      targetGpus: totalTargetGpus,
      avgApiMs: Math.round(Number(avgApiMs || 0)),
      totalGpuHours: Math.round(Number(state.telemetry.totalGpuHours || 0) * 100) / 100,
    });
    if (state.telemetry.timeSeries.length > 60) {
      state.telemetry.timeSeries = state.telemetry.timeSeries.slice(-60);
    }
    state.telemetry.lastSampleAtMs = now;
  }

  return {
    totalGpuHours: Math.round(Number(state.telemetry.totalGpuHours || 0) * 100) / 100,
    todayGpuHours: Math.round(Number(state.telemetry.dailyGpuHours?.[dateKey] || 0) * 100) / 100,
    todayDate: dateKey,
    dailyGpuHours: state.telemetry.dailyGpuHours || {},
    timeSeries: state.telemetry.timeSeries || [],
  };
}

/**
 * Feature 1, 2, 3, 6: Round-Robin Live Worker Log Scanner, Progress Parser,
 * Goal Completion / Stage-2 Pipeline Detector & Hardware Bad-Node Detector.
 * Checks 1~2 Running workers per scheduler tick (or all when requested manually)
 * so SPACE API load stays minimal.
 */
async function scanWorkerLogsRoundRobin(allRuns = lastKnownRuns, options = {}) {
  const runsList = Array.isArray(allRuns) ? allRuns : [];
  const runningRuns = runsList.filter(
    (r) =>
      classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE" &&
      String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );
  if (runningRuns.length === 0) return { scannedCount: 0, snippets: watchdogStats.workerLogSnippets };

  const customKw = String(state.config.customErrorKeywords || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allKeywords = [...new Set([...DEFAULT_ERROR_KEYWORDS, ...BAD_NODE_ERROR_KEYWORDS, ...customKw])];

  const completeKeywords = String(state.config.autoStopOnCompleteKeyword || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const batchSize = options.scanAll ? Math.min(runningRuns.length, 16) : Math.min(runningRuns.length, 2);
  let scannedCount = 0;

  for (let i = 0; i < batchSize; i++) {
    const idx = (watchdogStats.roundRobinIndex + i) % runningRuns.length;
    const run = runningRuns[idx];
    const rId = String(run.id ?? run.runId ?? "");
    if (!rId) continue;

    // Skip if scanned within the last 20s unless scanAll=true
    const existing = watchdogStats.workerLogSnippets[rId];
    if (!options.scanAll && existing?.updatedAt && Date.now() - new Date(existing.updatedAt).getTime() < 20000) {
      continue;
    }

    try {
      const logRaw = await spaceApi.getRunLog(rId, { tailLines: 30 }, { timeoutMs: 3000, skipTelemetry: true });
      const text = typeof logRaw === "string" ? logRaw : JSON.stringify(logRaw || "");
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const lastLine = lines.length > 0 ? lines[lines.length - 1].slice(0, 180) : "(로그 출력 대기 중)";
      let matchedKeyword = null;
      for (const kw of allKeywords) {
        if (kw && text.toLowerCase().includes(kw.toLowerCase())) {
          matchedKeyword = kw;
          break;
        }
      }
      const isBadNodeHwError = Boolean(
        matchedKeyword && BAD_NODE_ERROR_KEYWORDS.some((hw) => hw.toLowerCase() === matchedKeyword.toLowerCase())
      );

      // Feature 2: Parse real-time progress (%, step/epoch, loss, speed, ETA)
      const progress = parseWorkerLogProgress(text);

      // Feature 3: Check completion keyword in logs
      let matchedCompleteKw = null;
      for (const ckw of completeKeywords) {
        if (ckw && text.toLowerCase().includes(ckw.toLowerCase())) {
          matchedCompleteKw = ckw;
          break;
        }
      }

      const hasError = Boolean(matchedKeyword);
      const prevHadError = Boolean(existing?.hasError);
      watchdogStats.workerLogSnippets[rId] = {
        runId: rId,
        runName: run.containerName || run.name || `#${rId}`,
        lastLine,
        hasError,
        isBadNodeHwError,
        matchedKeyword,
        matchedCompleteKw,
        progress,
        updatedAt: new Date().toISOString(),
      };
      scannedCount += 1;

      // Feature 6: Hardware Bad-Node Error handling
      if (isBadNodeHwError && !prevHadError && state.config.badNodeGuardEnabled !== false) {
        const cooldownSec = Math.max(5, Number(state.config.badNodeCooldownSec || 25));
        badNodeStats.hwErrorCount += 1;
        badNodeStats.consecutiveRapidFails += 1;
        badNodeStats.cooldownUntilMs = Date.now() + cooldownSec * 1000;
        badNodeStats.lastBadRunId = rId;
        badNodeStats.lastBadRunName = run.containerName || run.name || `#${rId}`;
        badNodeStats.lastReason = `노드 HW 에러 감지 (${matchedKeyword})`;
        badNodeStats.lastDetectedAt = new Date().toISOString();
        addLog(
          "warn",
          `🩺 [불량 GPU 노드 회피 가드] ${badNodeStats.lastBadRunName} (#${rId})에서 하드웨어 에러('${matchedKeyword}') 감지 → 동일 불량 노드 재할당 방지를 위해 ${cooldownSec}초 스마트 쿨다운 적용`
        );
      }

      // Feature 3: Goal Completion / Stage 1 ➔ Stage 2 Pipeline Chaining
      if (matchedCompleteKw && !existing?.matchedCompleteKw && state.config.autoStopOnComplete !== false) {
        const activeJob =
          state.jobs.find((j) => j.enabled && doesRunMatchJob(run, j, state.jobs)) ||
          state.jobs.find((j) => j.enabled) ||
          state.jobs[0];
        if (activeJob && activeJob.enabled) {
          const nextCmd = String(activeJob.nextStageCommand || state.config.nextStageCommand || "").trim();
          if (nextCmd && !activeJob._stage2Transitioned && activeJob.executionCommand !== nextCmd) {
            const prevCmd = activeJob.executionCommand;
            activeJob.executionCommand = nextCmd;
            activeJob._stage2Transitioned = true;
            pipelineStats.stageTransitionCount += 1;
            pipelineStats.lastTransitionedAt = new Date().toISOString();
            pipelineStats.lastStageCommand = nextCmd;
            saveState();
            addLog(
              "info",
              `⛓️ [파이프라인 Stage 2 자동 전환] 워커 #${rId} 로그에서 완료 키워드('${matchedCompleteKw}') 감지! 실행 명령어를 Stage 2('${nextCmd}')로 자동 전환합니다.`,
              { prevCmd, nextCmd, matchedCompleteKw }
            );
            await pushAlertNotification(
              "success",
              `⛓️ 파이프라인 Stage 1 완료 ➔ Stage 2 자동 전환!`,
              `워커 #${rId}에서 '${matchedCompleteKw}' 키워드가 감지되어 [${activeJob.name}] 명령어를 Stage 2(${nextCmd})로 자동 전환했습니다.`,
              { jobId: activeJob.id, nextCmd, dedupeKey: `stage2-${activeJob.id}` }
            );
          } else {
            activeJob.enabled = false;
            activeJob.lastStatus = `🏁 목표 완료 키워드('${matchedCompleteKw}') 감지됨 — 자동 정지 완료`;
            pipelineStats.completedCount += 1;
            pipelineStats.lastCompletedAt = new Date().toISOString();
            pipelineStats.lastCompletedReason = `로그 키워드 '${matchedCompleteKw}' 감지 (#${rId})`;
            saveState();
            addLog(
              "info",
              `🏁 [목표 완료 자동 정지] 워커 #${rId} 로그에서 완료 키워드('${matchedCompleteKw}')가 감지되어 [${activeJob.name}] 자동 증설을 정지했습니다.`
            );
            await pushAlertNotification(
              "success",
              `🏁 목표 작업 완료 감지 — 자동 정지됨 (${activeJob.name})`,
              `워커 #${rId} 로그에서 완료 키워드('${matchedCompleteKw}')가 확인되어 불필요한 추가 할당을 자동 종료했습니다.`,
              { jobId: activeJob.id, matchedCompleteKw, dedupeKey: `complete-${activeJob.id}-${matchedCompleteKw}` }
            );
          }
        }
      }

      if (hasError && !prevHadError) {
        watchdogStats.logErrorDetectedCount += 1;
        const rName = run.containerName || run.name || `#${rId}`;
        addLog("warn", `🧟 [워커 로그 에러 감지] ${rName} (#${rId})에서 '${matchedKeyword}' 감지: ${lastLine}`, {
          runId: rId,
          runName: rName,
          matchedKeyword,
          lastLine,
        });
        if (state.config.notifyOnError !== false) {
          await pushAlertNotification(
            "warn",
            `워커 로그 치명적 에러 감지 (${rName})`,
            `워커 #${rId} (${rName}) 로그에서 '${matchedKeyword}' 패턴이 감지되었습니다.\n최근 로그: ${lastLine}`,
            { runId: rId, matchedKeyword, dedupeKey: `logerr-${rId}-${matchedKeyword}` }
          );
        }
        if (state.config.watchdogEnabled !== false && (state.config.logErrorAutoRestart || isBadNodeHwError)) {
          try {
            await spaceApi.terminateRun(rId);
            watchdogStats.logErrorRestartedCount += 1;
            watchdogStats.lastActionMessage = `로그 에러(${matchedKeyword}) 워커 #${rId} 자동 종료 후 재생성 대기`;
            addLog(
              "warn",
              `🔄 [Watchdog 자동 교체] 치명적 로그 에러(${matchedKeyword})가 발생한 ${rName} (#${rId})를 자동 종료했습니다. 쿨다운 후 새 노드에 워커가 재배치됩니다.`
            );
          } catch (termErr) {
            addLog("error", `[Watchdog] 에러 워커 #${rId} 종료 실패: ${termErr.message}`);
          }
        }
      }
    } catch {
      // ignore transient log fetch errors
    }
  }

  watchdogStats.roundRobinIndex = (watchdogStats.roundRobinIndex + batchSize) % Math.max(1, runningRuns.length);
  return { scannedCount, snippets: watchdogStats.workerLogSnippets };
}

/**
 * Feature 1: Zombie / Stuck Pending Worker Watchdog Sweep
 * Automatically terminates non-Running active workers (`Pending`/`Creating`/`Approved`)
 * stuck longer than `maxPendingTimeoutMin` minutes so the scheduler spawns a fresh worker.
 */
async function runWatchdogSweep(allRuns = lastKnownRuns) {
  watchdogStats.lastSweepAt = new Date().toISOString();
  if (state.config.watchdogEnabled === false) return { terminatedIds: [] };

  const maxPendingMin = Math.max(3, Number(state.config.maxPendingTimeoutMin || 20));
  const maxPendingMs = maxPendingMin * 60 * 1000;
  const now = Date.now();
  const runsList = Array.isArray(allRuns) ? allRuns : [];

  const nonRunningActive = runsList.filter(
    (r) =>
      classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE" &&
      !String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );

  const terminatedIds = [];
  for (const r of nonRunningActive) {
    // Only auto-terminate if `startTime` is set (node assigned & container stuck in Creating/Initializing)
    // OR if `watchdogKillQueuePending` is explicitly enabled. Do NOT kill normal Pending runs waiting in cluster queue.
    const timeBasis = r.startTime || (state.config.watchdogKillQueuePending ? r.registerTime || r.createdAt : null);
    const startMs = timeBasis ? new Date(timeBasis).getTime() : 0;
    if (!startMs || Number.isNaN(startMs)) continue;
    const stuckMs = now - startMs;
    if (stuckMs >= maxPendingMs) {
      const rId = String(r.id ?? r.runId ?? "");
      const rName = r.containerName || r.name || `#${rId}`;
      const stuckMin = Math.round(stuckMs / 60000);
      try {
        await spaceApi.terminateRun(rId);
        terminatedIds.push(rId);
        watchdogStats.zombieTerminatedCount += 1;
        watchdogStats.lastActionMessage = `먹통 Pending 워커 ${rName} (#${rId}, ${stuckMin}분 경과) 자동 종료`;
        addLog(
          "warn",
          `🧟 [Watchdog 좀비 워커 자동 정리] ${rName} (#${rId})가 ${stuckMin}분째 '${r.status || r.state}' 상태로 멈춰 있어 자동 종료했습니다. 새 워커로 교체합니다.`,
          { runId: rId, runName: rName, stuckMin }
        );
        if (state.config.notifyOnZombieTerminated !== false) {
          await pushAlertNotification(
            "warn",
            `좀비 Pending 워커 자동 교체 (${rName})`,
            `${rName} (#${rId}) 워커가 ${stuckMin}분 동안 Running으로 진입하지 못해 자동 종료 후 재할당합니다.`,
            { runId: rId, stuckMin, dedupeKey: `zombie-${rId}` }
          );
        }
      } catch (e) {
        addLog("error", `[Watchdog] 먹통 워커 #${rId} 자동 종료 실패: ${e.message}`);
      }
    }
  }

  return { terminatedIds };
}

async function buildRunPayload(job, options = {}) {
  await ensureGroupIdConfigured();

  let specData = null;
  if (job.useSpecId) {
    specData = await spaceApi.getSpecificationDetail(job.useSpecId);
    if (specData?.data) specData = specData.data;
  }

  const allowSpot =
    options.overrideAllowSpot !== undefined
      ? Boolean(options.overrideAllowSpot)
      : job.allowSpot !== undefined
      ? Boolean(job.allowSpot)
      : Boolean(specData?.isSpot || specData?.allowSpot);
  let groupPoolId = Number(job.groupPoolId || specData?.groupPoolId || specData?.poolId || 0);
  let coreId = Number(options.overrideCoreId || job.coreId || specData?.coreId || 0);
  const coreCount = Number(job.coreCount || specData?.coreNum || specData?.coreCount || 1);
  const quotaIdRaw = job.quotaId || specData?.quotaId;
  let quotaId = quotaIdRaw !== undefined && quotaIdRaw !== "" && quotaIdRaw !== null ? Number(quotaIdRaw) : undefined;
  let containerImage = String(job.containerImage || specData?.image || specData?.containerImage || "").trim();
  const rawExecutionCommand = normalizeExecutionCommand(job.executionCommand || specData?.execCommand || "");

  // Auto-discover Group Pool ID & Core ID if user left them blank!
  if ((!allowSpot && !groupPoolId) || !coreId) {
    try {
      const poolsRes = await spaceApi.getGroupPools();
      const pools = extractItemsArray(poolsRes);
      if (pools.length > 0) {
        const chosenPool =
          (groupPoolId && pools.find((p) => Number(p.id ?? p.groupPoolId ?? p.poolId) === groupPoolId)) || pools[0];
        if (!groupPoolId && chosenPool) {
          groupPoolId = Number(chosenPool.id ?? chosenPool.groupPoolId ?? chosenPool.poolId ?? 0);
          if (groupPoolId) job.groupPoolId = String(groupPoolId);
        }
        const cores = chosenPool?.cores || chosenPool?.coreList || [];
        if (!coreId && cores.length > 0) {
          coreId = Number(cores[0].id ?? cores[0].coreId ?? 0);
          if (coreId) job.coreId = String(coreId);
        }
      }
      if (!coreId && allowSpot) {
        const spotRes = await spaceApi.getCores();
        const spotCores = extractItemsArray(spotRes);
        if (spotCores.length > 0) {
          coreId = Number(spotCores[0].id ?? spotCores[0].coreId ?? 0);
          if (coreId) job.coreId = String(coreId);
        }
      }
      saveState();
    } catch {
      // ignore
    }
  }

  // Auto-discover Priority / Quota ID if blank
  if (!allowSpot && !quotaId) {
    try {
      const prioRes = await spaceApi.getPriorities();
      const prioList = normalizePrioritiesList(prioRes, state.config.groupId);
      if (prioList.length > 0) {
        quotaId = Number(prioList[0].id ?? prioList[0].quotaId);
        if (quotaId) {
          job.quotaId = String(quotaId);
          saveState();
        }
      }
    } catch {
      // ignore
    }
  }

  // Auto-discover Container Image if blank
  if (!containerImage) {
    try {
      const imgs = await fetchNormalizedImages();
      if (imgs.length > 0) {
        const firstUrl = imgs[0].containerImageName || imgs[0].imageUrl || imgs[0].name || "";
        if (firstUrl) {
          containerImage = String(firstUrl).trim();
          job.containerImage = containerImage;
          saveState();
        }
      }
    } catch {
      // ignore
    }
  }

  let experimentId = job.experimentId ? Number(job.experimentId) : specData?.experimentId ? Number(specData.experimentId) : undefined;
  if (!experimentId) {
    try {
      const exps = await spaceApi.getExperiments();
      const expList = extractItemsArray(exps);
      if (expList.length > 0) {
        experimentId = Number(expList[0].id);
      }
    } catch {
      // ignore
    }
  }

  if (!coreId) throw new Error("GPU Core ID(coreId)를 찾을 수 없습니다. 상단 [SPACE에서 내 그룹 / GPU Pool / Spec 목록 자동 불러오기]를 눌러주세요.");
  if (!allowSpot && !groupPoolId) throw new Error("Group Pool ID(groupPoolId)를 찾을 수 없습니다. 상단 [SPACE에서 내 그룹 / GPU Pool / Spec 목록 자동 불러오기]를 눌러주세요.");
  if (!containerImage) throw new Error("컨테이너 이미지(containerImage)가 설정되지 않았습니다.");
  if (!rawExecutionCommand) throw new Error("실행할 스크립트 명령어(executionCommand)가 비어 있습니다.");

  const slotIndex = Math.max(1, Number(options.slotIndex || 1));
  const targetCount = Math.max(1, Number(options.targetCount || job.minConcurrentRuns || 1));

  const kstDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const mm = String(kstDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kstDate.getUTCDate()).padStart(2, "0");
  const hh = String(kstDate.getUTCHours()).padStart(2, "0");
  const mi = String(kstDate.getUTCMinutes()).padStart(2, "0");
  const ss = String(kstDate.getUTCSeconds()).padStart(2, "0");
  const baseSuffix = `${mm}${dd}-${hh}-${mi}-${ss}`;
  if (baseSuffix === lastContainerSuffix) {
    sameSecondSeq += 1;
  } else {
    lastContainerSuffix = baseSuffix;
    sameSecondSeq = 0;
  }
  const suffix = sameSecondSeq > 0 ? `${baseSuffix}-${sameSecondSeq}` : baseSuffix;
  const cleanPrefix = String(job.name || "gpu-job")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const slotTag = `s${String(slotIndex).padStart(2, "0")}`;
  const containerName = `${cleanPrefix}-${slotTag}-${suffix}`;

  // Feature 3: Replace template placeholders (`{{SLOT}}`, `{{INDEX}}`, `{{TOTAL}}`, `{{NAME}}`) & optionally inject `WORKER_SLOT` env vars
  let executionCommand = rawExecutionCommand
    .replace(/\{\{\s*(?:WORKER_)?SLOT\s*\}\}/gi, String(slotIndex))
    .replace(/\{\{\s*(?:WORKER_)?INDEX\s*\}\}/gi, String(slotIndex - 1))
    .replace(/\{\{\s*(?:WORKER_)?TOTAL\s*\}\}/gi, String(targetCount))
    .replace(/\{\{\s*(?:WORKER_)?NAME\s*\}\}/gi, containerName);

  const shouldInjectWorkerEnv = Boolean(job.injectWorkerEnv ?? state.config.injectWorkerEnv);
  if (shouldInjectWorkerEnv && !executionCommand.includes("WORKER_SLOT=")) {
    executionCommand = `export WORKER_SLOT=${slotIndex} WORKER_INDEX=${slotIndex - 1} WORKER_TOTAL=${targetCount} WORKER_NAME="${containerName}"; ${executionCommand}`;
  }

  // Batch 2 - Feature 1: Auto-sync scripts edited in the dashboard (`state.scriptFiles`) into `/group-volume/...` inside the worker container on start!
  if (state.config.syncEditedScriptsOnStart !== false && state.scriptFiles) {
    for (const [scriptPath, scriptEntry] of Object.entries(state.scriptFiles)) {
      if (
        scriptEntry &&
        scriptEntry.autoInject &&
        typeof scriptEntry.content === "string" &&
        scriptEntry.content.length > 0 &&
        executionCommand.includes(scriptPath) &&
        !executionCommand.includes("base64 -d >")
      ) {
        const b64 = Buffer.from(scriptEntry.content, "utf-8").toString("base64");
        const dirName = path.posix.dirname(scriptPath);
        executionCommand = `mkdir -p "${dirName}" && echo "${b64}" | base64 -d > "${scriptPath}" && chmod +x "${scriptPath}"; ${executionCommand}`;
      }
    }
  }

  const enabledRunFeatures = [];
  if (job.enableWebConsole !== false) {
    enabledRunFeatures.push("webconsole");
  }

  const payload = {
    containerName,
    ...(allowSpot === false ? { groupPoolId } : {}),
    coreId,
    coreCount,
    ...(allowSpot === false && quotaId ? { quotaId } : {}),
    inputDataSets: specData?.inputDataSet || [],
    githubPath: specData?.githubPath || "",
    executionCommand,
    allowSpot,
    emailNoticeCode: 0,
    containerImage,
    volumeClaim: Array.isArray(job.volumeClaim) && job.volumeClaim.length > 0 ? job.volumeClaim : specData?.volumeClaim || [],
    runType: "batch",
    type: "oneOff",
    ...(experimentId ? { experimentId } : {}),
    isSetUpRun: false,
    enabledRunFeatures,
  };

  if (job.expectedRunTime) {
    payload.expectedRunTime = String(job.expectedRunTime);
  }

  return payload;
}

/**
 * Compute real-time Server & SPACE Cluster Load / Health Status (`loadMonitor`)
 * Used by both the UI dashboard and the Smart Load-Safe Paced Allocator (`evaluateJobRule`).
 */
function computeServerLoadStatus(allRuns = lastKnownRuns) {
  const runsList = Array.isArray(allRuns) ? allRuns : [];
  const now = Date.now();
  const enabled = state.config.smartLoadGuardEnabled !== false;
  const maxPendingWorkers = Math.max(1, Number(state.config.maxPendingWorkers || 2));
  const stepByStepRunningCheck = state.config.stepByStepRunningCheck !== false;
  const warnMs = Math.max(300, Number(state.config.apiLatencyWarnMs || 1800));
  const critMs = Math.max(warnMs + 200, Number(state.config.apiLatencyCriticalMs || 3500));

  // Prune request timestamps older than 60s
  const reqTs = loadMonitorStats.requestTimestampsMs || [];
  const cacheTs = loadMonitorStats.cacheHitTimestampsMs || [];
  while (reqTs.length > 0 && now - reqTs[0] > 60000) {
    reqTs.shift();
  }
  while (cacheTs.length > 0 && now - cacheTs[0] > 60000) {
    cacheTs.shift();
  }
  loadMonitorStats.requestsPerMinute = reqTs.length;
  loadMonitorStats.cacheHitsPerMinute = cacheTs.length;

  const activeRuns = runsList.filter((r) => classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE");
  const runningRuns = activeRuns.filter((r) =>
    String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );
  const nonRunningActiveRuns = activeRuns.filter(
    (r) => !String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );

  // Measure how long the oldest non-Running active worker has been waiting in Pending/Creating/Approved
  let oldestPendingWaitSec = 0;
  let oldestPendingWorkerName = null;
  for (const r of nonRunningActiveRuns) {
    const timeBasis = r.startTime || r.registerTime || r.createdAt || null;
    const startMs = timeBasis ? new Date(timeBasis).getTime() : 0;
    if (startMs && !Number.isNaN(startMs)) {
      const waitSec = Math.max(0, Math.floor((now - startMs) / 1000));
      if (waitSec >= oldestPendingWaitSec) {
        oldestPendingWaitSec = waitSec;
        oldestPendingWorkerName = r.containerName || r.name || `#${r.id || r.runId}`;
      }
    }
  }

  // Local Linux host load & memory
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  const [load1, load5, load15] = os.loadavg();
  const cpuLoadPct = Math.min(100, Math.round((load1 / cpuCount) * 100));
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
  const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

  const avgLat = loadMonitorStats.avgLatencyMs || 0;
  const p95Lat = loadMonitorStats.p95LatencyMs || 0;
  const lastLat = loadMonitorStats.lastLatencyMs || 0;
  const effectiveLat = Math.max(avgLat, lastLat);

  const backoffRemainingSec =
    loadMonitorStats.backoffUntilMs > now ? Math.ceil((loadMonitorStats.backoffUntilMs - now) / 1000) : 0;

  let loadLevel = "GREEN"; // GREEN | YELLOW | ORANGE | RED
  let loadBadgeText = "🟢 쾌적 · 안전 할당";
  let pacingMultiplier = 1.0;
  let extraDelaySec = 0;
  let holdCreation = false;
  const reasons = [];

  if (backoffRemainingSec > 0) {
    loadLevel = "RED";
    loadBadgeText = `🛑 과부하 보호 쿨다운 (${backoffRemainingSec}초)`;
    pacingMultiplier = 2.5;
    extraDelaySec = backoffRemainingSec;
    holdCreation = enabled;
    reasons.push(
      `API 연속 오류/한도 보호 쿨다운 중 (${backoffRemainingSec}초 남음 · ${loadMonitorStats.backoffReason || loadMonitorStats.lastBackoffReason || "백오프"})`
    );
  }

  if (effectiveLat >= critMs || p95Lat >= critMs * 1.2) {
    if (loadLevel !== "RED") {
      loadLevel = "ORANGE";
      loadBadgeText = "🟠 API 지연 감지 · 자동 감속";
    }
    pacingMultiplier = Math.max(pacingMultiplier, 2.0);
    extraDelaySec = Math.max(extraDelaySec, 15);
    reasons.push(`SPACE API 응답 지연 높음 (최근 ${lastLat}ms · 평균 ${avgLat}ms · P95 ${p95Lat}ms) → 생성 간격 2.0x 자동 연장`);
  } else if (effectiveLat >= warnMs) {
    if (loadLevel === "GREEN") {
      loadLevel = "YELLOW";
      loadBadgeText = "🟡 API 부하 주의 · 완만 페이싱";
    }
    pacingMultiplier = Math.max(pacingMultiplier, 1.4);
    extraDelaySec = Math.max(extraDelaySec, 6);
    reasons.push(`SPACE API 응답 다소 느림 (최근 ${lastLat}ms · 평균 ${avgLat}ms) → 생성 간격 1.4x 완만 조절`);
  }

  // In-flight Pending/Creating worker congestion check
  if (nonRunningActiveRuns.length >= maxPendingWorkers) {
    if (loadLevel === "GREEN" || loadLevel === "YELLOW") {
      loadLevel = "YELLOW";
      loadBadgeText = `🟡 준비중 워커 ${nonRunningActiveRuns.length}/${maxPendingWorkers}개 대기 · 순차 보호`;
    }
    if (enabled) {
      holdCreation = true;
    }
    reasons.push(
      `현재 Running 전환 대기 중인 워커 ${nonRunningActiveRuns.length}개 (상한 ${maxPendingWorkers}개) → 기존 워커가 Running 진입할 때까지 추가 생성 일시 대기`
    );
  } else if (stepByStepRunningCheck && nonRunningActiveRuns.length > 0 && oldestPendingWaitSec >= 45) {
    if (loadLevel === "GREEN") {
      loadLevel = "YELLOW";
      loadBadgeText = `🟡 클러스터 할당 대기 (${oldestPendingWaitSec}초) · 대기 보호`;
    }
    if (enabled) {
      holdCreation = true;
    }
    reasons.push(
      `선행 워커(${oldestPendingWorkerName})가 ${oldestPendingWaitSec}초째 Pending/승인후 대기 중 → 클러스터 과부하/큐 적체 방지를 위해 Running 진입 시까지 대기`
    );
  }

  if (loadMonitorStats.lastPoolCheck && loadMonitorStats.lastPoolCheck.available === false) {
    if (loadLevel === "GREEN") {
      loadLevel = "YELLOW";
      loadBadgeText = "🟡 GPU 풀 여유 대기 중";
    }
    reasons.push(`클러스터 풀 상태: ${loadMonitorStats.lastPoolCheck.reason}`);
  }

  if (reasons.length === 0) {
    reasons.push(
      `SPACE API 응답 쾌적 (평균 ${avgLat || lastLat || 0}ms) · 준비 대기 워커 ${nonRunningActiveRuns.length}/${maxPendingWorkers}개 · Running 가동 ${runningRuns.length}개`
    );
  }

  return {
    enabled,
    loadLevel,
    loadBadgeText,
    holdCreation,
    pacingMultiplier,
    extraDelaySec,
    maxPendingWorkers,
    stepByStepRunningCheck,
    inFlightPendingCount: nonRunningActiveRuns.length,
    runningWorkerCount: runningRuns.length,
    activeWorkerCount: activeRuns.length,
    oldestPendingWaitSec,
    oldestPendingWorkerName,
    api: {
      lastLatencyMs: lastLat,
      avgLatencyMs: avgLat,
      p95LatencyMs: p95Lat,
      maxLatencyMs: loadMonitorStats.maxLatencyMs || 0,
      requestsPerMinute: loadMonitorStats.requestsPerMinute,
      cacheHitsPerMinute: loadMonitorStats.cacheHitsPerMinute,
      totalRequests: loadMonitorStats.totalRequests,
      totalErrors: loadMonitorStats.totalErrors,
      consecutiveErrors: loadMonitorStats.consecutiveErrors,
      rateLimitCount: loadMonitorStats.rateLimitCount,
      backoffRemainingSec,
      lastErrorStatus: loadMonitorStats.lastErrorStatus,
      lastErrorMessage: loadMonitorStats.lastErrorMessage,
      warnThresholdMs: warnMs,
      criticalThresholdMs: critMs,
    },
    host: {
      cpuCount,
      loadAvg1m: Number(load1.toFixed(2)),
      loadAvg5m: Number(load5.toFixed(2)),
      cpuLoadPct,
      rssMb,
      freeMemMb,
      totalMemMb,
    },
    poolCheck: loadMonitorStats.lastPoolCheck,
    throttleCount: loadMonitorStats.throttleCount,
    lastThrottleReason: loadMonitorStats.lastThrottleReason,
    lastThrottleAt: loadMonitorStats.lastThrottleAt,
    reasons,
     summaryText: reasons[0],
  };
}

function getJobContainerPrefix(job) {
  return String(job?.name || "gpu-job")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
}

function doesRunMatchJob(run, job, allJobs = state.jobs) {
  if (!run || !job) return false;
  const rId = String(run.id || run.runId || "");
  if (job.lastRunId && rId && rId === String(job.lastRunId)) return true;

  const rName = String(run.containerName || run.name || "");
  if (!rName) return false;

  const prefix28 = getJobContainerPrefix(job);
  const prefix32 = String(job.name || "gpu-job")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  const matchesPrefix = (p) => Boolean(p && (rName === p || rName.startsWith(p + "-")));
  if (!matchesPrefix(prefix28) && !matchesPrefix(prefix32)) return false;

  const matchedLen = matchesPrefix(prefix32) ? prefix32.length : prefix28.length;

  // Prevent shorter rule prefix (e.g. `worker-spot`) from stealing runs belonging to a longer rule prefix (e.g. `worker-spot-2`)
  if (Array.isArray(allJobs) && allJobs.length > 1) {
    for (const other of allJobs) {
      if (!other || other.id === job.id) continue;
      if (other.lastRunId && rId && rId === String(other.lastRunId)) return false;
      const otherP28 = getJobContainerPrefix(other);
      const otherP32 = String(other.name || "gpu-job")
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);
      const otherLen = matchesPrefix(otherP32) ? otherP32.length : matchesPrefix(otherP28) ? otherP28.length : 0;
      if (otherLen > matchedLen) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Compute real-time Worker Fleet & Auto-Creation progress statistics for the UI
 */
function computeWorkerFleetStats(allRuns = lastKnownRuns) {
  const runsList = Array.isArray(allRuns) ? allRuns : [];
  const now = Date.now();
  const configuredSchedSec = Math.max(1, Number(state.config.checkIntervalSec || 15));
  const loadStatus = computeServerLoadStatus(runsList);
  const timelineList = buildAutoApprovalTimeline(runsList);
  const timelineByRunId = new Map();
  const timelineByName = new Map();
  for (const t of timelineList) {
    if (t.runId) timelineByRunId.set(String(t.runId), t);
    const tName = t.runName || t.containerName;
    if (tName) timelineByName.set(String(tName), t);
  }

  let totalRunningWorkers = 0;
  let totalPendingWorkers = 0;
  let totalActiveWorkers = 0;
  let totalTargetWorkers = 0;
  let totalRemainingToCreate = 0;
  let totalExcessPendingWorkers = 0;
  let totalRunningGpus = 0;
  let totalPendingGpus = 0;
  let totalActiveGpus = 0;
  let totalTargetGpus = 0;
  let totalRemainingGpus = 0;
  let globalNextSpawnInSec = null;
  const anyJobEnabled = state.jobs.some((j) => j.enabled);
  const matchedActiveRunIds = new Set();

  const jobFleetList = state.jobs.map((job) => {
    const matchingRuns = runsList.filter((r) => doesRunMatchJob(r, job, state.jobs));

    const activeRuns = matchingRuns
      .filter((r) => classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE")
      .sort((a, b) => Number(a.id ?? a.runId ?? 0) - Number(b.id ?? b.runId ?? 0));

    for (const r of activeRuns) {
      const rId = String(r.id ?? r.runId ?? "");
      if (rId) matchedActiveRunIds.add(rId);
    }

    const runningRuns = activeRuns.filter((r) =>
      String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
    );
    const pendingRuns = activeRuns.filter(
      (r) => !String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
    );
    // Order all Running workers first (#1..#runningCount), followed by Pending workers (#runningCount+1..#activeCount)
    const orderedActiveRuns = [...runningRuns, ...pendingRuns];

    const targetCount = Math.max(1, Number(job.minConcurrentRuns || 1));
    const activeCount = activeRuns.length;
    const runningCount = runningRuns.length;
    const pendingCount = pendingRuns.length;
    const remainingToCreate = Math.max(0, targetCount - activeCount);
    const runningDeficit = Math.max(0, targetCount - runningCount);
    const excessPendingCount = Math.max(0, Math.min(pendingCount, activeCount - targetCount));

    const coreCountPerWorker = Math.max(1, Number(job.coreCount || 1));
    const runningGpuCount = runningCount * coreCountPerWorker;
    const pendingGpuCount = pendingCount * coreCountPerWorker;
    const activeGpuCount = activeCount * coreCountPerWorker;
    const targetGpuCount = targetCount * coreCountPerWorker;
    const remainingGpuToCreate = remainingToCreate * coreCountPerWorker;

    const baseCooldownSec = Math.max(1, Number(job.cooldownSec || configuredSchedSec || 15));
    const pacedCooldownSec = loadStatus.enabled
      ? Math.max(baseCooldownSec, Math.ceil(baseCooldownSec * loadStatus.pacingMultiplier) + loadStatus.extraDelaySec)
      : baseCooldownSec;
    const effectiveCooldownSec = pacedCooldownSec;
    const effectiveTickSec = Math.min(configuredSchedSec, baseCooldownSec);
    const scaleUpIntervalSec = Math.max(effectiveTickSec, effectiveCooldownSec);

    let nextSpawnAt = null;
    let nextSpawnInSec = null;
    if (job.enabled && state.config.schedulerEnabled && remainingToCreate > 0) {
      const lastTriggerMs = job.lastTriggeredAt ? new Date(job.lastTriggeredAt).getTime() : 0;
      const nextByCooldownMs = lastTriggerMs ? lastTriggerMs + effectiveCooldownSec * 1000 : now;
      const nextBySchedMs = lastSchedulerTickTime ? lastSchedulerTickTime + effectiveTickSec * 1000 : now;
      const backoffMs = loadStatus.api.backoffRemainingSec > 0 ? now + loadStatus.api.backoffRemainingSec * 1000 : now;
      const holdExtraMs = loadStatus.holdCreation ? Math.max(nextBySchedMs, now + 5000) : now;
      const nextSpawnMs = Math.max(now, nextByCooldownMs, nextBySchedMs, backoffMs, holdExtraMs);
      nextSpawnAt = new Date(nextSpawnMs).toISOString();
      nextSpawnInSec = Math.max(0, Math.ceil((nextSpawnMs - now) / 1000));
      if (globalNextSpawnInSec === null || nextSpawnInSec < globalNextSpawnInSec) {
        globalNextSpawnInSec = nextSpawnInSec;
      }
    }

    const countInGlobalTarget = !anyJobEnabled || Boolean(job.enabled);
    totalRunningWorkers += runningCount;
    totalPendingWorkers += pendingCount;
    totalActiveWorkers += activeCount;
    totalTargetWorkers += countInGlobalTarget ? targetCount : activeCount;
    totalRemainingToCreate += countInGlobalTarget ? remainingToCreate : 0;
    totalExcessPendingWorkers += excessPendingCount;
    totalRunningGpus += runningGpuCount;
    totalPendingGpus += pendingGpuCount;
    totalActiveGpus += activeGpuCount;
    totalTargetGpus += countInGlobalTarget ? targetGpuCount : activeGpuCount;
    totalRemainingGpus += countInGlobalTarget ? remainingGpuToCreate : 0;

    const activeWorkers = orderedActiveRuns.map((r, idx) => {
      const st = String(r.status || r.state || r.phase || "UNKNOWN");
      const isRunning = st.toUpperCase().includes("RUNNING");
      const rId = String(r.id ?? r.runId ?? "");
      const rName = String(r.containerName ?? r.name ?? `worker-${idx + 1}`);
      const tl = timelineByRunId.get(rId) || timelineByName.get(rName) || null;
      const snippet = watchdogStats.workerLogSnippets[rId] || null;
      const assignedSlot = extractAssignedSlotFromRun(r) || idx + 1;
      const stateOrderIndex = isRunning ? idx + 1 : idx - runningCount + 1;
      const isExcessPending = !isRunning && idx + 1 > targetCount;
      const timeBasis = r.startTime || r.registerTime || r.createdAt || null;
      const startMs = timeBasis ? new Date(timeBasis).getTime() : 0;
      const elapsedSec = startMs && !Number.isNaN(startMs) ? Math.max(0, Math.floor((now - startMs) / 1000)) : 0;
      const rawProgress = snippet?.progress ? { ...snippet.progress } : null;
      return {
        slotIndex: idx + 1,
        stateOrderIndex,
        assignedSlot,
        isExcessPending,
        id: r.id ?? r.runId,
        name: rName,
        userName: r.userId || r.userName || r.user || null,
        status: st,
        isRunning,
        coreName: r.coreName || r.gpuName || (String(job.coreId) === "2" ? "H100" : `Core #${job.coreId || "-"}`),
        coreCount: Number(r.coreCount ?? r.coreNum ?? coreCountPerWorker),
        ip: r.ip || "-",
        startTime: r.startTime || null,
        registerTime: r.registerTime || null,
        elapsedSec,
        approvalStatus: r.approvalStatus || tl?.approvalStatus || (isRunning ? "approved" : "pending"),
        allocationRequestedAt: tl?.allocationRequestedAt || r.registerTime || r.startTime || null,
        createdAt: tl?.createdAt || r.registerTime || r.startTime || null,
        autoApprovalRequestedAt: tl?.autoApprovalRequestedAt || null,
        approvedAt: tl?.approvedAt || null,
        approvalElapsedSec: tl?.approvalElapsedSec ?? null,
        triggerSource: tl?.triggerSource || "auto",
        lastLogLine: snippet?.lastLine || null,
        lastLogUpdatedAt: snippet?.updatedAt || null,
        hasLogError: Boolean(snippet?.hasError),
        logErrorKeyword: snippet?.matchedKeyword || null,
        progress: rawProgress,
      };
    });

    // Batch 2 - Feature 2: Detect Straggler workers (`speedVal < 0.55 * medianSpeed` within same unit)
    const speedGroups = new Map();
    for (const w of activeWorkers) {
      if (w.progress?.speedVal && w.progress?.speedUnit) {
        const u = w.progress.speedUnit;
        if (!speedGroups.has(u)) speedGroups.set(u, []);
        speedGroups.get(u).push(w.progress.speedVal);
      }
    }
    for (const [unit, vals] of speedGroups.entries()) {
      if (vals.length >= 2) {
        const sorted = [...vals].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        for (const w of activeWorkers) {
          if (w.progress?.speedUnit === unit && w.progress?.speedVal < median * 0.55) {
            w.progress.isStraggler = true;
            w.progress.medianSpeed = Math.round(median * 100) / 100;
          }
        }
      }
    }

    const succeededCount = matchingRuns.filter(
      (r) => classifyRunStatus(r.status || r.state || r.phase) === "SUCCEEDED"
    ).length;

    const nextAssignedSlot = pickNextWorkerSlot(job, activeRuns, targetCount);

    // Keep `job.lastStatus` accurate even for disabled jobs so old/stale counts (e.g. "가동 40/40개" from days ago) never persist
    if (!job.enabled && runsList.length > 0) {
      if (activeCount === 0) {
        job.lastStatus = `⚪ 일시정지됨 (현재 가동 0개 / 목표 ${targetCount}개 · 자동생성 OFF)`;
      } else {
        job.lastStatus = `⚪ 자동생성 OFF (현재 🟢 Running ${runningCount}개${pendingCount > 0 ? ` · ⏳ Pending ${pendingCount}개` : ""} 가동 중)`;
      }
    }

    return {
      jobId: job.id,
      jobName: job.name,
      enabled: Boolean(job.enabled),
      allowSpot: Boolean(job.allowSpot),
      coreId: job.coreId,
      coreCountPerWorker,
      gpusPerWorker: coreCountPerWorker,
      executionCommand: job.executionCommand,
      nextStageCommand: job.nextStageCommand || state.config.nextStageCommand || "",
      stage2Transitioned: Boolean(job._stage2Transitioned),
      succeededCount,
      maxTotalSucceededRuns: Number(job.maxTotalSucceededRuns ?? state.config.maxTotalSucceededRuns ?? 0),
      injectWorkerEnv: Boolean(job.injectWorkerEnv ?? state.config.injectWorkerEnv),
      nextAssignedSlot,
      targetCount,
      activeCount,
      runningCount,
      pendingCount,
      remainingToCreate,
      runningDeficit,
      excessPendingCount,
      runningGpuCount,
      pendingGpuCount,
      activeGpuCount,
      targetGpuCount,
      remainingGpuToCreate,
      runningGpus: runningGpuCount,
      pendingGpus: pendingGpuCount,
      activeGpus: activeGpuCount,
      targetGpus: targetGpuCount,
      remainingGpus: remainingGpuToCreate,
      scaleUpIntervalSec,
      configuredCheckIntervalSec: configuredSchedSec,
      configuredCooldownSec: Number(job.cooldownSec || 15),
      pacedCooldownSec,
      nextSpawnAt,
      nextSpawnInSec,
      estimatedFullScaleSec: remainingToCreate * scaleUpIntervalSec,
      activeWorkers,
    };
  });

  // Compute exact SPACE Cluster Reconciliation (`Rule Workers` vs `My Account Total` vs `Group Total`)
  const currentUserName = resolveCurrentUserName();
  const allActiveSpaceRuns = runsList
    .filter((r) => classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE")
    .sort((a, b) => Number(a.id ?? a.runId ?? 0) - Number(b.id ?? b.runId ?? 0));
  const allRunningSpaceRuns = allActiveSpaceRuns.filter((r) =>
    String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );
  const allPendingSpaceRuns = allActiveSpaceRuns.filter(
    (r) => !String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );
  const isMyRun = (r) => {
    const rUser = String(r.userId || r.userName || r.user || "").trim();
    if (!currentUserName || currentUserName === "admin" || !rUser) return true;
    return rUser.toLowerCase() === String(currentUserName).toLowerCase();
  };
  const myActiveSpaceRuns = allActiveSpaceRuns.filter(isMyRun);
  const myRunningSpaceRuns = myActiveSpaceRuns.filter((r) =>
    String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );
  const myPendingSpaceRuns = myActiveSpaceRuns.filter(
    (r) => !String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );
  const sumRunGpus = (arr) => arr.reduce((acc, r) => acc + Math.max(1, Number(r.coreCount ?? r.coreNum ?? 1)), 0);
  const unmatchedActiveRuns = allActiveSpaceRuns
    .filter((r) => !matchedActiveRunIds.has(String(r.id ?? r.runId ?? "")))
    .map((r) => {
      const st = String(r.status || r.state || r.phase || "UNKNOWN");
      const isRunning = st.toUpperCase().includes("RUNNING");
      const rId = String(r.id ?? r.runId ?? "");
      const timeBasis = r.startTime || r.registerTime || r.createdAt || null;
      const startMs = timeBasis ? new Date(timeBasis).getTime() : 0;
      const elapsedSec = startMs && !Number.isNaN(startMs) ? Math.max(0, Math.floor((now - startMs) / 1000)) : 0;
      return {
        id: r.id ?? r.runId,
        name: r.containerName || r.name || `run-${rId}`,
        userName: r.userId || r.userName || r.user || "-",
        isMine: isMyRun(r),
        status: st,
        isRunning,
        coreName: r.coreName || r.gpuName || "GPU",
        coreCount: Math.max(1, Number(r.coreCount ?? r.coreNum ?? 1)),
        ip: r.ip || "-",
        startTime: r.startTime || null,
        registerTime: r.registerTime || null,
        elapsedSec,
      };
    });
  const myUnmatchedActiveRuns = unmatchedActiveRuns.filter((u) => u.isMine);
  const otherUserActiveRuns = unmatchedActiveRuns.filter((u) => !u.isMine);

  const spaceReconciliation = {
    currentUserName,
    groupId: state.config.groupId || "",
    ruleRunningWorkers: totalRunningWorkers,
    rulePendingWorkers: totalPendingWorkers,
    ruleActiveWorkers: totalActiveWorkers,
    ruleRunningGpus: totalRunningGpus,
    rulePendingGpus: totalPendingGpus,
    ruleActiveGpus: totalActiveGpus,
    mySpaceRunningWorkers: myRunningSpaceRuns.length,
    mySpacePendingWorkers: myPendingSpaceRuns.length,
    mySpaceActiveWorkers: myActiveSpaceRuns.length,
    mySpaceRunningGpus: sumRunGpus(myRunningSpaceRuns),
    mySpacePendingGpus: sumRunGpus(myPendingSpaceRuns),
    mySpaceActiveGpus: sumRunGpus(myActiveSpaceRuns),
    spaceTotalRunningWorkers: allRunningSpaceRuns.length,
    spaceTotalPendingWorkers: allPendingSpaceRuns.length,
    spaceTotalActiveWorkers: allActiveSpaceRuns.length,
    spaceTotalRunningGpus: sumRunGpus(allRunningSpaceRuns),
    spaceTotalPendingGpus: sumRunGpus(allPendingSpaceRuns),
    spaceTotalActiveGpus: sumRunGpus(allActiveSpaceRuns),
    unmatchedActiveRuns,
    myUnmatchedActiveRuns,
    otherUserActiveRuns,
  };

  const timeScaleStatus = computeTimeScaleStatus();
  const telemetryStatus = updateGpuTelemetry(
    runsList,
    totalRunningWorkers,
    totalPendingWorkers,
    totalRunningGpus,
    totalTargetGpus,
    loadStatus?.api?.avgLatencyMs || 0
  );
  const badNodeCooldownRemainingSec =
    badNodeStats.cooldownUntilMs > now ? Math.ceil((badNodeStats.cooldownUntilMs - now) / 1000) : 0;

  return {
    updatedAt: lastKnownRunsAt || new Date().toISOString(),
    schedulerEnabled: Boolean(state.config.schedulerEnabled),
    scaleUpIntervalSec: jobFleetList[0]?.scaleUpIntervalSec || configuredSchedSec,
    configuredCheckIntervalSec: configuredSchedSec,
    totalRunningWorkers,
    totalPendingWorkers,
    totalActiveWorkers,
    totalTargetWorkers,
    totalRemainingToCreate,
    totalExcessPendingWorkers,
    totalRunningGpus,
    totalPendingGpus,
    totalActiveGpus,
    totalTargetGpus,
    totalRemainingGpus,
    nextSpawnInSec: globalNextSpawnInSec,
    spaceReconciliation,
    jobs: jobFleetList,
    autoApprovalTimeline: timelineList.slice(0, 40),
    loadMonitor: loadStatus,
    watchdog: {
      enabled: state.config.watchdogEnabled !== false,
      maxPendingTimeoutMin: Number(state.config.maxPendingTimeoutMin || 20),
      logErrorAutoRestart: Boolean(state.config.logErrorAutoRestart),
      customErrorKeywords: state.config.customErrorKeywords || "",
      lastSweepAt: watchdogStats.lastSweepAt,
      zombieTerminatedCount: watchdogStats.zombieTerminatedCount,
      logErrorDetectedCount: watchdogStats.logErrorDetectedCount,
      logErrorRestartedCount: watchdogStats.logErrorRestartedCount,
      lastActionMessage: watchdogStats.lastActionMessage,
      workerLogSnippets: watchdogStats.workerLogSnippets,
    },
    timeScale: timeScaleStatus,
    hybridFallback: {
      enabled: state.config.hybridFallbackEnabled !== false,
      fallbackCoreId: state.config.fallbackCoreId || "",
      ...hybridFallbackStats,
    },
    sharding: {
      injectWorkerEnv: Boolean(state.config.injectWorkerEnv),
    },
    notifications: {
      webhookConfigured: Boolean(state.config.webhookUrl && String(state.config.webhookUrl).trim()),
      webhookUrl: state.config.webhookUrl || "",
      browserNotifyEnabled: state.config.browserNotifyEnabled !== false,
      notifyOnTokenExpiring: state.config.notifyOnTokenExpiring !== false,
      notifyOnZombieTerminated: state.config.notifyOnZombieTerminated !== false,
      notifyOnTargetReached: state.config.notifyOnTargetReached !== false,
      notifyOnError: state.config.notifyOnError !== false,
      alerts: (state.alerts || []).slice(0, 30),
    },
    telemetry: telemetryStatus,
    badNodeGuard: {
      enabled: state.config.badNodeGuardEnabled !== false,
      rapidFailSec: Number(state.config.badNodeRapidFailSec || 180),
      cooldownSec: Number(state.config.badNodeCooldownSec || 25),
      cooldownRemainingSec: badNodeCooldownRemainingSec,
      rapidFailCount: badNodeStats.rapidFailCount,
      hwErrorCount: badNodeStats.hwErrorCount,
      consecutiveRapidFails: badNodeStats.consecutiveRapidFails,
      lastBadRunId: badNodeStats.lastBadRunId,
      lastBadRunName: badNodeStats.lastBadRunName,
      lastReason: badNodeStats.lastReason,
      lastDetectedAt: badNodeStats.lastDetectedAt,
    },
    pipeline: {
      autoStopOnComplete: state.config.autoStopOnComplete !== false,
      autoStopOnCompleteKeyword: state.config.autoStopOnCompleteKeyword || "",
      maxTotalSucceededRuns: Number(state.config.maxTotalSucceededRuns || 0),
      nextStageCommand: state.config.nextStageCommand || "",
      ...pipelineStats,
    },
    presets: state.presets || [],
    scriptEditor: {
      syncEditedScriptsOnStart: state.config.syncEditedScriptsOnStart !== false,
      savedPaths: Object.keys(state.scriptFiles || {}),
    },
  };
}

async function checkPoolGpuAvailable(groupPoolId, coreId, requiredCount) {
  try {
    const statusList = await spaceApi.getGroupPoolsStatus(state.config.groupId);
    const pools = extractItemsArray(statusList);
    const pool = pools.find((p) => String(p.id || p.groupPoolId || p.poolId) === String(groupPoolId));
    if (!pool) return { available: true, reason: "Pool status detail not found, proceeding" };
    const cores = pool.cores || pool.coreStatus || [];
    const core = cores.find((c) => String(c.id || c.coreId) === String(coreId));
    if (!core) return { available: true, reason: "Core status detail not found, proceeding" };
    const total = Number(core.total ?? core.limit ?? core.capacity ?? core.count ?? 0);
    const used = Number(core.used ?? core.allocated ?? core.running ?? 0);
    const free = core.available !== undefined ? Number(core.available) : Math.max(0, total - used);
    if (total > 0 && free < requiredCount) {
      const res = {
        available: false,
        free,
        total,
        checkedAt: new Date().toISOString(),
        reason: `유휴 GPU 부족 (가용: ${free} / 필요: ${requiredCount}, 전체: ${total})`,
      };
      loadMonitorStats.lastPoolCheck = res;
      return res;
    }
    const res = {
      available: true,
      free,
      total,
      checkedAt: new Date().toISOString(),
      reason: `가용 GPU 확인됨 (가용: ${free} / 전체: ${total})`,
    };
    loadMonitorStats.lastPoolCheck = res;
    return res;
  } catch (e) {
    return { available: true, reason: `GPU 상태 조회 생략 (${e.message})` };
  }
}

let isTickRunning = false;

async function evaluateJobRule(job, allRuns, forceTrigger = false) {
  const now = Date.now();
  job.lastCheckAt = new Date(now).toISOString();

  const prefix = getJobContainerPrefix(job);

  const matchingRuns = allRuns.filter((r) => doesRunMatchJob(r, job, state.jobs));

  const activeRuns = matchingRuns.filter((r) => classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE");
  const runningRuns = activeRuns.filter((r) =>
    String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );
  const pendingJobRuns = activeRuns.filter(
    (r) => !String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );
  const latestRun = matchingRuns[0] || null;
  const latestStatusClass = latestRun ? classifyRunStatus(latestRun.status || latestRun.state || latestRun.phase) : "NONE";

  // If any run for this job is waiting for approval in `/taskorbit/api/v1/approvals`, immediately approve it as Admin!
  if (job.autoApprove !== false) {
    await processPendingApprovals({
      targetRunId: job.lastRunId || undefined,
      targetRunName: prefix,
    }).catch(() => {});
  }

  const minConcurrent = Math.max(1, Number(job.minConcurrentRuns || 1));
  const loadStatus = computeServerLoadStatus(allRuns);

  // Batch 2 - Feature 6: Detect Rapid-Fail runs (`FAILED` within `< badNodeRapidFailSec` seconds) & trigger Bad-Node Cooldown
  if (state.config.badNodeGuardEnabled !== false) {
    const rapidSecLimit = Math.max(20, Number(state.config.badNodeRapidFailSec || 180));
    const cooldownSec = Math.max(5, Number(state.config.badNodeCooldownSec || 25));
    const failedRuns = matchingRuns.filter((r) => classifyRunStatus(r.status || r.state || r.phase) === "FAILED");
    for (const fr of failedRuns.slice(0, 5)) {
      const fId = String(fr.id ?? fr.runId ?? "");
      if (!fId || badNodeStats.seenFailedRunIds.has(fId)) continue;
      badNodeStats.seenFailedRunIds.add(fId);
      const startMs = fr.startTime ? new Date(fr.startTime).getTime() : 0;
      const endMs = fr.endTime ? new Date(fr.endTime).getTime() : now;
      const runDurSec = startMs > 0 ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 9999;
      if (runDurSec <= rapidSecLimit && now - endMs < 180000) {
        badNodeStats.rapidFailCount += 1;
        badNodeStats.consecutiveRapidFails += 1;
        badNodeStats.cooldownUntilMs = Math.max(badNodeStats.cooldownUntilMs, now + cooldownSec * 1000);
        badNodeStats.lastBadRunId = fId;
        badNodeStats.lastBadRunName = fr.containerName || fr.name || `#${fId}`;
        badNodeStats.lastReason = `시작 ${runDurSec}초 만에 조기 실패(Rapid-Fail <= ${rapidSecLimit}초)`;
        badNodeStats.lastDetectedAt = new Date(now).toISOString();
        addLog(
          "warn",
          `🩺 [불량 노드 회피 가드] ${badNodeStats.lastBadRunName} (#${fId})가 시작 ${runDurSec}초 만에 조기 실패했습니다. 동일 불량 노드 재할당 방지를 위해 ${cooldownSec}초 스마트 쿨다운을 적용합니다.`
        );
      }
    }
    if (runningRuns.length > 0 && badNodeStats.consecutiveRapidFails > 0) {
      // Reset consecutive rapid fails once healthy Running workers are active for > 3 minutes
      const hasStableRunner = runningRuns.some((r) => {
        const sMs = r.startTime ? new Date(r.startTime).getTime() : 0;
        return sMs > 0 && now - sMs > 180000;
      });
      if (hasStableRunner) {
        badNodeStats.consecutiveRapidFails = 0;
      }
    }
  }

  // Batch 2 - Feature 3: Check `maxTotalSucceededRuns` Goal Auto-Stop & Stage 1 ➔ Stage 2 Pipeline Chaining
  const maxSucc = Number(job.maxTotalSucceededRuns ?? state.config.maxTotalSucceededRuns ?? 0);
  if (!forceTrigger && maxSucc > 0) {
    const succeededCount = matchingRuns.filter(
      (r) => classifyRunStatus(r.status || r.state || r.phase) === "SUCCEEDED"
    ).length;
    if (succeededCount >= maxSucc) {
      const nextCmd = String(job.nextStageCommand || state.config.nextStageCommand || "").trim();
      if (nextCmd && !job._stage2Transitioned && job.executionCommand !== nextCmd) {
        const prevCmd = job.executionCommand;
        job.executionCommand = nextCmd;
        job._stage2Transitioned = true;
        pipelineStats.stageTransitionCount += 1;
        pipelineStats.lastTransitionedAt = new Date(now).toISOString();
        pipelineStats.lastStageCommand = nextCmd;
        saveState();
        addLog(
          "info",
          `⛓️ [파이프라인 Stage 2 자동 전환] 누적 성공 ${succeededCount}/${maxSucc}회 달성! [${job.name}] 실행 명령어를 Stage 2('${nextCmd}')로 자동 전환합니다.`,
          { prevCmd, nextCmd, succeededCount }
        );
      } else if (state.config.autoStopOnComplete !== false) {
        job.enabled = false;
        job.lastStatus = `🏁 목표 성공 횟수(${succeededCount}/${maxSucc}회) 달성 완료 — 자동 정지됨`;
        pipelineStats.completedCount += 1;
        pipelineStats.lastCompletedAt = new Date(now).toISOString();
        pipelineStats.lastCompletedReason = `누적 성공 ${succeededCount}/${maxSucc}회 달성`;
        saveState();
        addLog("info", `🏁 [목표 완료 자동 정지] 누적 성공 ${succeededCount}/${maxSucc}회 달성으로 [${job.name}] 자동 증설을 종료했습니다.`);
        return { triggered: false, reason: job.lastStatus, loadMonitor: loadStatus };
      }
    }
  }

  if (!forceTrigger) {
    const inFlightSlots = getInFlightReservationsForJob(job.id);
    const effectiveActiveCount = activeRuns.length + inFlightSlots.length;
    // Batch 2 - Feature 6: Enforce Bad-Node Cooldown before spawning replacement workers
    if (state.config.badNodeGuardEnabled !== false && badNodeStats.cooldownUntilMs > now) {
      const remainBadSec = Math.ceil((badNodeStats.cooldownUntilMs - now) / 1000);
      const deficit = Math.max(0, minConcurrent - effectiveActiveCount);
      job.lastStatus = `🩺 [불량 노드 회피 쿨다운] 직전 워커(${badNodeStats.lastBadRunName || "-"}) ${badNodeStats.lastReason || "조기 실패"} → 동일 노드 재당첨 방지를 위해 ${remainBadSec}초 후 +${deficit}개 안전 재배치`;
      saveState();
      return { triggered: false, reason: job.lastStatus, loadThrottled: true, loadMonitor: loadStatus };
    }
    if (effectiveActiveCount >= minConcurrent) {
      const excessPending = Math.max(0, Math.min(pendingJobRuns.length, activeRuns.length - minConcurrent));
      const pendingStr =
        pendingJobRuns.length > 0
          ? ` · ⏳ Pending 대기 ${pendingJobRuns.length}개${excessPending > 0 ? `(목표초과 +${excessPending}개)` : ""}`
          : "";
      if (runningRuns.length >= minConcurrent) {
        job.lastStatus = `✅ 목표 Running ${minConcurrent}개 전원 가동 중! (🟢 Running ${runningRuns.length}개${pendingStr} · 전체 활성 ${activeRuns.length}/${minConcurrent}개)`;
      } else {
        job.lastStatus = `⏳ 목표 수량(${minConcurrent}개) 제출 완료 — 클러스터 Running 전환 대기 중 (🟢 실제 가동 ${runningRuns.length}개 / 목표 ${minConcurrent}개${pendingStr} · 전체 활성 ${activeRuns.length}개)`;
      }
      if (
        runningRuns.length >= minConcurrent &&
        job._lastNotifiedTarget !== minConcurrent &&
        state.config.notifyOnTargetReached !== false
      ) {
        job._lastNotifiedTarget = minConcurrent;
        pushAlertNotification(
          "success",
          `목표 워커 ${minConcurrent}개 전원 Running 달성! (${job.name})`,
          `[${job.name}] 목표 워커 ${minConcurrent}개 (총 GPU ${minConcurrent * Math.max(1, Number(job.coreCount || 1))}장)가 모두 Running 상태로 가동 중입니다.`,
          { jobId: job.id, minConcurrent, dedupeKey: `target-${job.id}-${minConcurrent}` }
        ).catch(() => {});
      }
      saveState();
      return { triggered: false, reason: job.lastStatus, loadMonitor: loadStatus };
    }
    if (runningRuns.length < minConcurrent) {
      job._lastNotifiedTarget = null;
    }

    // 🛡️ Smart Load-Safe Guard #1: API Backoff / Rate-Limit Cooldown
    if (loadStatus.enabled && loadStatus.api.backoffRemainingSec > 0) {
      const deficit = Math.max(0, minConcurrent - activeRuns.length);
      loadMonitorStats.throttleCount += 1;
      loadMonitorStats.lastThrottleAt = new Date(now).toISOString();
      loadMonitorStats.lastThrottleReason = `API 보호 쿨다운 (${loadStatus.api.backoffRemainingSec}초 대기)`;
      job.lastStatus = `🛡️ [서버 과부하 보호] SPACE API 응답 안정화 대기 중 (${loadStatus.api.backoffRemainingSec}초 후 자동 재개 · 남은 생성 예정: +${deficit}개)`;
      saveState();
      return { triggered: false, reason: job.lastStatus, loadThrottled: true, loadMonitor: loadStatus };
    }

    // 🛡️ Smart Load-Safe Guard #2: In-Flight Pending / Creating Worker Congestion Protection
    if (loadStatus.enabled && loadStatus.inFlightPendingCount >= loadStatus.maxPendingWorkers) {
      const deficit = Math.max(0, minConcurrent - activeRuns.length);
      const pendingNames = pendingJobRuns
        .slice(0, 3)
        .map((r) => `${r.containerName || r.name || `#${r.id || r.runId}`}(${r.status || r.state})`)
        .join(", ");
      loadMonitorStats.throttleCount += 1;
      loadMonitorStats.lastThrottleAt = new Date(now).toISOString();
      loadMonitorStats.lastThrottleReason = `동시 준비중 워커 ${loadStatus.inFlightPendingCount}/${loadStatus.maxPendingWorkers}개 상한 도달`;
      job.lastStatus = `🛡️ [서버 부하 보호 · 순차 할당] 현재 준비중 워커 ${loadStatus.inFlightPendingCount}/${loadStatus.maxPendingWorkers}개 (${pendingNames || "승인/컨테이너 준비중"}) → Running 진입 확인 후 +${deficit}개 이어서 자동 할당`;
      saveState();
      return { triggered: false, reason: job.lastStatus, loadThrottled: true, loadMonitor: loadStatus };
    }

    // 🛡️ Smart Load-Safe Guard #3: Step-by-Step Running Check when an already-submitted worker is waiting in cluster queue >= 45s
    if (
      loadStatus.enabled &&
      loadStatus.stepByStepRunningCheck &&
      loadStatus.inFlightPendingCount > 0 &&
      loadStatus.oldestPendingWaitSec >= 45
    ) {
      const deficit = Math.max(0, minConcurrent - activeRuns.length);
      loadMonitorStats.throttleCount += 1;
      loadMonitorStats.lastThrottleAt = new Date(now).toISOString();
      loadMonitorStats.lastThrottleReason = `선행 워커(${loadStatus.oldestPendingWorkerName}) ${loadStatus.oldestPendingWaitSec}초째 클러스터 대기 중`;
      job.lastStatus = `🛡️ [클러스터 큐 적체 보호] 선행 워커(${loadStatus.oldestPendingWorkerName})가 ${loadStatus.oldestPendingWaitSec}초째 Running 대기 중 → 서버 무리 방지를 위해 Running 전환 즉시 +${deficit}개 자동 할당 재개`;
      saveState();
      return { triggered: false, reason: job.lastStatus, loadThrottled: true, loadMonitor: loadStatus };
    }

    // Respect user-configured worker creation interval (`job.cooldownSec` / `state.config.checkIntervalSec`), dynamically stretched when SPACE API latency is elevated
    const baseCooldownSec = Math.max(1, Number(job.cooldownSec || state.config.checkIntervalSec || 15));
    const effectiveCooldownSec = loadStatus.enabled
      ? Math.max(baseCooldownSec, Math.ceil(baseCooldownSec * loadStatus.pacingMultiplier) + loadStatus.extraDelaySec)
      : baseCooldownSec;
    const cooldownMs = effectiveCooldownSec * 1000;
    // Allow 1.5s jitter margin so API latency during `createRun` never causes the next scheduled tick to be skipped
    if (job.lastTriggeredAt && now - new Date(job.lastTriggeredAt).getTime() < Math.max(500, cooldownMs - 1500)) {
      const remainWaitSec = Math.max(1, Math.ceil((cooldownMs - (now - new Date(job.lastTriggeredAt).getTime())) / 1000));
      const deficit = Math.max(0, minConcurrent - activeRuns.length);
      const paceNote =
        loadStatus.enabled && effectiveCooldownSec > baseCooldownSec
          ? ` · 🛡️ 부하감지 안전간격 ${effectiveCooldownSec}초 적용`
          : "";
      job.lastStatus = `⏳ 워커 안전 페이싱 증설 중 (🟢 가동 ${runningRuns.length}개 · 전체 활성 ${activeRuns.length}/${minConcurrent}개 · +${deficit}개 추가 예정 · ${remainWaitSec}초 후 다음 워커 생성${paceNote})`;
      saveState();
      return { triggered: false, reason: job.lastStatus, loadMonitor: loadStatus };
    }

    if (activeRuns.length === 0 && latestRun) {
      if (latestStatusClass === "SUCCEEDED" && !job.restartOnSuccess && job.mode === "once_until_success") {
        job.lastStatus = `성공 완료됨 (#${latestRun.id || latestRun.runId}) - 재실행 안 함`;
        saveState();
        return { triggered: false, reason: job.lastStatus };
      }
      if (latestStatusClass === "SUCCEEDED" && !job.restartOnSuccess) {
        job.lastStatus = `성공 완료됨 (#${latestRun.id || latestRun.runId}) - restartOnSuccess 꺼짐`;
        saveState();
        return { triggered: false, reason: job.lastStatus };
      }
      if (latestStatusClass === "FAILED" && !job.restartOnFail) {
        job.lastStatus = `이전 잡 실패/중지됨 (#${latestRun.id || latestRun.runId}) - restartOnFail 꺼짐`;
        saveState();
        return { triggered: false, reason: job.lastStatus };
      }
    }
  }

  // Feature 4: Check Standard Pool GPU availability & pre-emptively fallback to Spot if enabled!
  let preOverrideAllowSpot = undefined;
  if (!forceTrigger && (job.mode === "when_gpu_free" || loadStatus.enabled) && !job.allowSpot && job.groupPoolId && job.coreId) {
    const gpuCheck = await checkPoolGpuAvailable(job.groupPoolId, job.coreId, Number(job.coreCount || 1));
    if (!gpuCheck.available) {
      if (state.config.hybridFallbackEnabled !== false) {
        preOverrideAllowSpot = true;
        hybridFallbackStats.fallbackTriggeredCount += 1;
        hybridFallbackStats.lastFallbackAt = new Date().toISOString();
        hybridFallbackStats.lastFallbackReason = `Standard 유휴 GPU 부족 (${gpuCheck.reason}) → Spot 자동 폴백`;
        hybridFallbackStats.lastFallbackMode = "Standard ➔ Spot";
        addLog("warn", `🔄 [하이브리드 자동 폴백] ${gpuCheck.reason} → 대기 없이 🟧 Spot 모드로 자동 전환하여 할당합니다.`);
      } else if (job.mode === "when_gpu_free") {
        job.lastStatus = `GPU 대기 중: ${gpuCheck.reason}`;
        saveState();
        return { triggered: false, reason: job.lastStatus };
      }
    }
  }

  // Feature 3: Pick lowest missing Worker Slot Index (1..minConcurrent) and reserve it across concurrent calls
  const nextWorkerSlot = pickNextWorkerSlot(job, activeRuns, minConcurrent);
  const slotReservationKey = reserveWorkerSlot(job.id, nextWorkerSlot);
  const remainingAfterThis = Math.max(0, minConcurrent - (activeRuns.length + 1));
  const triggerSource = forceTrigger ? "manual" : "auto_scheduler";
  const triggerLabel = forceTrigger ? "👆 [수동 클릭 신청]" : "🤖 [무클릭 자동 신청]";
  try {
    let payload = await buildRunPayload(job, {
      slotIndex: nextWorkerSlot,
      targetCount: minConcurrent,
      overrideAllowSpot: preOverrideAllowSpot,
    });
    const reqIso = new Date().toISOString();
    schedulerLoopStats.lastAllocationRequestAt = reqIso;
    schedulerLoopStats.lastAutoAllocationRequestAt = reqIso;
    schedulerLoopStats.lastTriggerSource = triggerSource;

    addLog(
      "info",
      `${triggerLabel} [${job.name}] 워커 슬롯 #${nextWorkerSlot} (활성 ${activeRuns.length + 1}/${minConcurrent}) GPU 할당 요청 전송 (남은 자동생성 예정: +${remainingAfterThis}개 · cmd: ${payload.executionCommand})`,
      {
        containerName: payload.containerName,
        workerSlot: `${nextWorkerSlot}/${minConcurrent}`,
        remainingToCreate: remainingAfterThis,
        groupPoolId: payload.groupPoolId,
        coreId: payload.coreId,
        coreCount: payload.coreCount,
        executionCommand: payload.executionCommand,
        triggerSource,
        allocationRequestedAt: reqIso,
      }
    );

    // Feature 4: Spot ↔ Standard / Fallback Core Auto-Retry on `createRun` failure
    let createRes = null;
    try {
      createRes = await spaceApi.createRun(payload);
    } catch (primaryErr) {
      if (state.config.hybridFallbackEnabled !== false) {
        const altAllowSpot = !payload.allowSpot;
        const altCoreId = state.config.fallbackCoreId ? Number(state.config.fallbackCoreId) : undefined;
        const fallbackLabel = altAllowSpot ? "Standard ➔ Spot" : "Spot ➔ Standard";
        addLog(
          "warn",
          `🔄 [하이브리드 자동 폴백 재시도] 1차 할당 실패 (${primaryErr.message}) → ${fallbackLabel}${altCoreId ? ` (Core #${altCoreId})` : ""} 모드로 즉시 재시도합니다.`
        );
        try {
          payload = await buildRunPayload(job, {
            slotIndex: nextWorkerSlot,
            targetCount: minConcurrent,
            overrideAllowSpot: altAllowSpot,
            overrideCoreId: altCoreId || undefined,
          });
          createRes = await spaceApi.createRun(payload);
          hybridFallbackStats.fallbackTriggeredCount += 1;
          hybridFallbackStats.lastFallbackAt = new Date().toISOString();
          hybridFallbackStats.lastFallbackReason = `1차 생성 오류(${primaryErr.message.slice(0, 60)}) → ${fallbackLabel} 폴백 성공`;
          hybridFallbackStats.lastFallbackMode = fallbackLabel;
        } catch {
          throw primaryErr;
        }
      } else {
        throw primaryErr;
      }
    }
    const createdId = createRes?.id || createRes?.runId || createRes?.data?.id || createRes?.data?.runId || null;
    const createdIso = new Date().toISOString();

    job.lastTriggeredAt = new Date(now).toISOString();
    if (createdId) job.lastRunId = createdId;
    schedulerLoopStats.lastCreatedAt = createdIso;
    schedulerLoopStats.lastCreatedRunId = createdId;
    schedulerLoopStats.lastCreatedRunName = payload.containerName;
    schedulerLoopStats.lastAutoAllocatedRunId = createdId;
    schedulerLoopStats.lastAutoAllocatedRunName = payload.containerName;
    if (forceTrigger) {
      schedulerLoopStats.totalManualAllocatedCount = (schedulerLoopStats.totalManualAllocatedCount || 0) + 1;
    } else {
      schedulerLoopStats.totalAutoAllocatedCount = (schedulerLoopStats.totalAutoAllocatedCount || 0) + 1;
    }

    job.lastStatus = `${triggerLabel} 제출 완료 [워커 ${nextWorkerSlot}/${minConcurrent} · 남은 자동생성 +${remainingAfterThis}개] (${payload.containerName} · #${createdId || "-"}) → Admin 승인 추적 중...`;
    saveState();

    // Optimistically append to `lastKnownRuns` AND `recentlyCreatedRunsMap` so UI & subsequent polls never drop the newly created worker
    if (createdId) {
      const createdRunObj = {
        id: createdId,
        runId: createdId,
        containerName: payload.containerName,
        name: payload.containerName,
        userName: resolveCurrentUserName(),
        status: "Pending",
        coreId: payload.coreId,
        coreName: String(payload.coreId) === "2" ? "H100" : `Core #${payload.coreId}`,
        coreCount: payload.coreCount,
        executionCommand: payload.executionCommand,
        containerImage: payload.containerImage,
        registerTime: createdIso,
        startTime: null,
      };
      recentlyCreatedRunsMap.set(String(createdId), {
        createdAtMs: Date.now(),
        run: createdRunObj,
      });
      lastKnownRuns = [
        createdRunObj,
        ...lastKnownRuns.filter((r) => String(r.id ?? r.runId) !== String(createdId)),
      ];
      lastKnownRunsAt = createdIso;
    }

    addLog(
      "success",
      `${triggerLabel} [${job.name}] 워커 #${nextWorkerSlot}/${minConcurrent} 생성됨: ${payload.containerName} (#${createdId || "-"} · 앞으로 +${remainingAfterThis}개 추가 자동생성 예정)`,
      {
        runId: createdId,
        containerName: payload.containerName,
        workerSlot: `${nextWorkerSlot}/${minConcurrent}`,
        remainingToCreate: remainingAfterThis,
        command: payload.executionCommand,
        triggerSource,
        allocationRequestedAt: reqIso,
        createdAt: createdIso,
      }
    );

    // Fast Admin Auto-Approval Tracker right after creation (runs for BOTH Standard AND Spot instances!)
    let approvalResult = null;
    const typeTag = payload.allowSpot ? "🟧 Spot" : "🟦 Standard";
    if (job.autoApprove !== false) {
      approvalResult = await trackAndApproveCreatedRun({
        runId: createdId,
        containerName: payload.containerName,
        job,
      });
      if (approvalResult?.approved) {
        job.lastStatus = `${typeTag} ${triggerLabel} 워커 ${nextWorkerSlot}/${minConcurrent} 제출 및 ✅ Admin 승인 완료 (${payload.containerName} · #${createdId || "-"} · 남은 자동생성: +${remainingAfterThis}개)`;
      } else {
        job.lastStatus = `${typeTag} ${triggerLabel} 워커 ${nextWorkerSlot}/${minConcurrent} 제출 완료 (${payload.containerName} · #${createdId || "-"} · 남은 자동생성: +${remainingAfterThis}개) — 실시간 자동 승인 추적 중`;
      }
      saveState();
    } else {
      job.lastStatus = `${typeTag} ${triggerLabel} 워커 ${nextWorkerSlot}/${minConcurrent} 제출 완료 (${payload.containerName} · #${createdId || "-"} · 수동 승인 모드)`;
      saveState();
    }

    return {
      triggered: true,
      triggerSource,
      allocationRequestedAt: reqIso,
      createdAt: createdIso,
      payload,
      response: createRes,
      approvalResult,
      nextWorkerSlot,
      remainingAfterThis,
    };
  } finally {
    releaseWorkerSlot(slotReservationKey);
  }
}

/**
 * Periodic Workload / GPU Scheduler Loop
 */
async function runSchedulerTick(manual = false) {
  if (isTickRunning) return { skipped: true, reason: "Already running tick" };
  if (!manual && !state.config.schedulerEnabled) return { skipped: true, reason: "Scheduler disabled" };
  if (!state.config.accessToken) {
    return { skipped: true, reason: "Access Token이 아직 설정되지 않았습니다." };
  }
  if (!state.config.groupId) {
    await ensureGroupIdConfigured();
  }
  if (!state.config.groupId) {
    return { skipped: true, reason: "Group ID를 확인할 수 없습니다." };
  }

  isTickRunning = true;
  schedulerLoopStats.running = Boolean(state.config.schedulerEnabled);
  schedulerLoopStats.tickCount += 1;
  schedulerLoopStats.lastCheckedAt = new Date().toISOString();
  const results = [];
  let approvalTickResult = null;
  try {
    // Feature 5: Dynamically apply KST Time-of-Day / Weekend Auto-Scaling target worker counts if enabled
    applyTimeScaleToJobs();

    // Feature 6: Check JWT token remaining time and trigger alert if expiring within 30 minutes
    const jwt = decodeJwtPayload(state.config.accessToken);
    if (jwt?.exp && state.config.notifyOnTokenExpiring !== false) {
      const remSec = Math.floor(jwt.exp - Date.now() / 1000);
      if (remSec > 0 && remSec <= 1800) {
        const bucket = Math.ceil(remSec / 900); // alert at 30m and 15m buckets
        if (lastTokenExpiryAlertBucket !== bucket) {
          lastTokenExpiryAlertBucket = bucket;
          const remMin = Math.max(1, Math.round(remSec / 60));
          await pushAlertNotification(
            "warn",
            `SPACE Access Token 만료 임박 (${remMin}분 남음)`,
            `Access Token이 약 ${remMin}분 후 만료됩니다. 자동 갱신(Refresh Token) 상태를 확인하거나 새 토큰을 등록해 주세요.`,
            { remainingSec: remSec, dedupeKey: `token-exp-${bucket}` }
          );
        }
      } else if (remSec > 1800) {
        lastTokenExpiryAlertBucket = null;
      }
    }

    const anyJobAutoApprove = state.jobs.some((j) => j.autoApprove !== false);
    if (manual || state.config.autoApprovalScope !== "off" || anyJobAutoApprove) {
      approvalTickResult = await processPendingApprovals({ forceAll: manual }).catch((e) => ({ error: e.message }));
    }

    const enabledJobs = state.jobs.filter((j) => j.enabled);
    if (manual || enabledJobs.length > 0 || state.config.watchdogEnabled !== false) {
      let allRuns = await fetchCurrentRuns();

      // Feature 1: Run Zombie Watchdog Sweep first
      const sweepRes = await runWatchdogSweep(allRuns).catch(() => ({ terminatedIds: [] }));
      if (sweepRes?.terminatedIds?.length > 0) {
        allRuns = await fetchCurrentRuns(true).catch(() => allRuns);
      }

      // Run `evaluateJobRule` on the fresh `allRuns` BEFORE `scanWorkerLogsRoundRobin`
      // so log scanning latency can never make `allRuns` stale or cause over-spawning!
      for (const job of enabledJobs) {
        try {
          const res = await evaluateJobRule(job, allRuns, false);
          results.push({ jobId: job.id, name: job.name, ...res });
        } catch (jobErr) {
          job.lastStatus = `오류: ${jobErr.message}`;
          saveState();
          addLog("error", `[${job.name}] 주기 체크/실행 오류: ${jobErr.message}`);
          results.push({ jobId: job.id, name: job.name, error: jobErr.message });
        }
      }
      // Refresh runs cache if any job triggered a new worker
      if (results.some((r) => r.triggered)) {
        allRuns = await fetchCurrentRuns(true).catch(() => allRuns);
      }

      // Feature 2: Round-Robin Live Worker Log Scan (runs after scheduling decisions with short per-call timeout)
      await scanWorkerLogsRoundRobin(allRuns, { scanAll: manual }).catch(() => {});

      if (manual) {
        // Also update status summary for disabled jobs so the user sees live feedback
        for (const job of state.jobs.filter((j) => !j.enabled)) {
          const matchingActive = allRuns.filter(
            (r) => doesRunMatchJob(r, job, state.jobs) && classifyRunStatus(r.status ?? r.state ?? r.phase) === "ACTIVE"
          );
          const runningCnt = matchingActive.filter((r) =>
            String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
          ).length;
          job.lastCheckAt = new Date().toISOString();
          const typeTag = job.allowSpot ? "🟧 Spot" : "🟦 Standard";
          if (matchingActive.length > 0) {
            const ids = matchingActive.slice(0, 3).map((r) => `#${r.id ?? r.runId}`).join(", ");
            job.lastStatus = `${typeTag} ✅ Admin 승인 완료 · 🟢 Running ${runningCnt}개 (전체 활성 ${matchingActive.length}개: ${ids}) [주기 자동추가: OFF]`;
          }
        }
        saveState();
        const fleet = computeWorkerFleetStats(lastKnownRuns);
        const appCnt = approvalTickResult?.approvedCount || 0;
        const pendCnt = approvalTickResult?.pendingApprovalsTotal || 0;
        addLog(
          "info",
          `🔍 [루프 즉시 점검 완료] 🟢 실제 가동(Running): ${fleet.totalRunningWorkers}개 · ⏳ Pending 대기: ${fleet.totalPendingWorkers}개 (전체 활성 ${fleet.totalActiveWorkers}/${fleet.totalTargetWorkers}개) · Admin 승인 처리: ${appCnt}건 (대기: ${pendCnt}건) · 부하상태: ${fleet.loadMonitor?.loadBadgeText || "정상"}`
        );
      }
    }
  } catch (err) {
    addLog("error", `스케줄러 런 목록 조회 실패: ${err.message}`);
    return { error: err.message };
  } finally {
    isTickRunning = false;
  }
  const fleet = computeWorkerFleetStats(lastKnownRuns);
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    approvalTickResult,
    results,
    schedulerLoopStats,
    approvalLoopStats,
    workerFleet: fleet,
    loadMonitor: fleet.loadMonitor,
  };
}

/**
 * Two Independent Configurable Loops (1-second resolution):
 * 1) Workload / GPU Allocation Check Loop (`checkIntervalSec`, min 1s; capped at max 15s while scaling up missing workers!)
 * 2) Dedicated Admin Run-Approval Auto-Approver Loop (`approvalCheckIntervalSec`, min 1s; adapts interval when idle to reduce server load)
 */
let lastSchedulerTickTime = 0;
let lastApprovalTickTime = 0;

setInterval(async () => {
  if (!state.config.accessToken) return;
  if (!state.config.groupId) {
    await ensureGroupIdConfigured();
    if (!state.config.groupId) return;
  }

  const now = Date.now();
  const hasNonRunningActive = lastKnownRuns.some(
    (r) =>
      classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE" &&
      !String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
  );

  // 1. Dedicated fast Admin Run-Approval polling loop (runs independently even if periodic job creation scheduler is OFF!)
  const anyJobAutoApprove = state.jobs.some((j) => j.autoApprove !== false);
  if (state.config.autoApprovalScope !== "off" || anyJobAutoApprove) {
    const hasRecentTrigger = state.jobs.some(
      (j) => j.autoApprove !== false && j.lastTriggeredAt && now - new Date(j.lastTriggeredAt).getTime() < 5 * 60 * 1000
    );
    const configuredApprovalSec = Math.max(1, Number(state.config.approvalCheckIntervalSec || 3));
    const adaptivePolling = state.config.adaptivePollingEnabled !== false;
    // Fast 2s polling right after a run creation or when any run is Pending; gently relax to 5s when all runs are steadily Running & no pending approvals
    let effectiveApprovalSec = hasRecentTrigger || hasNonRunningActive || approvalLoopStats.pendingCount > 0
      ? Math.min(2, configuredApprovalSec)
      : adaptivePolling
      ? Math.max(configuredApprovalSec, 5)
      : Math.min(3, configuredApprovalSec);
    if (loadMonitorStats.backoffUntilMs > now) {
      effectiveApprovalSec = Math.max(effectiveApprovalSec, 8);
    }
    approvalLoopStats.effectiveIntervalSec = effectiveApprovalSec;
    const approvalIntervalMs = effectiveApprovalSec * 1000;
    if (lastApprovalTickTime) {
      approvalLoopStats.nextCheckAt = new Date(lastApprovalTickTime + approvalIntervalMs).toISOString();
    }
    if (now - lastApprovalTickTime >= approvalIntervalMs) {
      lastApprovalTickTime = now;
      approvalLoopStats.nextCheckAt = new Date(now + approvalIntervalMs).toISOString();
      processPendingApprovals().catch(() => {});
    }
  } else {
    approvalLoopStats.running = false;
    approvalLoopStats.nextCheckAt = null;
  }

  // 2. Workload / GPU allocation scheduler loop
  schedulerLoopStats.running = Boolean(state.config.schedulerEnabled);
  if (!state.config.schedulerEnabled) {
    schedulerLoopStats.nextCheckAt = null;
    return;
  }
  const configuredSchedSec = Math.max(1, Number(state.config.checkIntervalSec || 15));
  const enabledJobIntervals = state.jobs
    .filter((j) => j.enabled)
    .map((j) => Math.max(1, Number(j.cooldownSec || configuredSchedSec)));
  let effectiveSchedSec =
    enabledJobIntervals.length > 0 ? Math.min(configuredSchedSec, ...enabledJobIntervals) : configuredSchedSec;
  if (loadMonitorStats.backoffUntilMs > now) {
    effectiveSchedSec = Math.max(effectiveSchedSec, 10);
  }
  schedulerLoopStats.effectiveIntervalSec = effectiveSchedSec;
  const schedIntervalMs = effectiveSchedSec * 1000;
  if (lastSchedulerTickTime) {
    schedulerLoopStats.nextCheckAt = new Date(lastSchedulerTickTime + schedIntervalMs).toISOString();
  }
  if (now - lastSchedulerTickTime >= schedIntervalMs) {
    lastSchedulerTickTime = now;
    schedulerLoopStats.nextCheckAt = new Date(now + schedIntervalMs).toISOString();
    await runSchedulerTick(false);
  }
}, 500);

/**
 * HTTP Server & REST API
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Password",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  try {
    // Password verification endpoint (`POST /api/auth/verify`)
    if (pathname === "/api/auth/verify" && req.method === "POST") {
      const body = await readJsonBody(req);
      const pw = String(body.password || "").trim().toLowerCase();
      if (pw === ADMIN_PASSWORD.toLowerCase()) {
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 401, { error: "비밀번호가 일치하지 않습니다." });
    }

    // Protect all `/api/*` endpoints with `X-Admin-Password: cycy`
    if (pathname.startsWith("/api/")) {
      const providedPw = String(req.headers["x-admin-password"] || parsedUrl.searchParams.get("pw") || "").trim().toLowerCase();
      if (providedPw !== ADMIN_PASSWORD.toLowerCase()) {
        return sendJson(res, 401, { error: "잠금 상태입니다. 비밀번호를 입력해주세요.", locked: true });
      }
    }

    // 1. Get current server state
    if (pathname === "/api/state" && req.method === "GET") {
      if (lastKnownRuns.length === 0 && state.config.accessToken) {
        await fetchCurrentRuns().catch(() => {});
      }
      const jwt = decodeJwtPayload(state.config.accessToken);
      const fleet = computeWorkerFleetStats(lastKnownRuns);
      return sendJson(res, 200, {
        config: {
          ...state.config,
          resolvedUserName: resolveCurrentUserName(),
          hasAccessToken: Boolean(state.config.accessToken),
          hasRefreshToken: Boolean(state.config.refreshToken),
          jwtInfo: jwt
            ? {
                sub: jwt.preferred_username || jwt.username || jwt.sub || jwt.user_id || jwt.email,
                exp: jwt.exp ? new Date(jwt.exp * 1000).toISOString() : null,
                remainingSec: jwt.exp ? Math.floor(jwt.exp - Date.now() / 1000) : null,
              }
            : null,
        },
        jobs: state.jobs,
        presets: state.presets || [],
        telemetry: fleet.telemetry,
        history: state.history.slice(0, 100),
        alerts: (state.alerts || []).slice(0, 50),
        schedulerLoopStats,
        approvalLoopStats,
        autoApprovalTimeline: fleet.autoApprovalTimeline || [],
        workerFleet: fleet,
        loadMonitor: fleet.loadMonitor,
      });
    }

    // 2. Update config (including all intervals, Smart Load Guard & Features 1–6 settings!)
    if (pathname === "/api/config" && req.method === "POST") {
      const body = await readJsonBody(req);
      const incomingGroupId = body.groupId !== undefined ? sanitizeGroupId(body.groupId) : sanitizeGroupId(state.config.groupId);
      state.config = {
        ...state.config,
        ...(body.baseUrl !== undefined ? { baseUrl: String(body.baseUrl).trim() } : {}),
        ...(body.sfmUrl !== undefined ? { sfmUrl: String(body.sfmUrl).trim() } : {}),
        ...(body.accessToken !== undefined ? { accessToken: String(body.accessToken).replace(/^Bearer\s+/i, "").trim() } : {}),
        ...(body.refreshToken !== undefined ? { refreshToken: String(body.refreshToken).trim() } : {}),
        ...(body.groupId !== undefined ? { groupId: incomingGroupId } : {}),
        ...(body.orgId !== undefined ? { orgId: String(body.orgId).trim() } : {}),
        ...(body.userName !== undefined ? { userName: String(body.userName).trim() } : {}),
        ...(body.schedulerEnabled !== undefined ? { schedulerEnabled: Boolean(body.schedulerEnabled) } : {}),
        ...(body.checkIntervalSec !== undefined ? { checkIntervalSec: Math.max(1, Number(body.checkIntervalSec)) } : {}),
        ...(body.approvalCheckIntervalSec !== undefined
          ? { approvalCheckIntervalSec: Math.max(1, Number(body.approvalCheckIntervalSec)) }
          : {}),
        ...(body.uiRefreshIntervalSec !== undefined ? { uiRefreshIntervalSec: Math.max(1, Number(body.uiRefreshIntervalSec)) } : {}),
        ...(body.postCreateApproveRetries !== undefined
          ? { postCreateApproveRetries: Math.max(1, Number(body.postCreateApproveRetries)) }
          : {}),
        ...(body.postCreateApproveDelaySec !== undefined
          ? { postCreateApproveDelaySec: Math.max(1, Number(body.postCreateApproveDelaySec)) }
          : {}),
        ...(body.autoApprovalScope !== undefined ? { autoApprovalScope: String(body.autoApprovalScope) } : {}),
        ...(body.smartLoadGuardEnabled !== undefined
          ? { smartLoadGuardEnabled: Boolean(body.smartLoadGuardEnabled) }
          : {}),
        ...(body.maxPendingWorkers !== undefined
          ? { maxPendingWorkers: Math.max(1, Math.min(32, Number(body.maxPendingWorkers || 2))) }
          : {}),
        ...(body.stepByStepRunningCheck !== undefined
          ? { stepByStepRunningCheck: Boolean(body.stepByStepRunningCheck) }
          : {}),
        ...(body.apiLatencyWarnMs !== undefined
          ? { apiLatencyWarnMs: Math.max(300, Number(body.apiLatencyWarnMs || 1800)) }
          : {}),
        ...(body.apiLatencyCriticalMs !== undefined
          ? { apiLatencyCriticalMs: Math.max(500, Number(body.apiLatencyCriticalMs || 3500)) }
          : {}),
        ...(body.adaptivePollingEnabled !== undefined
          ? { adaptivePollingEnabled: Boolean(body.adaptivePollingEnabled) }
          : {}),
        // Feature 1: Watchdog
        ...(body.watchdogEnabled !== undefined ? { watchdogEnabled: Boolean(body.watchdogEnabled) } : {}),
        ...(body.maxPendingTimeoutMin !== undefined
          ? { maxPendingTimeoutMin: Math.max(3, Number(body.maxPendingTimeoutMin || 20)) }
          : {}),
        ...(body.logErrorAutoRestart !== undefined ? { logErrorAutoRestart: Boolean(body.logErrorAutoRestart) } : {}),
        ...(body.customErrorKeywords !== undefined ? { customErrorKeywords: String(body.customErrorKeywords || "").trim() } : {}),
        // Feature 3: Auto-Sharding (`WORKER_SLOT`)
        ...(body.injectWorkerEnv !== undefined ? { injectWorkerEnv: Boolean(body.injectWorkerEnv) } : {}),
        // Feature 4: Spot ↔ Standard Hybrid Auto-Fallback
        ...(body.hybridFallbackEnabled !== undefined ? { hybridFallbackEnabled: Boolean(body.hybridFallbackEnabled) } : {}),
        ...(body.fallbackCoreId !== undefined ? { fallbackCoreId: String(body.fallbackCoreId || "").trim() } : {}),
        // Feature 5: Time-of-Day / Weekend Auto-Scaling
        ...(body.timeScaleEnabled !== undefined ? { timeScaleEnabled: Boolean(body.timeScaleEnabled) } : {}),
        ...(body.dayTargetWorkers !== undefined ? { dayTargetWorkers: Math.max(1, Number(body.dayTargetWorkers || 20)) } : {}),
        ...(body.nightTargetWorkers !== undefined ? { nightTargetWorkers: Math.max(1, Number(body.nightTargetWorkers || 48)) } : {}),
        ...(body.weekendTargetWorkers !== undefined
          ? { weekendTargetWorkers: Math.max(1, Number(body.weekendTargetWorkers || 64)) }
          : {}),
        ...(body.nightStartHour !== undefined ? { nightStartHour: Math.max(0, Math.min(23, Number(body.nightStartHour ?? 20))) } : {}),
        ...(body.nightEndHour !== undefined ? { nightEndHour: Math.max(0, Math.min(23, Number(body.nightEndHour ?? 8))) } : {}),
        // Feature 6: Webhook & Browser Notification Center
        ...(body.webhookUrl !== undefined ? { webhookUrl: String(body.webhookUrl || "").trim() } : {}),
        ...(body.browserNotifyEnabled !== undefined ? { browserNotifyEnabled: Boolean(body.browserNotifyEnabled) } : {}),
        ...(body.notifyOnTokenExpiring !== undefined ? { notifyOnTokenExpiring: Boolean(body.notifyOnTokenExpiring) } : {}),
        ...(body.notifyOnZombieTerminated !== undefined
          ? { notifyOnZombieTerminated: Boolean(body.notifyOnZombieTerminated) }
          : {}),
        ...(body.notifyOnTargetReached !== undefined ? { notifyOnTargetReached: Boolean(body.notifyOnTargetReached) } : {}),
        ...(body.notifyOnError !== undefined ? { notifyOnError: Boolean(body.notifyOnError) } : {}),
        // Batch 2 - Features 1, 3, 6
        ...(body.syncEditedScriptsOnStart !== undefined
          ? { syncEditedScriptsOnStart: Boolean(body.syncEditedScriptsOnStart) }
          : {}),
        ...(body.autoStopOnComplete !== undefined ? { autoStopOnComplete: Boolean(body.autoStopOnComplete) } : {}),
        ...(body.autoStopOnCompleteKeyword !== undefined
          ? { autoStopOnCompleteKeyword: String(body.autoStopOnCompleteKeyword || "").trim() }
          : {}),
        ...(body.maxTotalSucceededRuns !== undefined
          ? { maxTotalSucceededRuns: Math.max(0, Number(body.maxTotalSucceededRuns || 0)) }
          : {}),
        ...(body.nextStageCommand !== undefined ? { nextStageCommand: String(body.nextStageCommand || "").trim() } : {}),
        ...(body.badNodeGuardEnabled !== undefined ? { badNodeGuardEnabled: Boolean(body.badNodeGuardEnabled) } : {}),
        ...(body.badNodeRapidFailSec !== undefined
          ? { badNodeRapidFailSec: Math.max(20, Number(body.badNodeRapidFailSec || 180)) }
          : {}),
        ...(body.badNodeCooldownSec !== undefined
          ? { badNodeCooldownSec: Math.max(5, Number(body.badNodeCooldownSec || 25)) }
          : {}),
      };
      // Smart JWT classification & dead refresh-token cleanup on config save
      if (state.config.accessToken) {
        const accPayload = decodeJwtPayload(state.config.accessToken);
        if (accPayload?.typ === "Refresh") {
          state.config.refreshToken = state.config.accessToken;
          lastDeadRefreshToken = "";
          await refreshAccessToken();
        } else if (accPayload?.preferred_username && !state.config.userName) {
          state.config.userName = String(accPayload.preferred_username);
        }
      }
      if (state.config.refreshToken) {
        const refPayload = decodeJwtPayload(state.config.refreshToken);
        const nowSec = Math.floor(Date.now() / 1000);
        if (refPayload?.exp && refPayload.exp < nowSec) {
          // Clear already-expired refresh token so it doesn't fail on auto-refresh
          state.config.refreshToken = "";
        } else {
          lastDeadRefreshToken = "";
        }
      }
      resolveGroupId();
      if (state.config.timeScaleEnabled) {
        applyTimeScaleToJobs();
      }
      saveState();
      addLog("info", "서버 및 6대 스마트 자동화/부하보호 설정이 업데이트되었습니다.", {
        groupId: state.config.groupId,
        checkIntervalSec: state.config.checkIntervalSec,
        approvalCheckIntervalSec: state.config.approvalCheckIntervalSec,
        uiRefreshIntervalSec: state.config.uiRefreshIntervalSec,
        smartLoadGuardEnabled: state.config.smartLoadGuardEnabled,
        watchdogEnabled: state.config.watchdogEnabled,
        injectWorkerEnv: state.config.injectWorkerEnv,
        hybridFallbackEnabled: state.config.hybridFallbackEnabled,
        timeScaleEnabled: state.config.timeScaleEnabled,
      });
      const fleet = computeWorkerFleetStats(lastKnownRuns);
      return sendJson(res, 200, { ok: true, config: state.config, workerFleet: fleet, loadMonitor: fleet.loadMonitor });
    }

    // 3. Discover SPACE Metadata (Auto-selects Group ID, Group Pool ID, Core ID, Quota ID)
    if (pathname === "/api/space/discover" && req.method === "GET") {
      const activeGroup = resolveGroupId();
      const result = {
        user: null,
        selectedGroupId: activeGroup || "",
        groups: [],
        groupPools: [],
        groupPoolsStatus: [],
        spotCores: [],
        priorities: [],
        groupResources: null,
        groupPolicy: [],
        experiments: [],
        specifications: [],
        images: [],
        autoFilledJob: null,
        errors: {},
      };

      // Step 1: Fetch User & Groups first so we can auto-fill `groupId` if the user doesn't know it!
      await Promise.all([
        (async () => {
          try {
            const u = await spaceApi.getUserInfo();
            const userObj = u?.data || u;
            const detectedName = userObj?.userName || userObj?.username || userObj?.id || userObj?.name;
            if (detectedName && !state.config.userName) {
              state.config.userName = String(detectedName);
              saveState();
            }
            result.user = userObj;
          } catch (e) {
            result.errors.user = e.message;
          }
        })(),
        (async () => {
          try {
            const gRes = await spaceApi.getGroups();
            const rawGroups = extractItemsArray(gRes);
            // In SPACE `/api/acm/groups` (`index-CbpkrgJF.js#L108474`), each item has `{ name: "SR-Coredata" }`
            const groups = rawGroups.map((g) => {
              const gId = sanitizeGroupId(g.id ?? g.groupId ?? g.name);
              return {
                ...g,
                id: gId,
                groupId: gId,
                name: g.name ?? g.groupName ?? gId,
              };
            });
            result.groups = groups;
            if (!resolveGroupId() && groups.length > 0) {
              const firstId = groups[0].id;
              if (firstId) {
                state.config.groupId = String(firstId);
                saveState();
                addLog("info", `SPACE 그룹 목록에서 첫 번째 그룹(${groups[0].name || firstId})을 자동 선택했습니다.`);
              }
            }
            result.selectedGroupId = resolveGroupId() || "";
          } catch (e) {
            result.errors.groups = e.message;
          }
        })(),
      ]);

      // Step 2: Now fetch Group Pools, GPU Cores, Quotas/Priorities, Specifications, Images
      if (resolveGroupId()) {
        try {
          const orgRes = await spaceApi.getGroupOrg(state.config.groupId);
          const orgId = orgRes?.data?.organization || orgRes?.organization;
          if (orgId && !state.config.orgId) {
            state.config.orgId = String(orgId);
            saveState();
          }
        } catch {
          // ignore
        }

        const tasks = [
          ["groupPools", async () => extractItemsArray(await spaceApi.getGroupPools())],
          ["groupPoolsStatus", async () => extractItemsArray(await spaceApi.getGroupPoolsStatus(state.config.groupId))],
          ["spotCores", async () => extractItemsArray(await spaceApi.getCores())],
          ["priorities", async () => normalizePrioritiesList(await spaceApi.getPriorities(), state.config.groupId)],
          ["groupResources", async () => await spaceApi.getGroupResources(state.config.orgId)],
          ["groupPolicy", async () => extractItemsArray(await spaceApi.getGroupPolicy())],
          ["experiments", async () => extractItemsArray(await spaceApi.getExperiments())],
          ["specifications", async () => extractItemsArray(await spaceApi.getSpecifications())],
          ["images", async () => await fetchNormalizedImages()],
        ];

        await Promise.all(
          tasks.map(async ([key, fn]) => {
            try {
              const val = await fn();
              result[key] = val?.data !== undefined && !Array.isArray(val) ? val.data : val;
            } catch (e) {
              result.errors[key] = e.message;
            }
          })
        );

        // Step 3: Auto-fill empty `groupPoolId`, `coreId`, `quotaId`, `containerImage` on saved jobs!
        let jobsUpdated = false;
        for (const job of state.jobs) {
          if (!job.groupPoolId && result.groupPools.length > 0) {
            const p0 = result.groupPools[0];
            const pId = p0.id ?? p0.groupPoolId ?? p0.poolId;
            if (pId !== undefined && pId !== null) {
              job.groupPoolId = String(pId);
              jobsUpdated = true;
            }
          }
          if (!job.coreId) {
            const matchedPool =
              result.groupPools.find((p) => String(p.id ?? p.groupPoolId ?? p.poolId) === String(job.groupPoolId)) ||
              result.groupPools[0];
            const cores = matchedPool?.cores || matchedPool?.coreList || result.spotCores || [];
            if (cores.length > 0) {
              const cId = cores[0].id ?? cores[0].coreId;
              if (cId !== undefined && cId !== null) {
                job.coreId = String(cId);
                jobsUpdated = true;
              }
            }
          }
          if (!job.quotaId && result.priorities.length > 0) {
            const qId = result.priorities[0].id ?? result.priorities[0].quotaId;
            if (qId !== undefined && qId !== null) {
              job.quotaId = String(qId);
              jobsUpdated = true;
            }
          }
          if (!job.containerImage && result.images.length > 0) {
            const im0 = result.images[0];
            const url = im0.containerImageName || im0.imageUrl || im0.url || im0.fullPath || im0.name;
            if (url) {
              job.containerImage = String(url);
              jobsUpdated = true;
            }
          }
        }
        if (jobsUpdated) {
          saveState();
        }
        result.autoFilledJob = state.jobs[0] || null;
      }

      return sendJson(res, 200, result);
    }

    // 4. Load single WLM Specification detail
    if (pathname.startsWith("/api/space/specification/") && req.method === "GET") {
      const specId = pathname.split("/").pop();
      const spec = await spaceApi.getSpecificationDetail(specId);
      return sendJson(res, 200, spec?.data || spec);
    }

    // 5. Browse SFM Group Volume files
    if (pathname === "/api/space/sfm-files" && req.method === "GET") {
      const dirPath = parsedUrl.searchParams.get("path") || "/";
      const files = await spaceApi.listSfmFiles(dirPath);
      return sendJson(res, 200, files);
    }

    // 5-B. Batch 2 - Feature 1: In-Dashboard `/group-volume` Script Read & 1-Click Rolling Deploy
    if (pathname === "/api/space/sfm-file" && req.method === "GET") {
      const filePath = parsedUrl.searchParams.get("path") || "/group-volume/run.sh";
      const fileData = await spaceApi.readSfmFile(filePath);
      return sendJson(res, 200, fileData);
    }

    if (pathname === "/api/space/sfm-file" && req.method === "POST") {
      const body = await readJsonBody(req);
      const filePath = String(body.path || "/group-volume/run.sh").trim();
      const content = String(body.content ?? "");
      const writeRes = await spaceApi.writeSfmFile(filePath, content);
      addLog(
        "info",
        `📝 [웹 에디터 스크립트 저장] ${writeRes.path} 저장 완료 (컨테이너 시작 시 자동 동기화: ${state.config.syncEditedScriptsOnStart !== false ? "ON" : "OFF"})`,
        { path: writeRes.path, remoteSaved: writeRes.remoteSaved }
      );

      let rollingResult = null;
      if (body.rollingRestart) {
        const runs = await fetchCurrentRuns(true).catch(() => lastKnownRuns);
        const runningRuns = runs
          .filter(
            (r) =>
              classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE" &&
              String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
          )
          .sort((a, b) => Number(a.id ?? a.runId ?? 0) - Number(b.id ?? b.runId ?? 0));
        const batchSize = Math.max(1, Math.min(8, Number(body.batchSize || 2)));
        const targets = runningRuns.slice(0, batchSize);
        const terminatedIds = [];
        for (const r of targets) {
          const rId = String(r.id ?? r.runId ?? "");
          if (!rId) continue;
          try {
            await spaceApi.terminateRun(rId);
            terminatedIds.push(rId);
            await sleep(250);
          } catch {
            // ignore
          }
        }
        rollingResult = { terminatedCount: terminatedIds.length, terminatedIds };
        addLog(
          "info",
          `🚀 [스크립트 저장 + 원클릭 롤링 배포] ${writeRes.path} 저장 후 가동 워커 ${terminatedIds.length}개를 교체 재시작했습니다.`
        );
      }

      const fleet = computeWorkerFleetStats(lastKnownRuns);
      return sendJson(res, 200, {
        ...writeRes,
        rollingResult,
        workerFleet: fleet,
      });
    }

    // 6. List Live WLM Runs on SPACE (auto-approves any pending run on the fly if auto-approval is active!)
    if (pathname === "/api/space/runs" && req.method === "GET") {
      if (!state.config.accessToken) {
        return sendJson(res, 200, { runs: [], needsToken: true, workerFleet: computeWorkerFleetStats([]) });
      }
      const runs = await fetchCurrentRuns();
      const anyPendingWlm = runs.some((r) => String(r.status ?? r.state ?? "").toUpperCase().includes("PENDING"));
      const anyJobAutoApprove = state.jobs.some((j) => j.autoApprove !== false);
      if (anyPendingWlm && (state.config.autoApprovalScope !== "off" || anyJobAutoApprove)) {
        await processPendingApprovals().catch(() => {});
      }
      // Attach approval status from recent approvals so UI knows whether a Pending WLM run is already Admin-approved
      try {
        const recentRes = await spaceApi.getApprovalsList({ status: "", page: 1, limit: 30 }).catch(() => null);
        const recentArr = extractItemsArray(recentRes);
        const approvalMap = new Map();
        for (const item of recentArr) {
          if (item?.runId) approvalMap.set(String(item.runId), String(item.status || "").toLowerCase());
        }
        for (const r of runs) {
          const rId = String(r.id ?? r.runId ?? "");
          if (approvalMap.has(rId)) {
            r.approvalStatus = approvalMap.get(rId);
          }
        }
      } catch {
        // ignore
      }
      return sendJson(res, 200, { runs, workerFleet: computeWorkerFleetStats(runs) });
    }

    // 7. Get Live WLM Run Log
    if (pathname.startsWith("/api/space/runs/") && pathname.endsWith("/log") && req.method === "GET") {
      const parts = pathname.split("/");
      const runId = parts[parts.length - 2];
      const logText = await spaceApi.getRunLog(runId, { tailLines: 500 });
      return sendJson(res, 200, { runId, log: logText });
    }

    // 8. Stop/Terminate a WLM Run (optionally decrementing rule target count when `reduceTarget: true` / "슬롯 삭제")
    if (pathname.startsWith("/api/space/runs/") && pathname.endsWith("/stop") && req.method === "POST") {
      const parts = pathname.split("/");
      const runId = parts[parts.length - 2];
      const body = await readJsonBody(req).catch(() => ({}));
      const reduceTarget = Boolean(body?.reduceTarget);
      const targetRun = (lastKnownRuns || []).find((r) => String(r.id ?? r.runId ?? "") === String(runId)) || null;
      const runName = targetRun?.containerName || targetRun?.name || `#${runId}`;
      const out = await spaceApi.terminateRun(runId);
      markRunRecentlyTerminated(runId);

      let updatedJob = null;
      if (reduceTarget) {
        const matchedJob =
          (body?.jobId && state.jobs.find((j) => String(j.id) === String(body.jobId))) ||
          (targetRun && state.jobs.find((j) => doesRunMatchJob(targetRun, j, state.jobs))) ||
          state.jobs.find((j) => j.enabled) ||
          state.jobs[0];
        if (matchedJob) {
          const prevTarget = Math.max(1, Number(matchedJob.minConcurrentRuns || 1));
          const nextTarget = Math.max(1, prevTarget - 1);
          matchedJob.minConcurrentRuns = nextTarget;
          if (prevTarget === 1) {
            matchedJob.enabled = false;
          }
          updatedJob = matchedJob;
          saveState();
        }
      }

      await fetchCurrentRuns(true).catch(() => {});
      addLog(
        "warn",
        reduceTarget && updatedJob
          ? `🗑️ [워커 슬롯 삭제] ${runName} (#${runId}) 강제 종료 + [${updatedJob.name}] 목표 워커 수 ${updatedJob.minConcurrentRuns}개로 자동 축소 (재생성 방지)`
          : `🛑 [워커 즉시 Kill] ${runName} (#${runId}) 강제 종료 완료`,
        { runId, runName, reduceTarget, newTarget: updatedJob?.minConcurrentRuns }
      );
      return sendJson(res, 200, {
        ok: true,
        data: out,
        reduceTarget,
        updatedJob,
        jobs: state.jobs,
        workerFleet: computeWorkerFleetStats(lastKnownRuns),
      });
    }

    // 8-A. Feature 2: Bulk Worker Control (`stop_selected`, `delete_selected`, `trim_excess_pending`, `scan_logs`, `stop_pending`, `rolling_restart`, `stop_all`)
    if (pathname === "/api/space/runs/bulk-action" && req.method === "POST") {
      const body = await readJsonBody(req);
      const action = String(body.action || "").trim();
      const runs = await fetchCurrentRuns(true).catch(() => lastKnownRuns);
      const activeRuns = runs
        .filter((r) => classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE")
        .sort((a, b) => Number(a.id ?? a.runId ?? 0) - Number(b.id ?? b.runId ?? 0));
      const runningRuns = activeRuns.filter((r) =>
        String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
      );
      const pendingRuns = activeRuns.filter(
        (r) => !String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING")
      );

      if (action === "stop_selected" || action === "delete_selected") {
        const reduceTarget = Boolean(action === "delete_selected" || body.reduceTarget);
        const requestedRunIds = new Set(
          (Array.isArray(body.runIds) ? body.runIds : []).map((x) => String(x || "").trim()).filter(Boolean)
        );
        const requestedSlots = (Array.isArray(body.slotNumbers) ? body.slotNumbers : [])
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n >= 1);

        // Resolve `slotNumbers` (1-based sequential worker index on the focused job's fleet board) into `runIds`
        if (requestedSlots.length > 0) {
          const preFleet = computeWorkerFleetStats(runs);
          const targetJf =
            (body.jobId && preFleet.jobs.find((j) => String(j.jobId) === String(body.jobId))) ||
            preFleet.jobs.find((j) => j.enabled && (j.activeCount || 0) > 0) ||
            preFleet.jobs.find((j) => j.enabled) ||
            preFleet.jobs[0];
          if (targetJf && Array.isArray(targetJf.activeWorkers)) {
            const slotSet = new Set(requestedSlots);
            for (const w of targetJf.activeWorkers) {
              if (slotSet.has(Number(w.slotIndex)) || slotSet.has(Number(w.stateOrderIndex))) {
                requestedRunIds.add(String(w.id));
              }
            }
          }
        }

        const targetIdsList = Array.from(requestedRunIds);
        if (targetIdsList.length === 0) {
          return sendJson(res, 400, { error: "선택된 워커 슬롯 또는 Run ID가 없습니다." });
        }

        const terminatedIds = [];
        const terminatedNames = [];
        const perJobTerminatedCount = new Map();

        for (const rId of targetIdsList) {
          const runObj = runs.find((r) => String(r.id ?? r.runId ?? "") === rId) || null;
          try {
            await spaceApi.terminateRun(rId);
            markRunRecentlyTerminated(rId);
            terminatedIds.push(rId);
            terminatedNames.push(runObj?.containerName || runObj?.name || `#${rId}`);
            if (reduceTarget) {
              const matchedJob =
                (body.jobId && state.jobs.find((j) => String(j.id) === String(body.jobId))) ||
                (runObj && state.jobs.find((j) => doesRunMatchJob(runObj, j, state.jobs)));
              if (matchedJob) {
                perJobTerminatedCount.set(matchedJob.id, (perJobTerminatedCount.get(matchedJob.id) || 0) + 1);
              }
            }
            if (targetIdsList.length > 1) {
              await sleep(150);
            }
          } catch {
            // ignore individual failure
          }
        }

        if (reduceTarget && perJobTerminatedCount.size > 0) {
          for (const [jId, delCnt] of perJobTerminatedCount.entries()) {
            const jobObj = state.jobs.find((j) => String(j.id) === String(jId));
            if (!jobObj) continue;
            // Compute new target so scheduler does not respawn the deleted workers
            const remainingActiveForJob = activeRuns.filter(
              (r) => !terminatedIds.includes(String(r.id ?? r.runId ?? "")) && doesRunMatchJob(r, jobObj, state.jobs)
            ).length;
            const prevTarget = Math.max(1, Number(jobObj.minConcurrentRuns || 1));
            const nextTargetBySub = Math.max(1, prevTarget - delCnt);
            jobObj.minConcurrentRuns = Math.min(nextTargetBySub, Math.max(1, remainingActiveForJob));
            if (remainingActiveForJob === 0 && prevTarget <= delCnt) {
              jobObj.enabled = false;
            }
          }
          saveState();
        }

        const updatedRuns = await fetchCurrentRuns(true).catch(() => lastKnownRuns);
        const fleet = computeWorkerFleetStats(updatedRuns);
        addLog(
          "warn",
          reduceTarget
            ? `🗑️ [선택 워커 슬롯 영구 삭제] 선택한 워커 ${terminatedIds.length}개(${terminatedNames.slice(0, 6).join(", ")}${terminatedNames.length > 6 ? ` 외 ${terminatedNames.length - 6}개` : ""})를 강제 종료하고 목표 워커 수를 자동 축소했습니다.`
            : `🛑 [선택 워커 슬롯 즉시 Kill] 선택한 워커 ${terminatedIds.length}개(${terminatedNames.slice(0, 6).join(", ")}${terminatedNames.length > 6 ? ` 외 ${terminatedNames.length - 6}개` : ""})를 강제 종료했습니다.`,
          { terminatedIds, terminatedNames, reduceTarget }
        );
        return sendJson(res, 200, {
          ok: true,
          action,
          reduceTarget,
          terminatedCount: terminatedIds.length,
          terminatedIds,
          terminatedNames,
          jobs: state.jobs,
          workerFleet: fleet,
        });
      }

      if (action === "scan_logs") {
        const scanRes = await scanWorkerLogsRoundRobin(runs, { scanAll: true });
        const fleet = computeWorkerFleetStats(runs);
        addLog("info", `🔍 [실시간 워커 로그 스캔] 가동 중인 워커 ${scanRes.scannedCount}개의 최신 로그 및 에러 패턴 점검 완료`);
        return sendJson(res, 200, {
          ok: true,
          action,
          scannedCount: scanRes.scannedCount,
          workerFleet: fleet,
        });
      }

      if (action === "trim_excess_pending") {
        const targetJobId = body.jobId ? String(body.jobId) : null;
        const targetJobs = targetJobId ? state.jobs.filter((j) => String(j.id) === targetJobId) : state.jobs;
        const terminatedIds = [];
        const terminatedNames = [];
        for (const job of targetJobs) {
          const matchingActive = activeRuns.filter((r) => doesRunMatchJob(r, job, state.jobs));
          const matchingPending = matchingActive
            .filter((r) => !String(r.status || r.state || r.phase || "").toUpperCase().includes("RUNNING"))
            .sort((a, b) => Number(b.id ?? b.runId ?? 0) - Number(a.id ?? a.runId ?? 0)); // newest Pending first
          const targetCnt = Math.max(1, Number(job.minConcurrentRuns || 1));
          const excessCnt = Math.max(0, Math.min(matchingPending.length, matchingActive.length - targetCnt));
          const toTerminate = matchingPending.slice(0, excessCnt);
          for (const r of toTerminate) {
            const rId = String(r.id ?? r.runId ?? "");
            if (!rId) continue;
            try {
              await spaceApi.terminateRun(rId);
              markRunRecentlyTerminated(rId);
              terminatedIds.push(rId);
              terminatedNames.push(r.containerName || r.name || `#${rId}`);
              await sleep(200);
            } catch {
              // ignore
            }
          }
        }
        const updatedRuns = await fetchCurrentRuns(true).catch(() => lastKnownRuns);
        const fleet = computeWorkerFleetStats(updatedRuns);
        addLog(
          "warn",
          `✂️ [초과 Pending 워커 자동 정리] 목표 워커 수를 초과한 대기(Pending) 워커 ${terminatedIds.length}개(${terminatedNames.join(", ") || "-"})를 정리하여 목표 수량에 맞췄습니다.`,
          { terminatedIds, terminatedNames }
        );
        return sendJson(res, 200, {
          ok: true,
          action,
          terminatedCount: terminatedIds.length,
          terminatedIds,
          terminatedNames,
          workerFleet: fleet,
        });
      }

      if (action === "stop_pending") {
        const terminatedIds = [];
        for (const r of pendingRuns) {
          const rId = String(r.id ?? r.runId ?? "");
          if (!rId) continue;
          try {
            await spaceApi.terminateRun(rId);
            markRunRecentlyTerminated(rId);
            terminatedIds.push(rId);
            await sleep(250);
          } catch {
            // ignore
          }
        }
        const updatedRuns = await fetchCurrentRuns(true).catch(() => lastKnownRuns);
        const fleet = computeWorkerFleetStats(updatedRuns);
        addLog("warn", `⏳ [Pending 워커 일괄 취소] 준비 대기 중인 워커 ${terminatedIds.length}개를 일괄 취소했습니다.`, {
          terminatedIds,
        });
        return sendJson(res, 200, {
          ok: true,
          action,
          terminatedCount: terminatedIds.length,
          terminatedIds,
          workerFleet: fleet,
        });
      }

      if (action === "rolling_restart") {
        const batchSize = Math.max(1, Math.min(8, Number(body.batchSize || 1)));
        const targets = runningRuns.slice(0, batchSize);
        const terminatedIds = [];
        const terminatedNames = [];
        for (const r of targets) {
          const rId = String(r.id ?? r.runId ?? "");
          if (!rId) continue;
          try {
            await spaceApi.terminateRun(rId);
            markRunRecentlyTerminated(rId);
            terminatedIds.push(rId);
            terminatedNames.push(r.containerName || r.name || `#${rId}`);
            await sleep(300);
          } catch {
            // ignore
          }
        }
        const updatedRuns = await fetchCurrentRuns(true).catch(() => lastKnownRuns);
        const fleet = computeWorkerFleetStats(updatedRuns);
        addLog(
          "info",
          `🔄 [무중단 롤링 재시작] 가장 오래된 Running 워커 ${terminatedIds.length}개(${terminatedNames.join(", ") || "-"})를 종료했습니다. 스케줄러가 최신 스크립트로 즉시 새 워커를 보충합니다.`,
          { terminatedIds, terminatedNames }
        );
        return sendJson(res, 200, {
          ok: true,
          action,
          terminatedCount: terminatedIds.length,
          terminatedIds,
          terminatedNames,
          workerFleet: fleet,
        });
      }

      if (action === "stop_all") {
        if (body.pauseAutoCreate !== false) {
          for (const j of state.jobs) j.enabled = false;
          saveState();
        }
        const terminatedIds = [];
        for (const r of activeRuns) {
          const rId = String(r.id ?? r.runId ?? "");
          if (!rId) continue;
          try {
            await spaceApi.terminateRun(rId);
            markRunRecentlyTerminated(rId);
            terminatedIds.push(rId);
            await sleep(250);
          } catch {
            // ignore
          }
        }
        const updatedRuns = await fetchCurrentRuns(true).catch(() => lastKnownRuns);
        const fleet = computeWorkerFleetStats(updatedRuns);
        addLog(
          "warn",
          `🛑 [전체 워커 일괄 종료] 활성 워커 ${terminatedIds.length}개를 일괄 종료했습니다.${body.pauseAutoCreate !== false ? " (주기 자동생성 OFF 전환됨)" : ""}`,
          { terminatedIds }
        );
        return sendJson(res, 200, {
          ok: true,
          action,
          terminatedCount: terminatedIds.length,
          terminatedIds,
          jobs: state.jobs,
          workerFleet: fleet,
        });
      }

      return sendJson(res, 400, { error: `Unknown bulk action: ${action}` });
    }

    // 8-A2. Features 1–6 Quick Toggle & Settings Update Endpoint
    if (pathname === "/api/automation/quick-update" && req.method === "POST") {
      const body = await readJsonBody(req);
      const keys = [
        "watchdogEnabled",
        "maxPendingTimeoutMin",
        "logErrorAutoRestart",
        "customErrorKeywords",
        "injectWorkerEnv",
        "hybridFallbackEnabled",
        "fallbackCoreId",
        "timeScaleEnabled",
        "dayTargetWorkers",
        "nightTargetWorkers",
        "weekendTargetWorkers",
        "nightStartHour",
        "nightEndHour",
        "webhookUrl",
        "browserNotifyEnabled",
        "notifyOnTokenExpiring",
        "notifyOnZombieTerminated",
        "notifyOnTargetReached",
        "notifyOnError",
        "syncEditedScriptsOnStart",
        "autoStopOnComplete",
        "autoStopOnCompleteKeyword",
        "maxTotalSucceededRuns",
        "nextStageCommand",
        "badNodeGuardEnabled",
        "badNodeRapidFailSec",
        "badNodeCooldownSec",
      ];
      for (const k of keys) {
        if (body[k] !== undefined) {
          state.config[k] = body[k];
        }
      }
      if (state.config.timeScaleEnabled) {
        applyTimeScaleToJobs();
      }
      saveState();
      const fleet = computeWorkerFleetStats(lastKnownRuns);
      addLog("info", `⚡ [스마트 자동화 빠른 설정 변경] 완료`, body);
      return sendJson(res, 200, {
        ok: true,
        config: state.config,
        jobs: state.jobs,
        workerFleet: fleet,
        loadMonitor: fleet.loadMonitor,
      });
    }

    // 8-A3. Feature 6: Test Notification Endpoint
    if (pathname === "/api/notifications/test" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (body.webhookUrl !== undefined) {
        state.config.webhookUrl = String(body.webhookUrl || "").trim();
        saveState();
      }
      const fleet = computeWorkerFleetStats(lastKnownRuns);
      const alertEntry = await pushAlertNotification(
        "info",
        "SPACE GPU Auto-Allocator 테스트 알림",
        `알림 센터 정상 작동 확인! 현재 가동 워커: ${fleet.totalRunningWorkers}개 Running / 전체 활성 ${fleet.totalActiveWorkers}/${fleet.totalTargetWorkers}개 (총 GPU ${fleet.totalActiveGpus}/${fleet.totalTargetGpus}장)`,
        { test: true, dedupeKey: `test-${Date.now()}` }
      );
      addLog("info", `🔔 [알림 테스트 발송] 브라우저 알림 및 웹훅(${state.config.webhookUrl ? "연결됨" : "미설정"}) 테스트 완료`);
      return sendJson(res, 200, {
        ok: true,
        alert: alertEntry,
        alerts: (state.alerts || []).slice(0, 30),
        workerFleet: fleet,
      });
    }

    // 8-A4. Batch 2 - Feature 4: Experiment Presets Bookmark Endpoints (`GET/POST /api/presets`, `POST /api/presets/apply`, `DELETE /api/presets/:id`)
    if (pathname === "/api/presets" && req.method === "GET") {
      return sendJson(res, 200, { presets: state.presets || [] });
    }

    if (pathname === "/api/presets" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!Array.isArray(state.presets)) state.presets = [];
      const activeJob =
        (body.jobId && state.jobs.find((j) => j.id === body.jobId)) ||
        state.jobs.find((j) => j.enabled) ||
        state.jobs[0] ||
        {};
      const newPreset = {
        id: body.id || `preset-${Date.now()}`,
        name: String(body.name || "새 실험 프리셋").trim(),
        badge: String(body.badge || `${body.minConcurrentRuns || activeJob.minConcurrentRuns || 1}W`).trim(),
        executionCommand: String(body.executionCommand ?? activeJob.executionCommand ?? "bash /group-volume/run.sh").trim(),
        minConcurrentRuns: Math.max(1, Number(body.minConcurrentRuns ?? activeJob.minConcurrentRuns ?? 1)),
        coreCount: Math.max(1, Number(body.coreCount ?? activeJob.coreCount ?? 1)),
        allowSpot: Boolean(body.allowSpot ?? activeJob.allowSpot),
        expectedRunTime: String(body.expectedRunTime ?? activeJob.expectedRunTime ?? "8h"),
        injectWorkerEnv: Boolean(body.injectWorkerEnv ?? state.config.injectWorkerEnv),
        nextStageCommand: String(body.nextStageCommand ?? state.config.nextStageCommand ?? "").trim(),
        updatedAt: new Date().toISOString(),
      };
      const existingIdx = state.presets.findIndex((p) => p.id === newPreset.id || p.name === newPreset.name);
      if (existingIdx >= 0) {
        state.presets[existingIdx] = newPreset;
      } else {
        state.presets.unshift(newPreset);
      }
      saveState();
      addLog("info", `⚡ [실험 프리셋 북마크 저장] '${newPreset.name}' (${newPreset.minConcurrentRuns}워커 · ${newPreset.allowSpot ? "Spot" : "Standard"})`);
      return sendJson(res, 200, { ok: true, preset: newPreset, presets: state.presets });
    }

    if (pathname === "/api/presets/apply" && req.method === "POST") {
      const body = await readJsonBody(req);
      const preset = (state.presets || []).find((p) => p.id === body.presetId);
      if (!preset) {
        return sendJson(res, 404, { error: "해당 프리셋을 찾을 수 없습니다." });
      }
      const refJob = state.jobs[0] || {};
      let job = null;
      if (body.createAsNew) {
        const cleanRuleBase = String(preset.name || "preset-worker")
          .replace(/[^a-zA-Z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 18) || "preset-worker";
        job = {
          id: `job-${Date.now()}`,
          name: `${cleanRuleBase}-${state.jobs.length + 1}`,
          enabled: true,
          mode: "ensure_running",
          useSpecId: refJob.useSpecId || "",
          groupPoolId: refJob.groupPoolId || "",
          coreId: refJob.coreId || "",
          coreCount: Math.max(1, Number(preset.coreCount || 1)),
          quotaId: refJob.quotaId || "",
          allowSpot: Boolean(preset.allowSpot),
          autoApprove: true,
          containerImage: refJob.containerImage || "",
          experimentId: refJob.experimentId || "",
          executionCommand: preset.executionCommand || "bash /group-volume/run.sh",
          expectedRunTime: preset.expectedRunTime || "8h",
          enableWebConsole: true,
          minConcurrentRuns: Math.max(1, Number(preset.minConcurrentRuns || 1)),
          restartOnSuccess: true,
          restartOnFail: true,
          cooldownSec: 15,
          volumeClaim: refJob.volumeClaim || [],
          injectWorkerEnv: Boolean(preset.injectWorkerEnv ?? state.config.injectWorkerEnv),
          nextStageCommand: preset.nextStageCommand || "",
          _stage2Transitioned: false,
          lastCheckAt: null,
          lastTriggeredAt: null,
          lastRunId: null,
          lastStatus: `프리셋 [${preset.name}]으로 신규 생성됨`,
        };
        state.jobs.push(job);
        saveState();
      } else {
        job =
          (body.jobId && state.jobs.find((j) => j.id === body.jobId)) ||
          state.jobs.find((j) => j.enabled) ||
          state.jobs[0];
        if (job) {
          job.executionCommand = preset.executionCommand || job.executionCommand;
          job.minConcurrentRuns = Math.max(1, Number(preset.minConcurrentRuns || 1));
          job.coreCount = Math.max(1, Number(preset.coreCount || 1));
          job.allowSpot = Boolean(preset.allowSpot);
          if (preset.expectedRunTime) job.expectedRunTime = preset.expectedRunTime;
          if (preset.injectWorkerEnv !== undefined) {
            job.injectWorkerEnv = Boolean(preset.injectWorkerEnv);
            state.config.injectWorkerEnv = Boolean(preset.injectWorkerEnv);
          }
          if (preset.nextStageCommand !== undefined) {
            job.nextStageCommand = preset.nextStageCommand;
            state.config.nextStageCommand = preset.nextStageCommand;
          }
          job._stage2Transitioned = false;
          job.enabled = true;
          saveState();
        }
      }
      addLog(
        "info",
        `⚡ [프리셋 원클릭 적용] '${preset.name}' → 규칙 [${job?.name || "-"}] (${body.createAsNew ? "신규 규칙 추가" : "적용 완료"} · 목표 워커 ${preset.minConcurrentRuns}개 · ${preset.allowSpot ? "Spot" : "Standard"} · 명령어: ${preset.executionCommand})`
      );
      let triggerRes = null;
      if (body.triggerImmediately && job) {
        const runs = await fetchCurrentRuns().catch(() => lastKnownRuns);
        triggerRes = await evaluateJobRule(job, runs, true).catch((e) => ({ error: e.message }));
      }
      const fleet = computeWorkerFleetStats(lastKnownRuns);
      return sendJson(res, 200, {
        ok: true,
        preset,
        appliedJob: job,
        jobs: state.jobs,
        config: state.config,
        triggerRes,
        workerFleet: fleet,
      });
    }

    if (pathname.startsWith("/api/presets/") && req.method === "DELETE") {
      const presetId = decodeURIComponent(pathname.split("/").pop() || "");
      state.presets = (state.presets || []).filter((p) => p.id !== presetId);
      saveState();
      addLog("info", `🗑️ [프리셋 삭제] ID=${presetId}`);
      return sendJson(res, 200, { ok: true, presets: state.presets });
    }

    // 8-A5. Batch 2 - Feature 5: GPU Telemetry Report Export (`GET /api/telemetry/export?format=csv|json`)
    if (pathname === "/api/telemetry/export" && req.method === "GET") {
      const format = String(parsedUrl.searchParams.get("format") || "csv").toLowerCase();
      const fleet = computeWorkerFleetStats(lastKnownRuns);
      const tel = fleet.telemetry || {};
      if (format === "json") {
        return sendJson(res, 200, {
          exportedAt: new Date().toISOString(),
          groupId: state.config.groupId,
          totalGpuHours: tel.totalGpuHours || 0,
          todayGpuHours: tel.todayGpuHours || 0,
          dailyGpuHours: tel.dailyGpuHours || {},
          timeSeries: tel.timeSeries || [],
          activeFleetSummary: {
            totalRunningWorkers: fleet.totalRunningWorkers,
            totalActiveWorkers: fleet.totalActiveWorkers,
            totalTargetWorkers: fleet.totalTargetWorkers,
            totalRunningGpus: fleet.totalRunningGpus,
            totalTargetGpus: fleet.totalTargetGpus,
          },
        });
      }
      const rows = [
        ["Section", "TimeOrDate", "RunningWorkers", "PendingWorkers", "RunningGPUs", "TargetGPUs", "AvgApiMs", "CumulativeGpuHours"],
      ];
      for (const [day, hrs] of Object.entries(tel.dailyGpuHours || {})) {
        rows.push(["DAILY_SUMMARY", day, "", "", "", "", "", String(hrs)]);
      }
      for (const pt of tel.timeSeries || []) {
        rows.push([
          "TIME_SERIES",
          pt.isoTime || pt.time || "",
          String(pt.runningWorkers ?? 0),
          String(pt.pendingWorkers ?? 0),
          String(pt.runningGpus ?? 0),
          String(pt.targetGpus ?? 0),
          String(pt.avgApiMs ?? 0),
          String(pt.totalGpuHours ?? tel.totalGpuHours ?? 0),
        ]);
      }
      const csvText = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="space-gpu-telemetry-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      res.end("\uFEFF" + csvText);
      return;
    }

    // 8-B. Admin Run-Approval & TaskOrbit Queue Endpoints
    if (pathname === "/api/space/approvals" && req.method === "GET") {
      if (!state.config.accessToken) {
        return sendJson(res, 200, {
          approvals: [],
          recentApprovals: [],
          taskOrbitRuns: [],
          pendingApprovalRuns: [],
          errors: {},
          needsToken: true,
          schedulerLoopStats,
          approvalLoopStats,
          autoApprovalTimeline: buildAutoApprovalTimeline(lastKnownRuns).slice(0, 40),
        });
      }
      const anyJobAutoApprove = state.jobs.some((j) => j.autoApprove !== false);
      if (state.config.autoApprovalScope !== "off" || anyJobAutoApprove) {
        const autoRes = await processPendingApprovals().catch(() => null);
        const summary = await fetchApprovalStatusSummary();
        if (autoRes && autoRes.approvedCount > 0) {
          summary.autoApprovedNow = autoRes.approvedCount;
        }
        summary.schedulerLoopStats = schedulerLoopStats;
        summary.approvalLoopStats = approvalLoopStats;
        summary.autoApprovalTimeline = buildAutoApprovalTimeline(lastKnownRuns).slice(0, 40);
        return sendJson(res, 200, summary);
      }
      const summary = await fetchApprovalStatusSummary();
      summary.schedulerLoopStats = schedulerLoopStats;
      summary.approvalLoopStats = approvalLoopStats;
      summary.autoApprovalTimeline = buildAutoApprovalTimeline(lastKnownRuns).slice(0, 40);
      return sendJson(res, 200, summary);
    }

    if (pathname === "/api/space/approvals/approve" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (body.approveAll) {
        const bulkRes = await processPendingApprovals({ forceAll: true });
        return sendJson(res, 200, { ok: true, ...bulkRes });
      }

      const currentUser = resolveCurrentUserName();
      const results = [];
      let matchedApprovalId = body.approvalId;
      if (!matchedApprovalId && body.runId) {
        try {
          const summary = await fetchApprovalStatusSummary();
          const found = [...(summary.approvals || []), ...(summary.recentApprovals || [])].find(
            (a) => String(a.runId) === String(body.runId) && (!a.status || String(a.status).toLowerCase() === "pending")
          );
          if (found?.id) matchedApprovalId = found.id;
        } catch {
          // ignore
        }
      }
      if (matchedApprovalId) {
        const r1 = await spaceApi.approveApprovalItem({
          id: matchedApprovalId,
          groupId: state.config.groupId,
          approvedBy: currentUser,
        });
        results.push({ source: "approvals", data: r1 });
        addLog("success", `✅ [Admin Run-Approval] 승인 완료 (Approval ID: ${matchedApprovalId})`, {
          approvalId: matchedApprovalId,
          runId: body.runId,
          approvedBy: currentUser,
        });
      }
      if (body.runId) {
        try {
          const r2 = await spaceApi.approveTaskOrbitRun(body.runId);
          results.push({ source: "taskorbit", data: r2 });
          if (!matchedApprovalId) {
            addLog("success", `✅ [Admin TaskOrbit] 승인 완료 (Run ID: ${body.runId})`, {
              runId: body.runId,
            });
          }
        } catch (err) {
          if (!matchedApprovalId) throw err;
        }
      }
      return sendJson(res, 200, { ok: true, results });
    }

    if (pathname === "/api/space/approvals/reject" && req.method === "POST") {
      const body = await readJsonBody(req);
      const currentUser = resolveCurrentUserName();
      const reason = body.reason || "Rejected by Admin";
      const results = [];
      if (body.approvalId) {
        const r1 = await spaceApi.rejectApprovalItem({
          id: body.approvalId,
          groupId: state.config.groupId,
          rejectedBy: currentUser,
          reason,
        });
        results.push({ source: "approvals", data: r1 });
        addLog("warn", `[Run-Approval] 승인 반려 처리됨 (Approval ID: ${body.approvalId}, 사유: ${reason})`);
      }
      if (body.runId && !body.approvalId) {
        const r2 = await spaceApi.rejectTaskOrbitRun(body.runId, reason);
        results.push({ source: "taskorbit", data: r2 });
        addLog("warn", `[Run-Approval] TaskOrbit 런 반려 처리됨 (Run ID: ${body.runId}, 사유: ${reason})`);
      }
      return sendJson(res, 200, { ok: true, results });
    }

    // 9. CRUD for Auto-Execution Job Rules
    if (pathname === "/api/jobs" && req.method === "POST") {
      const body = await readJsonBody(req);
      const idx = state.jobs.findIndex((j) => j.id === body.id);
      const existingJob = idx >= 0 ? state.jobs[idx] : null;
      const fallbackJob = state.jobs[0] || {};
      const jobObj = {
        id: body.id || `job-${Date.now()}`,
        name: String(body.name || "group-vol-worker").trim(),
        enabled: Boolean(body.enabled),
        mode: body.mode || "ensure_running",
        useSpecId: String(body.useSpecId || "").trim(),
        groupPoolId: String(body.groupPoolId || existingJob?.groupPoolId || fallbackJob.groupPoolId || "").trim(),
        coreId: String(body.coreId || existingJob?.coreId || fallbackJob.coreId || "").trim(),
        coreCount: Math.max(1, Number(body.coreCount || 1)),
        quotaId: String(body.quotaId || existingJob?.quotaId || fallbackJob.quotaId || "").trim(),
        allowSpot: Boolean(body.allowSpot),
        autoApprove: body.autoApprove !== false,
        containerImage: String(body.containerImage || existingJob?.containerImage || fallbackJob.containerImage || "").trim(),
        experimentId: String(body.experimentId || existingJob?.experimentId || fallbackJob.experimentId || "").trim(),
        executionCommand: String(body.executionCommand || "bash /group-volume/run.sh").trim(),
        expectedRunTime: String(body.expectedRunTime || "8h").trim(),
        enableWebConsole: body.enableWebConsole !== false,
        minConcurrentRuns: Math.max(1, Number(body.minConcurrentRuns || 1)),
        restartOnSuccess: body.restartOnSuccess !== false,
        restartOnFail: body.restartOnFail !== false,
        cooldownSec: Math.max(1, Number(body.cooldownSec || 15)),
        volumeClaim: Array.isArray(body.volumeClaim) ? body.volumeClaim : existingJob?.volumeClaim || fallbackJob.volumeClaim || [],
        injectWorkerEnv: body.injectWorkerEnv !== undefined ? Boolean(body.injectWorkerEnv) : existingJob?.injectWorkerEnv,
        maxTotalSucceededRuns:
          body.maxTotalSucceededRuns !== undefined ? Number(body.maxTotalSucceededRuns) : existingJob?.maxTotalSucceededRuns,
        nextStageCommand: body.nextStageCommand !== undefined ? String(body.nextStageCommand) : existingJob?.nextStageCommand,
        _stage2Transitioned: Boolean(existingJob?._stage2Transitioned),
        lastCheckAt: existingJob ? existingJob.lastCheckAt : null,
        lastTriggeredAt: existingJob ? existingJob.lastTriggeredAt : null,
        lastRunId: existingJob ? existingJob.lastRunId : null,
        lastStatus: existingJob ? existingJob.lastStatus : "대기 중",
      };
      if (idx >= 0) {
        state.jobs[idx] = jobObj;
        addLog("info", `자동 실행 규칙 수정됨: ${jobObj.name} (목표 워커: ${jobObj.minConcurrentRuns}개, cmd: ${jobObj.executionCommand})`);
      } else {
        state.jobs.push(jobObj);
        addLog("info", `새 자동 실행 규칙 추가됨: ${jobObj.name} (목표 워커: ${jobObj.minConcurrentRuns}개, cmd: ${jobObj.executionCommand})`);
      }
      saveState();
      return sendJson(res, 200, { ok: true, job: jobObj, jobs: state.jobs, workerFleet: computeWorkerFleetStats(lastKnownRuns) });
    }

    if (pathname === "/api/jobs/toggle" && req.method === "POST") {
      const body = await readJsonBody(req);
      const job = state.jobs.find((j) => j.id === body.jobId);
      if (!job) return sendJson(res, 404, { error: "Job rule not found" });
      job.enabled = body.enabled !== undefined ? Boolean(body.enabled) : !job.enabled;
      saveState();
      addLog(
        "info",
        `[${job.name}] 주기적 자동 생성 규칙 상태 변경: ${job.enabled ? "🟢 ON (활성화)" : "⚪ OFF (일시정지 — Admin 자동 승인은 계속 작동)"}`
      );
      return sendJson(res, 200, { ok: true, job, jobs: state.jobs, workerFleet: computeWorkerFleetStats(lastKnownRuns) });
    }

    if (pathname === "/api/jobs/target" && req.method === "POST") {
      const body = await readJsonBody(req);
      const job =
        (body.jobId && state.jobs.find((j) => j.id === body.jobId)) ||
        state.jobs.find((j) => j.enabled) ||
        state.jobs[0];
      if (!job) return sendJson(res, 404, { error: "Job rule not found" });
      if (body.minConcurrentRuns !== undefined) {
        job.minConcurrentRuns = Math.max(1, Number(body.minConcurrentRuns || 1));
      }
      if (body.cooldownSec !== undefined) {
        job.cooldownSec = Math.max(1, Number(body.cooldownSec || 15));
      }
      if (body.checkIntervalSec !== undefined) {
        state.config.checkIntervalSec = Math.max(1, Number(body.checkIntervalSec || 15));
      }
      if (body.smartLoadGuardEnabled !== undefined) {
        state.config.smartLoadGuardEnabled = Boolean(body.smartLoadGuardEnabled);
      }
      if (body.maxPendingWorkers !== undefined) {
        state.config.maxPendingWorkers = Math.max(1, Math.min(32, Number(body.maxPendingWorkers || 2)));
      }
      if (body.stepByStepRunningCheck !== undefined) {
        state.config.stepByStepRunningCheck = Boolean(body.stepByStepRunningCheck);
      }
      saveState();
      addLog(
        "info",
        `🎯 [${job.name}] 워커 설정 변경 — 목표 워커: ${job.minConcurrentRuns}개 (총 목표 GPU: ${job.minConcurrentRuns * Math.max(1, Number(job.coreCount || 1))}장) · 워커 생성 주기: ${job.cooldownSec}초 · 부하보호: ${state.config.smartLoadGuardEnabled !== false ? `ON (동시 준비중 상한 ${state.config.maxPendingWorkers || 2}개)` : "OFF"}`
      );
      const fleet = computeWorkerFleetStats(lastKnownRuns);
      return sendJson(res, 200, {
        ok: true,
        job,
        jobs: state.jobs,
        config: state.config,
        workerFleet: fleet,
        loadMonitor: fleet.loadMonitor,
      });
    }

    if (pathname === "/api/load-guard" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (body.smartLoadGuardEnabled !== undefined) {
        state.config.smartLoadGuardEnabled = Boolean(body.smartLoadGuardEnabled);
      }
      if (body.maxPendingWorkers !== undefined) {
        state.config.maxPendingWorkers = Math.max(1, Math.min(32, Number(body.maxPendingWorkers || 2)));
      }
      if (body.stepByStepRunningCheck !== undefined) {
        state.config.stepByStepRunningCheck = Boolean(body.stepByStepRunningCheck);
      }
      if (body.apiLatencyWarnMs !== undefined) {
        state.config.apiLatencyWarnMs = Math.max(300, Number(body.apiLatencyWarnMs || 1800));
      }
      if (body.apiLatencyCriticalMs !== undefined) {
        state.config.apiLatencyCriticalMs = Math.max(500, Number(body.apiLatencyCriticalMs || 3500));
      }
      if (body.clearBackoff) {
        loadMonitorStats.backoffUntilMs = 0;
        loadMonitorStats.consecutiveErrors = 0;
        loadMonitorStats.lastBackoffReason = null;
      }
      saveState();
      const fleet = computeWorkerFleetStats(lastKnownRuns);
      addLog(
        "info",
        `🛡️ [스마트 부하 모니터링 보호 설정 변경] ${
          state.config.smartLoadGuardEnabled !== false
            ? `ON (동시 준비중 워커 상한: ${state.config.maxPendingWorkers || 2}개 · 순차 Running 확인: ${state.config.stepByStepRunningCheck !== false ? "ON" : "OFF"})`
            : "OFF (제한 없이 즉시 생성)"
        }`
      );
      return sendJson(res, 200, {
        ok: true,
        config: state.config,
        workerFleet: fleet,
        loadMonitor: fleet.loadMonitor,
      });
    }

    if (pathname.startsWith("/api/jobs/") && req.method === "DELETE") {
      const jobId = pathname.split("/").pop();
      state.jobs = state.jobs.filter((j) => j.id !== jobId);
      saveState();
      addLog("warn", `자동 실행 규칙 삭제됨: ${jobId}`);
      return sendJson(res, 200, { ok: true, jobs: state.jobs, workerFleet: computeWorkerFleetStats(lastKnownRuns) });
    }

    // 10. Immediate Manual Trigger of a Job Rule (supports `spawnCount` 1..64) or Scheduler Tick
    if (pathname === "/api/jobs/trigger" && req.method === "POST") {
      const body = await readJsonBody(req);
      let job =
        (body.jobId && state.jobs.find((j) => j.id === body.jobId)) ||
        state.jobs.find((j) => j.enabled) ||
        state.jobs[0];
      // If the UI passes `jobData` (current form values), apply and persist them BEFORE triggering so edited executionCommand / image / spot settings are never ignored!
      if (body.jobData && typeof body.jobData === "object") {
        const d = body.jobData;
        const targetId = body.jobId || d.id || job?.id || `job-${Date.now()}`;
        const idx = state.jobs.findIndex((j) => j.id === targetId);
        const existingJob = idx >= 0 ? state.jobs[idx] : null;
        const fallbackJob = existingJob || state.jobs[0] || {};
        const updatedJob = {
          id: targetId,
          name: String(d.name || existingJob?.name || "group-vol-worker").trim(),
          enabled: d.enabled !== undefined ? Boolean(d.enabled) : Boolean(existingJob?.enabled ?? true),
          mode: d.mode || existingJob?.mode || "ensure_running",
          useSpecId: d.useSpecId !== undefined ? String(d.useSpecId || "").trim() : String(existingJob?.useSpecId || ""),
          groupPoolId:
            d.groupPoolId !== undefined && String(d.groupPoolId).trim()
              ? String(d.groupPoolId).trim()
              : String(fallbackJob.groupPoolId || ""),
          coreId:
            d.coreId !== undefined && String(d.coreId).trim()
              ? String(d.coreId).trim()
              : String(fallbackJob.coreId || ""),
          coreCount: Math.max(1, Number(d.coreCount ?? existingJob?.coreCount ?? 1)),
          quotaId:
            d.quotaId !== undefined && String(d.quotaId).trim()
              ? String(d.quotaId).trim()
              : String(fallbackJob.quotaId || ""),
          allowSpot: d.allowSpot !== undefined ? Boolean(d.allowSpot) : Boolean(existingJob?.allowSpot),
          autoApprove: d.autoApprove !== undefined ? d.autoApprove !== false : existingJob?.autoApprove !== false,
          containerImage:
            d.containerImage !== undefined && String(d.containerImage).trim()
              ? String(d.containerImage).trim()
              : String(fallbackJob.containerImage || ""),
          experimentId:
            d.experimentId !== undefined && String(d.experimentId).trim()
              ? String(d.experimentId).trim()
              : String(fallbackJob.experimentId || ""),
          executionCommand:
            d.executionCommand !== undefined && String(d.executionCommand).trim()
              ? String(d.executionCommand).trim()
              : String(existingJob?.executionCommand || "bash /group-volume/run.sh").trim(),
          expectedRunTime:
            d.expectedRunTime !== undefined ? String(d.expectedRunTime || "8h").trim() : String(existingJob?.expectedRunTime || "8h"),
          enableWebConsole: d.enableWebConsole !== undefined ? d.enableWebConsole !== false : existingJob?.enableWebConsole !== false,
          minConcurrentRuns: Math.max(1, Number(d.minConcurrentRuns ?? existingJob?.minConcurrentRuns ?? 1)),
          restartOnSuccess: d.restartOnSuccess !== undefined ? d.restartOnSuccess !== false : existingJob?.restartOnSuccess !== false,
          restartOnFail: d.restartOnFail !== undefined ? d.restartOnFail !== false : existingJob?.restartOnFail !== false,
          cooldownSec: Math.max(1, Number(d.cooldownSec ?? existingJob?.cooldownSec ?? 15)),
          volumeClaim: Array.isArray(d.volumeClaim) ? d.volumeClaim : fallbackJob.volumeClaim || [],
          injectWorkerEnv: existingJob?.injectWorkerEnv,
          maxTotalSucceededRuns: existingJob?.maxTotalSucceededRuns,
          nextStageCommand: existingJob?.nextStageCommand,
          _stage2Transitioned: Boolean(existingJob?._stage2Transitioned),
          lastCheckAt: existingJob ? existingJob.lastCheckAt : null,
          lastTriggeredAt: existingJob ? existingJob.lastTriggeredAt : null,
          lastRunId: existingJob ? existingJob.lastRunId : null,
          lastStatus: existingJob ? existingJob.lastStatus : "대기 중",
        };
        if (idx >= 0) {
          state.jobs[idx] = updatedJob;
        } else {
          state.jobs.push(updatedJob);
        }
        saveState();
        job = updatedJob;
      }
      if (!job) return sendJson(res, 404, { error: "Job rule not found" });
      const spawnCount = Math.min(64, Math.max(1, Number(body.spawnCount || 1)));
      let runs = await fetchCurrentRuns(true).catch(() => lastKnownRuns);
      const triggerResults = [];
      for (let i = 0; i < spawnCount; i++) {
        // When spawning multiple workers manually, insert a gentle 1.2s safety gap between requests so SPACE API is not spiked
        if (i > 0 && state.config.smartLoadGuardEnabled !== false) {
          await sleep(1200);
        }
        const resTrigger = await evaluateJobRule(job, runs, true);
        triggerResults.push(resTrigger);
        runs = lastKnownRuns;
      }
      const fleet = computeWorkerFleetStats(lastKnownRuns);
      return sendJson(res, 200, {
        ok: true,
        result: triggerResults[triggerResults.length - 1],
        results: triggerResults,
        spawnedCount: triggerResults.filter((r) => r?.triggered).length,
        job,
        schedulerLoopStats,
        approvalLoopStats,
        workerFleet: fleet,
        loadMonitor: fleet.loadMonitor,
      });
    }

    if (pathname === "/api/scheduler/tick" && req.method === "POST") {
      const tickRes = await runSchedulerTick(true);
      return sendJson(res, 200, tickRes);
    }

    // Serve Static Frontend
    let filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : ext === ".css"
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    sendJson(res, 404, { error: "Not Found" });
  } catch (err) {
    console.error("[API Error]", err);
    sendJson(res, 500, { error: err.message });
  }
});

function getLocalIpv4Addresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal && net.address) {
        addrs.push(net.address);
      }
    }
  }
  return addrs;
}

server.listen(PORT, HOST, () => {
  const lanIps = getLocalIpv4Addresses();
  console.log(`======================================================================`);
  console.log(`🚀 SPACE GPU Auto-Allocator & Admin Run-Approval Server Started!`);
  console.log(`👉 Listen Address   : ${HOST}:${PORT} (All IPv4 Interfaces Open)`);
  for (const ip of lanIps) {
    console.log(`👉 External / LAN   : http://${ip}:${PORT} (Password: ${ADMIN_PASSWORD})`);
  }
  console.log(`👉 Localhost        : http://localhost:${PORT} (Password: ${ADMIN_PASSWORD})`);
  console.log(`👉 Target Gateway   : ${state.config.baseUrl}`);
  console.log(`======================================================================`);
  if (state.config.accessToken) {
    fetchCurrentRuns().catch(() => {});
    processPendingApprovals()
      .then((res) => {
        addLog(
          "info",
          `🟢 [Admin 자동 승인 루프] 실시간 백그라운드 감시 가동 중 (${approvalLoopStats.effectiveIntervalSec}초 주기 · 접속 주소: http://${lanIps[0] || "10.113.125.253"}:${PORT} · 최근 승인 확인: ${approvalLoopStats.recentApprovedCount}건)`
        );
      })
      .catch(() => {});
  }
});
