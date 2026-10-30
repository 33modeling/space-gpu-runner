#!/usr/bin/env node
/**
 * SPACE (space.n9.sr-cloud.com) Periodic GPU Allocator & Group-Volume Script Runner
 * With Admin Run-Approval Auto-Approver, Configurable Polling Intervals & Password Gate ("cycy")
 */

import http from "node:http";
import fs from "node:fs";
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
    approvalCheckIntervalSec: 5, // Admin Run-Approval polling interval (1s ~ 3600s)
    uiRefreshIntervalSec: 5, // Frontend UI auto-refresh interval (1s ~ 600s)
    postCreateApproveRetries: 8, // Fast approval retries right after creating a run
    postCreateApproveDelaySec: 2, // Seconds between fast approval retries
    // Run-Approval policy: "all_group" | "my_runs" | "job_only" | "off"
    autoApprovalScope: "all_group",
  },
  jobs: [
    {
      id: "job-default-1",
      name: "group-vol-worker",
      enabled: false,
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
  history: [],
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      return {
        config: { ...DEFAULT_STATE.config, ...(raw.config || {}) },
        jobs: Array.isArray(raw.jobs)
          ? raw.jobs.map((j) => ({ autoApprove: true, ...j }))
          : DEFAULT_STATE.jobs,
        history: Array.isArray(raw.history) ? raw.history.slice(0, 200) : [],
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
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  console.log(`[${entry.time}] [${level.toUpperCase()}] ${message}`, Object.keys(meta).length ? JSON.stringify(meta) : "");
  state.history.unshift(entry);
  if (state.history.length > 200) {
    state.history.length = 200;
  }
  saveState();
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

function resolveCurrentUserName() {
  if (state.config.userName) return state.config.userName;
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
  } = options;

  const jwt = decodeJwtPayload(state.config.accessToken);
  if (jwt?.exp && jwt.exp * 1000 - Date.now() < 60_000 && state.config.refreshToken && !isRetry) {
    await refreshAccessToken();
  }

  let url = endpoint.startsWith("http") ? endpoint : `${baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
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
  };

  const cleanToken = (state.config.accessToken || "").replace(/^Bearer\s+/i, "").trim();
  if (cleanToken) {
    headers["Authorization"] = `Bearer ${cleanToken}`;
  }
  if (!noGroupHeader && state.config.groupId) {
    headers["X-Request-Group-Id"] = String(state.config.groupId);
  }
  if (overrideMethod) {
    headers["X-HTTP-Method-Override"] = overrideMethod;
  }
  const userHeader = state.config.userName || jwt?.sub || jwt?.user_id || jwt?.username || jwt?.preferred_username;
  if (userHeader) {
    headers["x-request-user-id"] = String(userHeader);
  }

  const fetchOptions = {
    method: overrideMethod ? "POST" : method.toUpperCase(),
    headers,
  };

  if (body !== undefined && fetchOptions.method !== "GET") {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetch(url, fetchOptions);

  if (res.status === 401 && state.config.refreshToken && !isRetry && !endpoint.includes("/api/acm/token")) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return spaceRequest(endpoint, options, true);
    }
  }

  if (rawResponse) {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return text;
  }

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const errMsg = typeof data === "object" && data !== null ? data.message || data.detail || data.error || JSON.stringify(data) : String(data);
    throw new Error(`SPACE API Error [${res.status}] ${endpoint}: ${errMsg}`);
  }

  return data;
}

async function refreshAccessToken() {
  if (!state.config.refreshToken) return false;
  try {
    const url = `${state.config.baseUrl.replace(/\/$/, "")}/api/acm/token`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: state.config.refreshToken.trim(),
        client_id: "mlp-front",
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      addLog("error", `Access Token 자동 갱신 실패 (HTTP ${res.status})`, { error: errText.slice(0, 200) });
      return false;
    }
    const data = await res.json();
    const newAccess = data?.access_token || data?.data?.access_token;
    const newRefresh = data?.refresh_token || data?.data?.refresh_token;
    if (newAccess) {
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

  // CIM Images
  getImagesV2: () => spaceRequest("/api/cim/v2/images"),

  // SFM / Data Viewer Group Volume (`FileSystemPage-uC1HoUVG.js` & `useSfmApi-Br5758Bb.js`)
  listSfmFiles: async (dirPath) => {
    const cleanPath = dirPath || "/";
    // 1. Try Data Viewer File System API (`console-viewer.n9.sr-cloud.com/api/files/ls?path=...&connection_overwrite=onedatafs`)
    try {
      const viewerUrl = state.config.baseUrl.includes("mlp.n9.sr-cloud.com")
        ? "https://console-viewer.n9.sr-cloud.com"
        : state.config.sfmUrl;
      return await spaceRequest("/api/files/ls", {
        baseUrl: viewerUrl,
        params: { path: cleanPath, connection_overwrite: "onedatafs" },
      });
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

  // WLM Runs
  getRunsPaginated: (params = { page: 1, size: 50 }) =>
    spaceRequest("/api/wlm/v2/runs/list", { params }),
  getRunsList: (params = {}) => spaceRequest("/api/wlm/v2/runs", { params }),
  getRunDetail: (runId) =>
    spaceRequest(`/api/wlm/v2/runs/${runId}`, {
      params: { deleted: true },
    }),
  getRunLog: (runId, params = { tailLines: 300 }) =>
    spaceRequest(`/api/wlm/v2/runs/${runId}/log`, {
      params,
      rawResponse: true,
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
        status: "PENDING,APPROVED,ADMITTED",
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

async function fetchCurrentRuns() {
  try {
    const res = await spaceApi.getRunsPaginated({ page: 1, size: 100 });
    const arr = extractItemsArray(res);
    if (arr.length > 0) return arr;
  } catch {
    // Fallback
  }
  const res2 = await spaceApi.getRunsList();
  return extractItemsArray(res2);
}

/**
 * Fetch both `/taskorbit/api/v1/approvals` (pending items on `/run-approval` page)
 * and `/taskorbit/api/v1/runs` (TaskOrbit queue)
 */
async function fetchApprovalStatusSummary() {
  const summary = {
    approvals: [],
    taskOrbitRuns: [],
    pendingApprovalRuns: [],
    errors: {},
  };

  await Promise.all([
    (async () => {
      try {
        const res = await spaceApi.getApprovalsList({ status: "pending", page: 1, limit: 100 });
        summary.approvals = extractItemsArray(res);
      } catch (e) {
        summary.errors.approvals = e.message;
      }
    })(),
    (async () => {
      try {
        const res = await spaceApi.getTaskOrbitRuns();
        const list = extractItemsArray(res);
        summary.taskOrbitRuns = list.map((r) => ({
          ...r,
          stage:
            r.status === "PENDING"
              ? "approval"
              : r.status === "APPROVED"
              ? "limit"
              : r.status === "ADMITTED"
              ? "queue"
              : "scheduled",
        }));
        summary.pendingApprovalRuns = summary.taskOrbitRuns.filter((r) => r.status === "PENDING");
      } catch (e) {
        summary.errors.taskOrbit = e.message;
      }
    })(),
  ]);

  return summary;
}

/**
 * Admin Auto-Approval Engine:
 * Approves pending items via `/taskorbit/api/v1/approvals/{id}/approve` AND `/taskorbit/api/v1/runs/{runId}/approve`
 */
let isApprovalRunning = false;

async function processPendingApprovals(options = {}) {
  const { targetRunId = null, targetRunName = null, forceAll = false } = options;
  if (isApprovalRunning && !forceAll && !targetRunId && !targetRunName) {
    return { approvedCount: 0, items: [], skipped: true };
  }

  const scope = state.config.autoApprovalScope || "all_group";
  if (!forceAll && scope === "off" && !targetRunId && !targetRunName) {
    return { approvedCount: 0, items: [], skipped: true };
  }

  isApprovalRunning = true;
  try {
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

    const summary = await fetchApprovalStatusSummary();
    const approvedItems = [];
    const handledRunIds = new Set();

    const shouldApproveItem = (item) => {
      if (forceAll || scope === "all_group") return true;
      const rId = String(item.runId || item.id || "");
      const rName = String(item.runName || item.name || item.containerName || "");
      const itemUser = String(item.userId || item.userName || "");

      if (targetRunId && rId === String(targetRunId)) return true;
      if (targetRunName && (rName === String(targetRunName) || rId.includes(String(targetRunName)))) return true;
      if (trackedRunIds.has(rId)) return true;
      if (jobPrefixes.some((pref) => pref && (rName.startsWith(pref) || rId.startsWith(pref)))) return true;

      if (scope === "my_runs" && currentUser && itemUser && itemUser.toLowerCase() === currentUser.toLowerCase()) {
        return true;
      }
      return false;
    };

    // 1. Approve in `/taskorbit/api/v1/approvals` (primary `/run-approval` table used by Admin)
    for (const item of summary.approvals) {
      if (item.status && String(item.status).toLowerCase() !== "pending") continue;
      if (!shouldApproveItem(item)) continue;

      try {
        await spaceApi.approveApprovalItem({
          id: item.id,
          groupId: item.groupId || state.config.groupId,
          approvedBy: currentUser,
        });
        if (item.runId) handledRunIds.add(String(item.runId));
        approvedItems.push({ source: "approvals", id: item.id, runId: item.runId, runName: item.runName || item.name });
        addLog("success", `✅ [Admin Run-Approval] 자동 승인 완료: ${item.runName || item.runId} (Approval ID: ${item.id})`, {
          approvalId: item.id,
          runId: item.runId,
          approvedBy: currentUser,
        });
      } catch (err) {
        addLog("warn", `[Run-Approval] /approvals/${item.id}/approve 실패: ${err.message}`, {
          approvalId: item.id,
          runId: item.runId,
        });
      }
    }

    // 2. Also approve any remaining `PENDING` runs in `/taskorbit/api/v1/runs`
    for (const run of summary.pendingApprovalRuns) {
      const rId = String(run.runId || run.id || "");
      if (!rId || handledRunIds.has(rId)) continue;
      if (!shouldApproveItem(run)) continue;

      try {
        await spaceApi.approveTaskOrbitRun(rId);
        handledRunIds.add(rId);
        approvedItems.push({ source: "taskorbit-runs", runId: rId, runName: run.runName || run.name });
        addLog("success", `✅ [Admin TaskOrbit] 직접 승인 완료: ${run.runName || rId}`, {
          runId: rId,
        });
      } catch (err) {
        // Ignore if already approved via /approvals
      }
    }

    return {
      approvedCount: approvedItems.length,
      items: approvedItems,
      pendingApprovalsTotal: summary.approvals.length,
      pendingTaskOrbitTotal: summary.pendingApprovalRuns.length,
    };
  } finally {
    isApprovalRunning = false;
  }
}

/**
 * Fast Post-Create Approval Tracker:
 * After `POST /api/wlm/v2/runs`, polls `/taskorbit/api/v1/approvals` every `delaySec` up to `retries` times
 * so as soon as the run enters `pending` in `/run-approval`, Admin approves it immediately and GPU gets allocated!
 */
async function trackAndApproveCreatedRun({ runId, containerName }) {
  const retries = Math.max(1, Number(state.config.postCreateApproveRetries ?? 8));
  const delayMs = Math.max(500, Number(state.config.postCreateApproveDelaySec ?? 2) * 1000);

  for (let attempt = 1; attempt <= retries; attempt++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await processPendingApprovals({
        targetRunId: runId,
        targetRunName: containerName,
      });
      if (res.approvedCount > 0) {
        return { approved: true, attempt, ...res };
      }
    } catch {
      // continue polling
    }
  }
  return { approved: false, retries };
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
  if (["FAILED", "ERROR", "STOPPED", "KILLED", "TERMINATED", "CANCELED", "CANCELLED", "ABORTED", "OOM", "REJECTED"].some((k) => s.includes(k))) {
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

async function ensureGroupIdConfigured() {
  if (state.config.groupId) return state.config.groupId;
  try {
    const gRes = await spaceApi.getGroups();
    const groups = extractItemsArray(gRes);
    if (groups.length > 0) {
      const firstId = groups[0].id ?? groups[0].groupId;
      if (firstId !== undefined && firstId !== null) {
        state.config.groupId = String(firstId);
        saveState();
        addLog("info", `Group ID가 비어 있어 내 첫 번째 그룹(${groups[0].name || firstId})으로 자동 설정되었습니다.`);
      }
    }
  } catch {
    // ignore
  }
  return state.config.groupId;
}

async function buildRunPayload(job) {
  await ensureGroupIdConfigured();

  let specData = null;
  if (job.useSpecId) {
    specData = await spaceApi.getSpecificationDetail(job.useSpecId);
    if (specData?.data) specData = specData.data;
  }

  const allowSpot = specData ? Boolean(specData.isSpot || specData.allowSpot) : Boolean(job.allowSpot);
  let groupPoolId = Number(job.groupPoolId || specData?.groupPoolId || specData?.poolId || 0);
  let coreId = Number(job.coreId || specData?.coreId || 0);
  const coreCount = Number(job.coreCount || specData?.coreNum || specData?.coreCount || 1);
  const quotaIdRaw = job.quotaId || specData?.quotaId;
  let quotaId = quotaIdRaw !== undefined && quotaIdRaw !== "" && quotaIdRaw !== null ? Number(quotaIdRaw) : undefined;
  let containerImage = String(job.containerImage || specData?.image || specData?.containerImage || "").trim();
  const executionCommand = String(job.executionCommand || specData?.execCommand || "").trim();

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
      const imgRes = await spaceApi.getImagesV2();
      const imgs = extractItemsArray(imgRes);
      if (imgs.length > 0) {
        const firstUrl = imgs[0].imageUrl || imgs[0].url || imgs[0].fullPath || imgs[0].name || "";
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
  if (!executionCommand) throw new Error("실행할 스크립트 명령어(executionCommand)가 비어 있습니다.");

  const suffix = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(2, 14);
  const cleanPrefix = String(job.name || "gpu-job")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const containerName = `${cleanPrefix}-${suffix}`;

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
      return {
        available: false,
        free,
        total,
        reason: `유휴 GPU 부족 (가용: ${free} / 필요: ${requiredCount}, 전체: ${total})`,
      };
    }
    return { available: true, free, total, reason: `가용 GPU 확인됨 (가용: ${free} / 전체: ${total})` };
  } catch (e) {
    return { available: true, reason: `GPU 상태 조회 생략 (${e.message})` };
  }
}

let isTickRunning = false;

async function evaluateJobRule(job, allRuns, forceTrigger = false) {
  const now = Date.now();
  job.lastCheckAt = new Date(now).toISOString();

  const prefix = String(job.name || "gpu-job")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  const matchingRuns = allRuns.filter((r) => {
    const rName = String(r.containerName || r.name || "");
    const rId = String(r.id || r.runId || "");
    return rName.startsWith(prefix) || (job.lastRunId && rId === String(job.lastRunId));
  });

  const activeRuns = matchingRuns.filter((r) => classifyRunStatus(r.status || r.state || r.phase) === "ACTIVE");
  const latestRun = matchingRuns[0] || null;
  const latestStatusClass = latestRun ? classifyRunStatus(latestRun.status || latestRun.state || latestRun.phase) : "NONE";

  // If any active run is waiting for approval (PENDING), immediately approve it as Admin!
  if (job.autoApprove !== false) {
    const pendingRuns = activeRuns.filter((r) => String(r.status || r.state || "").toUpperCase().includes("PENDING"));
    for (const pr of pendingRuns) {
      await processPendingApprovals({
        targetRunId: pr.id || pr.runId,
        targetRunName: pr.containerName || pr.name,
      }).catch(() => {});
    }
  }

  const minConcurrent = Math.max(1, Number(job.minConcurrentRuns || 1));

  if (!forceTrigger) {
    if (activeRuns.length >= minConcurrent) {
      const activeIds = activeRuns.map((r) => `${r.containerName || r.name}(#${r.id || r.runId}: ${r.status || r.state})`).join(", ");
      job.lastStatus = `실행/대기 중 (${activeRuns.length}/${minConcurrent}): ${activeIds}`;
      saveState();
      return { triggered: false, reason: job.lastStatus };
    }

    const cooldownMs = Math.max(1, Number(job.cooldownSec || 15)) * 1000;
    if (job.lastTriggeredAt && now - new Date(job.lastTriggeredAt).getTime() < cooldownMs) {
      job.lastStatus = `쿨다운 대기 중 (최근 실행: ${job.lastTriggeredAt})`;
      saveState();
      return { triggered: false, reason: job.lastStatus };
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

    if (job.mode === "when_gpu_free" && !job.allowSpot && job.groupPoolId && job.coreId) {
      const gpuCheck = await checkPoolGpuAvailable(job.groupPoolId, job.coreId, Number(job.coreCount || 1));
      if (!gpuCheck.available) {
        job.lastStatus = `GPU 대기 중: ${gpuCheck.reason}`;
        saveState();
        return { triggered: false, reason: job.lastStatus };
      }
    }
  }

  const payload = await buildRunPayload(job);
  addLog("info", `[${job.name}] GPU 할당 및 스크립트 실행 요청 전송`, {
    containerName: payload.containerName,
    groupPoolId: payload.groupPoolId,
    coreId: payload.coreId,
    coreCount: payload.coreCount,
    executionCommand: payload.executionCommand,
  });

  const createRes = await spaceApi.createRun(payload);
  const createdId = createRes?.id || createRes?.runId || createRes?.data?.id || createRes?.data?.runId || null;

  job.lastTriggeredAt = new Date().toISOString();
  if (createdId) job.lastRunId = createdId;
  job.lastStatus = `제출 완료 (${payload.containerName}) → Admin 승인 추적 중...`;
  saveState();

  addLog("success", `[${job.name}] 워크로드 생성됨: ${payload.containerName} (Admin 자동 승인 추적 시작)`, {
    runId: createdId,
    command: payload.executionCommand,
  });

  // Fast Admin Auto-Approval Tracker right after creation
  let approvalResult = null;
  if (job.autoApprove !== false && !payload.allowSpot) {
    approvalResult = await trackAndApproveCreatedRun({
      runId: createdId,
      containerName: payload.containerName,
    });
    if (approvalResult?.approved) {
      job.lastStatus = `제출 및 Admin 자동 승인 완료 (${payload.containerName}, ${approvalResult.attempt}회차 승인됨 → GPU 할당 진입)`;
    } else {
      job.lastStatus = `제출 완료 (${payload.containerName}) — 주기적 승인 감시 중`;
    }
    saveState();
  }

  return { triggered: true, payload, response: createRes, approvalResult };
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
  const results = [];
  let approvalTickResult = null;
  try {
    if (state.config.autoApprovalScope !== "off") {
      approvalTickResult = await processPendingApprovals().catch((e) => ({ error: e.message }));
    }

    const enabledJobs = state.jobs.filter((j) => j.enabled);
    if (manual || enabledJobs.length > 0) {
      const allRuns = await fetchCurrentRuns();
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
    }
  } catch (err) {
    addLog("error", `스케줄러 런 목록 조회 실패: ${err.message}`);
    return { error: err.message };
  } finally {
    isTickRunning = false;
  }
  return { ok: true, checkedAt: new Date().toISOString(), approvalTickResult, results };
}

/**
 * Two Independent Configurable Loops (1-second resolution):
 * 1) Workload / GPU Allocation Check Loop (`checkIntervalSec`, min 1s)
 * 2) Dedicated Admin Run-Approval Auto-Approver Loop (`approvalCheckIntervalSec`, min 1s)
 */
let lastSchedulerTickTime = 0;
let lastApprovalTickTime = 0;

setInterval(async () => {
  if (!state.config.schedulerEnabled) return;
  if (!state.config.accessToken) return;
  if (!state.config.groupId) {
    await ensureGroupIdConfigured();
    if (!state.config.groupId) return;
  }

  const now = Date.now();

  // 1. Dedicated fast Admin Run-Approval polling loop
  if (state.config.autoApprovalScope !== "off") {
    const approvalIntervalMs = Math.max(1, Number(state.config.approvalCheckIntervalSec || 5)) * 1000;
    if (now - lastApprovalTickTime >= approvalIntervalMs) {
      lastApprovalTickTime = now;
      processPendingApprovals().catch(() => {});
    }
  }

  // 2. Workload / GPU allocation scheduler loop
  const schedIntervalMs = Math.max(1, Number(state.config.checkIntervalSec || 15)) * 1000;
  if (now - lastSchedulerTickTime >= schedIntervalMs) {
    lastSchedulerTickTime = now;
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
      const jwt = decodeJwtPayload(state.config.accessToken);
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
        history: state.history.slice(0, 100),
      });
    }

    // 2. Update config (including all intervals!)
    if (pathname === "/api/config" && req.method === "POST") {
      const body = await readJsonBody(req);
      state.config = {
        ...state.config,
        ...(body.baseUrl !== undefined ? { baseUrl: String(body.baseUrl).trim() } : {}),
        ...(body.sfmUrl !== undefined ? { sfmUrl: String(body.sfmUrl).trim() } : {}),
        ...(body.accessToken !== undefined ? { accessToken: String(body.accessToken).replace(/^Bearer\s+/i, "").trim() } : {}),
        ...(body.refreshToken !== undefined ? { refreshToken: String(body.refreshToken).trim() } : {}),
        ...(body.groupId !== undefined ? { groupId: String(body.groupId).trim() } : {}),
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
      };
      saveState();
      addLog("info", "서버 및 조회/승인 주기 설정이 업데이트되었습니다.", {
        groupId: state.config.groupId,
        checkIntervalSec: state.config.checkIntervalSec,
        approvalCheckIntervalSec: state.config.approvalCheckIntervalSec,
        uiRefreshIntervalSec: state.config.uiRefreshIntervalSec,
        autoApprovalScope: state.config.autoApprovalScope,
      });
      return sendJson(res, 200, { ok: true, config: state.config });
    }

    // 3. Discover SPACE Metadata (Auto-selects Group ID, Group Pool ID, Core ID, Quota ID)
    if (pathname === "/api/space/discover" && req.method === "GET") {
      const result = {
        user: null,
        selectedGroupId: state.config.groupId || "",
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
            const groups = extractItemsArray(gRes);
            result.groups = groups;
            if (!state.config.groupId && groups.length > 0) {
              const firstId = groups[0].id ?? groups[0].groupId;
              if (firstId !== undefined && firstId !== null) {
                state.config.groupId = String(firstId);
                saveState();
                addLog("info", `SPACE 그룹 목록에서 첫 번째 그룹(${groups[0].name || firstId})을 자동 선택했습니다.`);
              }
            }
            result.selectedGroupId = state.config.groupId || "";
          } catch (e) {
            result.errors.groups = e.message;
          }
        })(),
      ]);

      // Step 2: Now fetch Group Pools, GPU Cores, Quotas/Priorities, Specifications, Images
      if (state.config.groupId) {
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
          ["images", async () => extractItemsArray(await spaceApi.getImagesV2())],
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
            const url = im0.imageUrl || im0.url || im0.fullPath || im0.name;
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

    // 6. List Live WLM Runs on SPACE
    if (pathname === "/api/space/runs" && req.method === "GET") {
      if (!state.config.accessToken) {
        return sendJson(res, 200, { runs: [], needsToken: true });
      }
      const runs = await fetchCurrentRuns();
      return sendJson(res, 200, { runs });
    }

    // 7. Get Live WLM Run Log
    if (pathname.startsWith("/api/space/runs/") && pathname.endsWith("/log") && req.method === "GET") {
      const parts = pathname.split("/");
      const runId = parts[parts.length - 2];
      const logText = await spaceApi.getRunLog(runId, { tailLines: 500 });
      return sendJson(res, 200, { runId, log: logText });
    }

    // 8. Stop/Terminate a WLM Run
    if (pathname.startsWith("/api/space/runs/") && pathname.endsWith("/stop") && req.method === "POST") {
      const parts = pathname.split("/");
      const runId = parts[parts.length - 2];
      const out = await spaceApi.terminateRun(runId);
      addLog("warn", `사용자가 Run #${runId} 강제 종료 요청`, { runId });
      return sendJson(res, 200, { ok: true, data: out });
    }

    // 8-B. Admin Run-Approval & TaskOrbit Queue Endpoints
    if (pathname === "/api/space/approvals" && req.method === "GET") {
      if (!state.config.accessToken) {
        return sendJson(res, 200, { approvals: [], taskOrbitRuns: [], pendingApprovalRuns: [], errors: {}, needsToken: true });
      }
      const summary = await fetchApprovalStatusSummary();
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
      if (body.approvalId) {
        const r1 = await spaceApi.approveApprovalItem({
          id: body.approvalId,
          groupId: state.config.groupId,
          approvedBy: currentUser,
        });
        results.push({ source: "approvals", data: r1 });
        addLog("success", `✅ [Admin Run-Approval] 수동 승인 완료 (Approval ID: ${body.approvalId})`, {
          approvalId: body.approvalId,
          runId: body.runId,
          approvedBy: currentUser,
        });
      }
      if (body.runId && !body.approvalId) {
        const r2 = await spaceApi.approveTaskOrbitRun(body.runId);
        results.push({ source: "taskorbit", data: r2 });
        addLog("success", `✅ [Admin TaskOrbit] 수동 승인 완료 (Run ID: ${body.runId})`, {
          runId: body.runId,
        });
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
      const jobObj = {
        id: body.id || `job-${Date.now()}`,
        name: String(body.name || "group-vol-worker").trim(),
        enabled: Boolean(body.enabled),
        mode: body.mode || "ensure_running",
        useSpecId: String(body.useSpecId || "").trim(),
        groupPoolId: String(body.groupPoolId || "").trim(),
        coreId: String(body.coreId || "").trim(),
        coreCount: Math.max(1, Number(body.coreCount || 1)),
        quotaId: String(body.quotaId || "").trim(),
        allowSpot: Boolean(body.allowSpot),
        autoApprove: body.autoApprove !== false,
        containerImage: String(body.containerImage || "").trim(),
        experimentId: String(body.experimentId || "").trim(),
        executionCommand: String(body.executionCommand || "bash /group-volume/run.sh").trim(),
        expectedRunTime: String(body.expectedRunTime || "8h").trim(),
        enableWebConsole: body.enableWebConsole !== false,
        minConcurrentRuns: Math.max(1, Number(body.minConcurrentRuns || 1)),
        restartOnSuccess: body.restartOnSuccess !== false,
        restartOnFail: body.restartOnFail !== false,
        cooldownSec: Math.max(1, Number(body.cooldownSec || 15)),
        volumeClaim: Array.isArray(body.volumeClaim) ? body.volumeClaim : [],
        lastCheckAt: idx >= 0 ? state.jobs[idx].lastCheckAt : null,
        lastTriggeredAt: idx >= 0 ? state.jobs[idx].lastTriggeredAt : null,
        lastRunId: idx >= 0 ? state.jobs[idx].lastRunId : null,
        lastStatus: idx >= 0 ? state.jobs[idx].lastStatus : "대기 중",
      };
      if (idx >= 0) {
        state.jobs[idx] = jobObj;
        addLog("info", `자동 실행 규칙 수정됨: ${jobObj.name}`);
      } else {
        state.jobs.push(jobObj);
        addLog("info", `새 자동 실행 규칙 추가됨: ${jobObj.name}`);
      }
      saveState();
      return sendJson(res, 200, { ok: true, job: jobObj, jobs: state.jobs });
    }

    if (pathname.startsWith("/api/jobs/") && req.method === "DELETE") {
      const jobId = pathname.split("/").pop();
      state.jobs = state.jobs.filter((j) => j.id !== jobId);
      saveState();
      addLog("warn", `자동 실행 규칙 삭제됨: ${jobId}`);
      return sendJson(res, 200, { ok: true, jobs: state.jobs });
    }

    // 10. Immediate Manual Trigger of a Job Rule or Scheduler Tick
    if (pathname === "/api/jobs/trigger" && req.method === "POST") {
      const body = await readJsonBody(req);
      const job = state.jobs.find((j) => j.id === body.jobId);
      if (!job) return sendJson(res, 404, { error: "Job rule not found" });
      const runs = await fetchCurrentRuns().catch(() => []);
      const resTrigger = await evaluateJobRule(job, runs, true);
      return sendJson(res, 200, { ok: true, result: resTrigger, job });
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

server.listen(PORT, HOST, () => {
  console.log(`======================================================================`);
  console.log(`🚀 SPACE GPU Auto-Allocator & Admin Run-Approval Server Started!`);
  console.log(`👉 Web UI Dashboard : http://localhost:${PORT} (Password: ${ADMIN_PASSWORD})`);
  console.log(`👉 Target Gateway   : ${state.config.baseUrl}`);
  console.log(`======================================================================`);
});
