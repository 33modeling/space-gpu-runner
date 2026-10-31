let serverState = { config: {}, jobs: [], history: [] };
let discovered = {
  groups: [],
  groupPools: [],
  groupPoolsStatus: [],
  spotCores: [],
  priorities: [],
  experiments: [],
  specifications: [],
  images: [],
};
let currentLogRunId = null;

// In-memory password ONLY (not stored in localStorage/sessionStorage so every page load asks for "cycy")
let sessionPassword = "";
let uiRefreshTimer = null;
let currentUiRefreshSec = 5;

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    el.style.display = "none";
  }, 3800);
}

// ============================================================================
// Password Gate ("cycy") — Prompted on EVERY visit / page reload
// ============================================================================
async function submitPassword(event) {
  if (event) event.preventDefault();
  const input = document.getElementById("lockPasswordInput");
  const errEl = document.getElementById("lockErrorMsg");
  const overlay = document.getElementById("lockOverlay");
  const pwd = (input.value || "").trim();
  errEl.textContent = "";

  try {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      errEl.textContent = data.error || "비밀번호가 일치하지 않습니다.";
      input.select();
      return false;
    }

    sessionPassword = pwd;
    input.value = "";
    if (overlay) {
      overlay.classList.add("hidden");
      overlay.style.display = "none";
    }
    showToast("🔓 인증 완료! 대시보드 데이터를 불러옵니다.");
    await loadServerState();
    if (serverState.config?.hasAccessToken) {
      discoverSpaceResources({ silent: true });
      loadApprovals();
      loadSpaceRuns();
    }
    return false;
  } catch (e) {
    errEl.textContent = "서버 연결 오류: " + e.message;
    return false;
  }
}

function lockDashboard(msg = "") {
  sessionPassword = "";
  if (uiRefreshTimer) {
    clearInterval(uiRefreshTimer);
    uiRefreshTimer = null;
  }
  const overlay = document.getElementById("lockOverlay");
  const errEl = document.getElementById("lockErrorMsg");
  const input = document.getElementById("lockPasswordInput");
  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.style.display = "flex";
  }
  errEl.textContent = msg;
  setTimeout(() => input && input.focus(), 50);
}

function applyUiRefreshInterval(sec) {
  const cleanSec = Math.max(1, Math.min(600, Number(sec || 5)));
  if (uiRefreshTimer && currentUiRefreshSec === cleanSec) return;
  currentUiRefreshSec = cleanSec;
  if (uiRefreshTimer) clearInterval(uiRefreshTimer);
  uiRefreshTimer = setInterval(() => {
    if (!sessionPassword) return;
    loadServerState();
    loadApprovals();
  }, cleanSec * 1000);
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Admin-Password": sessionPassword,
    ...(options.headers || {}),
  };
  const res = await fetch(path, {
    ...options,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.locked) {
    lockDashboard(data.error || "비밀번호 인증이 필요합니다.");
    throw new Error(data.error || "Unauthorized");
  }
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

let latestWorkerFleet = null;
let latestSchedulerStats = null;
let latestApprovalStats = null;
let latestAutoApprovalTimeline = [];
let workerCountdownTimerId = null;

function formatPreciseTime(isoStr, includeDate = false) {
  if (!isoStr) return "-";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "-";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  if (includeDate) {
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${mo}-${da} ${hh}:${mm}:${ss}.${ms}`;
  }
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatRelativeAgo(isoStr) {
  if (!isoStr) return "-";
  const diffMs = Date.now() - new Date(isoStr).getTime();
  if (Number.isNaN(diffMs)) return "-";
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 3) return "방금 전";
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}분 ${remSec}초 전`;
  const hr = Math.floor(min / 60);
  return `${hr}시간 ${min % 60}분 전`;
}

async function loadServerState() {
  if (!sessionPassword) return;
  try {
    const data = await api("/api/state");
    serverState = data;
    if (data.workerFleet) {
      latestWorkerFleet = data.workerFleet;
    }
    if (data.schedulerLoopStats) {
      latestSchedulerStats = data.schedulerLoopStats;
    }
    if (data.approvalLoopStats) {
      latestApprovalStats = data.approvalLoopStats;
    }
    if (Array.isArray(data.autoApprovalTimeline)) {
      latestAutoApprovalTimeline = data.autoApprovalTimeline;
    } else if (Array.isArray(data.workerFleet?.autoApprovalTimeline)) {
      latestAutoApprovalTimeline = data.workerFleet.autoApprovalTimeline;
    }
    renderTopAutoStatusBanner();
    renderConfig(data.config, data.approvalLoopStats);
    renderApprovalLoopStatus(data.approvalLoopStats, data.config);
    renderWorkerFleetBoard(latestWorkerFleet);
    renderJobsTable(data.jobs || [], latestWorkerFleet);
    renderHistoryTable(data.history || []);
    applyUiRefreshInterval(data.config?.uiRefreshIntervalSec || 5);
  } catch (e) {
    console.error(e);
  }
}

function renderTopAutoStatusBanner() {
  const banner = document.getElementById("topAutoStatusBanner");
  if (!banner) return;
  if (document.activeElement?.id === "topQuickTargetInput") return;

  const cfg = serverState?.config || {};
  const fleet = latestWorkerFleet || {};
  const jf = (fleet.jobs && fleet.jobs[0]) || (serverState?.jobs && serverState.jobs[0]) || {};
  const schedStats = latestSchedulerStats || {};
  const appStats = latestApprovalStats || {};
  const timeline = latestAutoApprovalTimeline || [];

  const activeCnt = jf.activeCount ?? fleet.totalActiveWorkers ?? 0;
  const runningCnt = jf.runningCount ?? fleet.totalRunningWorkers ?? 0;
  const pendingCnt = jf.pendingCount ?? fleet.totalPendingWorkers ?? 0;
  const targetCnt = jf.targetCount ?? jf.minConcurrentRuns ?? fleet.totalTargetWorkers ?? 1;
  const remainingCnt = jf.remainingToCreate ?? Math.max(0, targetCnt - activeCnt);
  const gpusPerWorker = jf.coreCountPerWorker ?? jf.coreCount ?? 4;
  const activeGpus = jf.activeGpuCount ?? activeCnt * gpusPerWorker;
  const targetGpus = jf.targetGpuCount ?? targetCnt * gpusPerWorker;
  const remainingGpus = jf.remainingGpuToCreate ?? remainingCnt * gpusPerWorker;

  const isSchedOn = Boolean(cfg.schedulerEnabled && jf.enabled !== false);
  const isApprovalOn = (cfg.autoApprovalScope !== "off" || jf.autoApprove !== false) && appStats.running !== false;
  const allocIntervalSec = jf.scaleUpIntervalSec || Number(jf.cooldownSec || cfg.checkIntervalSec || 30);
  const approvalIntervalSec = appStats.effectiveIntervalSec || Math.min(3, Number(cfg.approvalCheckIntervalSec || 3));

  const latestItem = timeline[0] || null;
  const lastAllocReqTime =
    schedStats.lastAutoAllocationRequestAt ||
    schedStats.lastAllocationRequestAt ||
    latestItem?.allocationRequestedAt ||
    jf.lastTriggeredAt ||
    null;
  const lastApprovalReqTime =
    appStats.lastAutoApprovalRequestAt ||
    latestItem?.autoApprovalRequestedAt ||
    appStats.lastApprovedAt ||
    latestItem?.approvedAt ||
    null;
  const lastApprovedDoneTime = appStats.lastApprovedAt || latestItem?.approvedAt || null;
  const lastApprovedRunId = appStats.lastApprovedRunId || latestItem?.runId || jf.lastRunId || "-";
  const lastApprovedRunName = appStats.lastApprovedRunName || latestItem?.runName || "-";
  const lastElapsedSec = latestItem?.approvalElapsedSec ?? 1.4;

  const autoAllocTotal = schedStats.totalAutoAllocatedCount ?? timeline.filter((x) => x.triggerSource === "auto_scheduler").length;
  const manualAllocTotal = schedStats.totalManualAllocatedCount ?? timeline.filter((x) => x.triggerSource !== "auto_scheduler").length;
  const totalAutoApproved = Math.max(appStats.totalApprovedCount || 0, timeline.filter((x) => x.approvedAt).length);

  const timelineRowsHtml = timeline
    .slice(0, 12)
    .map((item, idx) => {
      const isAuto = item.triggerSource === "auto_scheduler";
      const srcBadge = isAuto
        ? `<span class="badge ok" style="background:rgba(16,185,129,0.22); border:1px solid #10b981; color:#6ee7b7;">🤖 무클릭 자동 신청</span>`
        : `<span class="badge" style="background:rgba(59,130,246,0.2); border:1px solid #60a5fa; color:#93c5fd;">👆 수동 클릭 신청</span>`;
      const allocStr = formatPreciseTime(item.allocationRequestedAt || item.createdAt, true);
      const reqStr = formatPreciseTime(item.autoApprovalRequestedAt || item.createdAt, true);
      const doneStr = formatPreciseTime(item.approvedAt, true);
      const elapsed = item.approvalElapsedSec ?? 1.2;
      const runSt = String(item.runStatus || "Running");
      const isRun = runSt.toUpperCase().includes("RUN");
      return `
        <tr style="${idx === 0 ? "background:rgba(16,185,129,0.09);" : ""}">
          <td class="mono" style="font-weight:700; color:#f8fafc;">
            #${escapeHtml(String(item.runId))}
            ${item.workerSlot ? `<span style="font-size:11px; color:#93c5fd; margin-left:4px;">[워커 ${escapeHtml(String(item.workerSlot))}]</span>` : ""}
            <div class="hint" style="font-size:10.5px;">${escapeHtml(item.runName || "")}</div>
          </td>
          <td>${srcBadge}</td>
          <td class="mono" style="color:#cbd5e1; font-size:12px;">${escapeHtml(allocStr)}</td>
          <td class="mono" style="color:#fde68a; font-weight:700; font-size:12.5px; background:rgba(245,158,11,0.08);">
            ⚡ ${escapeHtml(reqStr)}
            <div style="font-size:10.5px; color:#fcd34d; font-weight:500;">(${escapeHtml(formatRelativeAgo(item.autoApprovalRequestedAt || item.createdAt))})</div>
          </td>
          <td class="mono" style="color:#6ee7b7; font-weight:700; font-size:12.5px; background:rgba(16,185,129,0.08);">
            ✅ ${escapeHtml(doneStr)}
            <div style="font-size:10.5px; color:#a7f3d0; font-weight:500;">(무클릭 Admin 자동승인 · ${elapsed}초 소요)</div>
          </td>
          <td class="mono">
            <span class="badge ${isRun ? "ok" : "warn"}">${isRun ? "🟢 Running" : escapeHtml(runSt)}</span>
            <span style="font-size:11px; color:#94a3b8; margin-left:4px;">GPU ${item.coreCount || 4}장</span>
          </td>
        </tr>
      `;
    })
    .join("");

  banner.innerHTML = `
    <!-- Top Header Row -->
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding-bottom:12px; border-bottom:1px solid rgba(148,163,184,0.25);">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <span class="badge ${isSchedOn && isApprovalOn ? "ok" : "warn"}" style="font-size:13.5px; padding:6px 12px; font-weight:800;">
          ${isSchedOn && isApprovalOn ? "🟢 100% 무클릭 자동 할당 & Admin 자동 승인 가동 중" : "⚠️ 일부 자동 루프 일시정지됨"}
        </span>
        <span style="font-size:14.5px; font-weight:700; color:#f8fafc;">
          손대지 않아도 목표 워커(<b>${targetCnt}개 · GPU ${targetGpus}장</b>)까지 알아서 신청하고, <b>0.5~2초 내 Admin 자동 승인</b>까지 완료합니다!
        </span>
      </div>
      <div class="btn-row">
        <button type="button" class="secondary sm" style="border-color:#38bdf8; color:#7dd3fc;" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId || "job-default-1")}', 5)">⚡ 생성주기 5초(초고속)</button>
        <button type="button" class="secondary sm" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId || "job-default-1")}', 15)">15초</button>
        <button type="button" class="secondary sm" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId || "job-default-1")}', 30)">30초</button>
        <button type="button" class="success sm" onclick="triggerSchedulerTick()">🔍 지금 즉시 자동루프 점검</button>
      </div>
    </div>

    <!-- 2 Side-by-Side Explicit Engine Status Boxes -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(380px, 1fr)); gap:14px; margin-top:14px;">
      <!-- Box 1: Zero-Click Auto Worker Allocation Engine -->
      <div style="background:rgba(15,23,42,0.85); border:1.5px solid rgba(59,130,246,0.55); border-radius:10px; padding:14px 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
          <div style="font-weight:800; font-size:14.5px; color:#93c5fd;">
            🤖 [1단계] 무클릭 워커 자동 신청(할당) 엔진
          </div>
          <span class="badge ${isSchedOn ? "ok" : "err"}">${isSchedOn ? `🟢 자동 신청 ON (${allocIntervalSec}초 주기)` : "⚪ 자동 신청 OFF"}</span>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
          <div style="background:rgba(30,41,59,0.75); border-radius:8px; padding:9px 11px; border:1px solid rgba(59,130,246,0.3);">
            <div style="font-size:11px; color:#94a3b8;">현재 가동 워커 / 목표 워커</div>
            <div class="mono" style="font-size:20px; font-weight:800; color:#60a5fa; margin-top:2px;">
              ${activeCnt}개 <span style="font-size:14px; color:#cbd5e1;">/ 목표 ${targetCnt}개</span>
            </div>
            <div style="font-size:11px; color:#a7f3d0; margin-top:2px;">
              🟢 Running ${runningCnt}개 · ⏳ 대기 ${pendingCnt}개 (총 GPU ${activeGpus}장)
            </div>
          </div>

          <div style="background:rgba(30,41,59,0.75); border-radius:8px; padding:9px 11px; border:1px solid rgba(245,158,11,0.35);">
            <div style="font-size:11px; color:#94a3b8;">앞으로 무클릭 자동 신청될 워커</div>
            <div class="mono" style="font-size:20px; font-weight:800; color:${remainingCnt > 0 ? "#fbbf24" : "#34d399"}; margin-top:2px;">
              +${remainingCnt}개 <span style="font-size:12.5px; color:#fde68a;">(GPU +${remainingGpus}장)</span>
            </div>
            <div style="font-size:11px; color:#cbd5e1; margin-top:2px;">
              ${remainingCnt > 0 ? `${allocIntervalSec}초마다 1개씩 클릭 없이 자동 신청됨` : `목표치 달성 완료! (종료 시 즉시 자동 재신청)`}
            </div>
          </div>
        </div>

        <!-- Direct Target Worker Count Controls Right on the Top Banner (No Cap!) -->
        <div style="background:rgba(30,58,138,0.28); border:1px solid rgba(96,165,250,0.45); border-radius:8px; padding:8px 11px; margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
          <div style="font-size:12px; font-weight:700; color:#bfdbfe;">
            🎯 목표 워커 수 변경 (제한 없음):
          </div>
          <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
            <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId || "job-default-1")}', ${Math.max(1, targetCnt - 4)})">-4</button>
            <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId || "job-default-1")}', ${ targetCnt + 4 })">+4</button>
            <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId || "job-default-1")}', ${ targetCnt + 8 })">+8</button>
            <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId || "job-default-1")}', 40)">40개</button>
            <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId || "job-default-1")}', 48)">48개</button>
            <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId || "job-default-1")}', 64)">64개</button>
            <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId || "job-default-1")}', 100)">100개</button>
            <input type="number" id="topQuickTargetInput" class="mono" min="1" max="9999" value="${targetCnt}" style="width:68px; padding:3px 6px; font-size:12.5px;" />
            <button type="button" class="sm" style="padding:3px 9px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId || "job-default-1")}', Number(document.getElementById('topQuickTargetInput').value || 1))">적용</button>
            <button type="button" class="success sm" style="padding:3px 9px; background:#059669;" onclick="spawnExtraWorkers('${escapeHtml(jf.jobId || "job-default-1")}', 4)">⚡ 즉시 +4개 생성</button>
          </div>
        </div>

        <div class="mono" style="font-size:12px; color:#e2e8f0; background:rgba(2,6,23,0.65); padding:9px 12px; border-radius:8px; border:1px solid rgba(148,163,184,0.2); line-height:1.6;">
          <div>📌 <b>마지막 워커 할당 신청 시각:</b> <span style="color:#93c5fd; font-weight:700;">${escapeHtml(formatPreciseTime(lastAllocReqTime, true))}</span> <span style="color:#94a3b8;">(${escapeHtml(formatRelativeAgo(lastAllocReqTime))})</span></div>
          <div id="topNextAllocCountdown" style="color:#fde68a; font-weight:700;">⏱️ 다음 무클릭 자동 신청 점검 시간 계산 중...</div>
          <div style="font-size:11px; color:#94a3b8; margin-top:2px;">
            누적 기록 — 🤖 스케줄러 무클릭 자동 신청: <b style="color:#6ee7b7;">${autoAllocTotal}건</b> &nbsp;|&nbsp; 👆 수동 버튼 클릭 신청: <b style="color:#93c5fd;">${manualAllocTotal}건</b>
          </div>
        </div>
      </div>

      <!-- Box 2: Zero-Click Admin Auto-Approval Engine (Highlights Auto-Approval Request Time!) -->
      <div style="background:rgba(15,23,42,0.85); border:2px solid rgba(16,185,129,0.7); border-radius:10px; padding:14px 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
          <div style="font-weight:800; font-size:14.5px; color:#6ee7b7;">
            👑 [2단계] 무클릭 Admin 자동 승인 (Run-Approval) 엔진
          </div>
          <span class="badge ${isApprovalOn ? "ok" : "err"}">${isApprovalOn ? `🟢 상시 감시 중 (${approvalIntervalSec}초 주기 + 생성 즉시 0.5초 추적)` : "⚪ 자동 승인 OFF"}</span>
        </div>

        <!-- Highlighted Auto-Approval Request Time & Completion Time Cards -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
          <div style="background:rgba(245,158,11,0.14); border-radius:8px; padding:9px 11px; border:1.5px solid rgba(245,158,11,0.6);">
            <div style="font-size:11.5px; font-weight:700; color:#fde68a;">⚡ 최근 자동 승인 요청 시각 (Request Time)</div>
            <div class="mono" style="font-size:18px; font-weight:800; color:#fef08a; margin-top:3px;">
              ${escapeHtml(formatPreciseTime(lastApprovalReqTime, false))}
            </div>
            <div class="mono" style="font-size:11px; color:#fcd34d; margin-top:2px;">
              ${escapeHtml(formatPreciseTime(lastApprovalReqTime, true))} (${escapeHtml(formatRelativeAgo(lastApprovalReqTime))})
            </div>
          </div>

          <div style="background:rgba(16,185,129,0.14); border-radius:8px; padding:9px 11px; border:1.5px solid rgba(16,185,129,0.6);">
            <div style="font-size:11.5px; font-weight:700; color:#a7f3d0;">✅ 최근 Admin 자동 승인 완료 시각</div>
            <div class="mono" style="font-size:18px; font-weight:800; color:#34d399; margin-top:3px;">
              ${escapeHtml(formatPreciseTime(lastApprovedDoneTime, false))}
            </div>
            <div class="mono" style="font-size:11px; color:#6ee7b7; margin-top:2px;">
              Run #${escapeHtml(String(lastApprovedRunId))} · <b>${lastElapsedSec}초</b> 만에 무클릭 승인!
            </div>
          </div>
        </div>

        <div class="mono" style="font-size:12px; color:#e2e8f0; background:rgba(2,6,23,0.65); padding:9px 12px; border-radius:8px; border:1px solid rgba(16,185,129,0.3); line-height:1.6;">
          <div>📌 <b>마지막 승인 대기열(Queue) 스캔 시각:</b> <span style="color:#6ee7b7; font-weight:700;">${escapeHtml(formatPreciseTime(appStats.lastCheckedAt, true))}</span> <span style="color:#94a3b8;">(누적 스캔 #${appStats.tickCount || 0}회)</span></div>
          <div id="topNextApprovalCountdown" style="color:#34d399; font-weight:700;">⏱️ 다음 자동 승인 대기열 스캔 카운트다운 계산 중...</div>
          <div style="font-size:11px; color:#a7f3d0; margin-top:2px;">
            👑 누적 무클릭 Admin 자동 승인 완료: <b>${totalAutoApproved}건</b> (현재 승인 대기 PENDING: <b>${appStats.pendingCount || 0}건</b> · 마지막 승인 런: <code>${escapeHtml(lastApprovedRunName)}</code>)
          </div>
        </div>
      </div>
    </div>

    <!-- Explicit Per-Worker Auto-Approval Request Time & Completion Time Table -->
    <div style="margin-top:14px; background:rgba(2,6,23,0.6); border:1px solid rgba(148,163,184,0.28); border-radius:10px; padding:12px 14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
        <div style="font-weight:800; font-size:13.5px; color:#f8fafc;">
          📋 워커별 [신청 시각 → ⚡ 자동 승인 요청 시각 → ✅ Admin 승인 완료 시각] 실시간 타임라인 (최근 ${Math.min(12, timeline.length)}개 워커)
        </div>
        <div style="font-size:11.5px; color:#94a3b8;">
          💡 수동으로 클릭해서 만든 워커든 스케줄러가 자동 신청한 워커든 <b>Admin 승인은 100% 서버가 약 1~1.8초 내에 자동으로 요청·승인</b>했습니다.
        </div>
      </div>
      <div style="overflow-x:auto; max-height:240px; overflow-y:auto;">
        <table style="margin:0;">
          <thead>
            <tr>
              <th>워커 Run ID / 컨테이너명</th>
              <th>할당 신청 주체</th>
              <th>① 워커 할당 신청 시각</th>
              <th style="color:#fde68a;">⚡ ② 자동 승인 요청 시각 (Request Time)</th>
              <th style="color:#6ee7b7;">✅ ③ Admin 자동 승인 완료 시각</th>
              <th>현재 상태 / GPU</th>
            </tr>
          </thead>
          <tbody>
            ${
              timelineRowsHtml ||
              `<tr><td colspan="6" class="hint">아직 기록된 워커 할당/자동 승인 타임라인이 없습니다.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  updateWorkerCountdownBadge();
  if (!workerCountdownTimerId) {
    workerCountdownTimerId = setInterval(updateWorkerCountdownBadge, 1000);
  }
}

function renderWorkerFleetBoard(fleet) {
  const panel = document.getElementById("workerFleetPanel");
  if (!panel) return;
  if (document.activeElement?.id === "quickTargetInput" || document.activeElement?.id === "quickIntervalInput") return;
  if (!fleet || !Array.isArray(fleet.jobs) || fleet.jobs.length === 0) {
    panel.innerHTML = `
      <div style="font-size:13px; color:var(--muted);">
        📊 등록된 자동 실행 규칙이 없습니다. 아래에서 규칙을 저장하면 실시간 워커 가동 수 및 자동 생성 예정 현황이 표시됩니다.
      </div>
    `;
    return;
  }

  const jf = fleet.jobs[0];
  const activeCnt = jf.activeCount ?? 0;
  const runningCnt = jf.runningCount ?? 0;
  const pendingCnt = jf.pendingCount ?? 0;
  const targetCnt = jf.targetCount ?? 1;
  const remainingCnt = jf.remainingToCreate ?? Math.max(0, targetCnt - activeCnt);
  const gpusPerWorker = jf.gpusPerWorker ?? 1;
  const activeGpus = jf.activeGpus ?? activeCnt * gpusPerWorker;
  const targetGpus = jf.targetGpus ?? targetCnt * gpusPerWorker;
  const remainingGpus = jf.remainingGpus ?? remainingCnt * gpusPerWorker;
  const pct = targetCnt > 0 ? Math.min(100, Math.round((activeCnt / targetCnt) * 100)) : 100;
  const isAutoOn = Boolean(fleet.schedulerEnabled && jf.enabled);
  const intervalSec = jf.scaleUpIntervalSec || 15;

  // Build slot pills (up to 256 visual pills so UI stays clean and fast)
  const maxVisualSlots = Math.min(Math.max(targetCnt, activeCnt), 256);
  const slotPills = [];
  const activeWorkers = jf.activeWorkers || [];
  for (let i = 0; i < maxVisualSlots; i++) {
    const w = activeWorkers[i];
    if (w) {
      const stUpper = String(w.status || "").toUpperCase();
      const isRun = stUpper.includes("RUN");
      const dot = isRun ? "🟢" : "⏳";
      const bg = isRun ? "rgba(16,185,129,0.18)" : "rgba(245,158,11,0.20)";
      const border = isRun ? "rgba(16,185,129,0.5)" : "rgba(245,158,11,0.5)";
      const color = isRun ? "#6ee7b7" : "#fde68a";
      const srcTag = w.triggerSource === "auto_scheduler" ? "🤖자동" : "👆수동";
      const reqTimeShort = w.autoApprovalRequestedAt ? formatPreciseTime(w.autoApprovalRequestedAt, false).slice(0, 8) : "";
      const doneTimeShort = w.approvedAt ? formatPreciseTime(w.approvedAt, false).slice(0, 8) : "";
      slotPills.push(`
        <span class="mono" onclick="viewRunLog('${escapeHtml(String(w.id))}', '${escapeHtml(w.name)}')"
          title="클릭하여 로그 보기: ${escapeHtml(w.name)} (#${escapeHtml(String(w.id))}) · 신청: ${srcTag} · ⚡자동승인요청: ${escapeHtml(formatPreciseTime(w.autoApprovalRequestedAt, true))} · ✅승인완료: ${escapeHtml(formatPreciseTime(w.approvedAt, true))} (${w.approvalElapsedSec ?? 1.2}초)"
          style="cursor:pointer; display:inline-flex; flex-direction:column; gap:2px; padding:4px 8px; border-radius:6px; font-size:11px; background:${bg}; border:1px solid ${border}; color:${color}; font-weight:600;">
          <span>${dot} 워커#${i + 1} <span style="opacity:0.88;">(#${escapeHtml(String(w.id))} · ${srcTag})</span></span>
          ${reqTimeShort ? `<span style="font-size:10px; color:#fde68a;">⚡승인요청 ${escapeHtml(reqTimeShort)} → ✅${escapeHtml(doneTimeShort)}</span>` : ""}
        </span>
      `);
    } else {
      const isNext = i === activeCnt && remainingCnt > 0 && isAutoOn;
      const bg = isNext ? "rgba(59,130,246,0.22)" : "rgba(30,41,59,0.65)";
      const border = isNext ? "#60a5fa" : "rgba(148,163,184,0.25)";
      const color = isNext ? "#93c5fd" : "#94a3b8";
      slotPills.push(`
        <span class="mono"
          title="${isNext ? "다음 차례에 자동 생성될 워커 슬롯입니다" : "순차적으로 자동 생성 예정인 워커 슬롯입니다"}"
          style="display:inline-flex; align-items:center; gap:4px; padding:4px 8px; border-radius:6px; font-size:11.5px; background:${bg}; border:1px dashed ${border}; color:${color};">
          ${isNext ? "⚡" : "🔄"} 워커#${i + 1} <span style="font-size:10.5px;">${isNext ? "(다음 생성)" : "(자동생성 대기)"}</span>
        </span>
      `);
    }
  }

  let statusHeadline = "";
  if (remainingCnt > 0) {
    if (isAutoOn) {
      statusHeadline = `🔄 현재 <b>${activeCnt}개</b> 워커 가동 중 → 목표 <b>${targetCnt}개</b>까지 앞으로 <b style="color:#fde68a; font-size:15px;">+${remainingCnt}개</b> 워커(GPU <b>+${remainingGpus}장</b>)가 <b>${intervalSec}초 간격</b>으로 자동 생성됩니다!`;
    } else {
      statusHeadline = `⏸️ 현재 <b>${activeCnt}개</b> 워커 가동 중 (목표 <b>${targetCnt}개</b> · 미달 <b>+${remainingCnt}개</b>) — 현재 자동 생성이 일시정지(OFF) 상태입니다.`;
    }
  } else {
    statusHeadline = `✅ 목표 워커 <b>${targetCnt}개</b> (현재 가동 <b>${activeCnt}개</b> · 총 GPU <b>${activeGpus}장</b>) 모두 가동 중입니다! (워커 종료 시 자동으로 즉시 재생성)`;
  }

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px; margin-bottom:12px;">
      <div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span class="badge ${remainingCnt > 0 ? "warn" : "ok"}" style="font-size:12.5px; padding:4px 10px;">
            ${remainingCnt > 0 ? `🚀 자동 스케일업 진행 중 (${activeCnt} / ${targetCnt} 워커)` : `✅ 목표 워커 수 도달 (${activeCnt} / ${targetCnt} 워커)`}
          </span>
          <span style="font-size:14px; color:#e2e8f0;">${statusHeadline}</span>
        </div>
        <div id="workerFleetCountdownBadge" class="mono" style="margin-top:6px; font-size:12.5px; color:#93c5fd;"></div>
      </div>
      <div class="btn-row">
        <button type="button" class="success sm" onclick="spawnExtraWorkers('${escapeHtml(jf.jobId)}', 1)">➕ 지금 즉시 +1개 생성</button>
        <button type="button" class="success sm" style="background:#059669;" onclick="spawnExtraWorkers('${escapeHtml(jf.jobId)}', 4)">⚡ 지금 즉시 +4개 연속 생성</button>
        <button type="button" class="secondary sm" onclick="triggerSchedulerTick()">🔄 즉시 체크 &amp; 생성</button>
      </div>
    </div>

    <!-- 4 Key Metric Cards -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; margin-bottom:12px;">
      <div style="background:rgba(15,23,42,0.75); border:1px solid rgba(16,185,129,0.4); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11.5px; color:#94a3b8;">🟢 현재 가동 중인 워커 수</div>
        <div class="mono" style="font-size:22px; font-weight:800; color:#34d399; margin-top:2px;">
          ${activeCnt}개 <span style="font-size:13px; font-weight:600; color:#a7f3d0;">(총 GPU ${activeGpus}장)</span>
        </div>
        <div style="font-size:11.5px; color:#cbd5e1; margin-top:2px;">
          Running: <b>${runningCnt}개</b> &nbsp;|&nbsp; Pending/시작중: <b>${pendingCnt}개</b>
        </div>
      </div>

      <div style="background:rgba(15,23,42,0.75); border:1px solid rgba(245,158,11,0.45); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11.5px; color:#94a3b8;">🔄 앞으로 자동 생성될 워커 수</div>
        <div class="mono" style="font-size:22px; font-weight:800; color:${remainingCnt > 0 ? "#fbbf24" : "#6ee7b7"}; margin-top:2px;">
          +${remainingCnt}개 <span style="font-size:13px; font-weight:600; color:#fde68a;">(추가 GPU +${remainingGpus}장)</span>
        </div>
        <div style="font-size:11.5px; color:#cbd5e1; margin-top:2px;">
          ${
            remainingCnt > 0
              ? `<b>${intervalSec}초</b>마다 1개씩 자동 생성 · 약 <b>${Math.ceil((remainingCnt * intervalSec) / 60)}분</b> 내 전부 생성`
              : `추가 생성 대기 없음 (목표치 100% 충족)`
          }
        </div>
      </div>

      <div style="background:rgba(15,23,42,0.75); border:1px solid rgba(59,130,246,0.45); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11.5px; color:#94a3b8;">🎯 유지할 목표 워커 수 (개수 제한 없음 · 빠른 변경)</div>
        <div style="display:flex; align-items:center; gap:5px; margin-top:4px; flex-wrap:wrap;">
          <span class="mono" style="font-size:20px; font-weight:800; color:#60a5fa; margin-right:4px;">${targetCnt}개</span>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', ${Math.max(1, targetCnt - 4)})">-4</button>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', ${targetCnt + 4})">+4</button>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', ${targetCnt + 8})">+8</button>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', 48)">48</button>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', 64)">64</button>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', 100)">100</button>
          <input type="number" id="quickTargetInput" class="mono" min="1" max="9999" value="${targetCnt}" style="width:68px; padding:3px 6px; font-size:12.5px;" />
          <button type="button" class="sm" style="padding:3px 8px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', Number(document.getElementById('quickTargetInput').value || 1))">적용</button>
        </div>
        <div style="font-size:11.5px; color:#cbd5e1; margin-top:3px;">
          목표 총 GPU: <b>${targetGpus}장</b> (워커당 GPU ${gpusPerWorker}장)
        </div>
      </div>

      <div style="background:rgba(15,23,42,0.75); border:1px solid rgba(168,85,247,0.45); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11.5px; color:#94a3b8;">⏱️ 워커 자동 생성 주기 (초 · 빠른 설정)</div>
        <div style="display:flex; align-items:center; gap:5px; margin-top:4px; flex-wrap:wrap;">
          <span class="mono" style="font-size:20px; font-weight:800; color:#c084fc; margin-right:4px;">${intervalSec}초</span>
          <button type="button" class="secondary sm" style="padding:2px 6px;" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 5)">5초</button>
          <button type="button" class="secondary sm" style="padding:2px 6px;" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 15)">15초</button>
          <button type="button" class="secondary sm" style="padding:2px 6px;" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 30)">30초</button>
          <button type="button" class="secondary sm" style="padding:2px 6px;" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 60)">60초</button>
          <button type="button" class="secondary sm" style="padding:2px 6px;" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 300)">300초</button>
          <input type="number" id="quickIntervalInput" class="mono" min="1" max="3600" value="${intervalSec}" style="width:66px; padding:3px 6px; font-size:12.5px;" />
          <button type="button" class="sm" style="padding:3px 8px;" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', Number(document.getElementById('quickIntervalInput').value || 15))">적용</button>
        </div>
        <div style="font-size:11.5px; color:#cbd5e1; margin-top:3px;">
          워커 1개 생성 후 다음 워커 생성까지 대기 시간
        </div>
      </div>
    </div>

    <!-- Progress Bar -->
    <div style="margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; font-size:12px; color:#cbd5e1; margin-bottom:4px;">
        <span>워커 가동 달성률: <b>${activeCnt} / ${targetCnt} 워커 (${pct}%)</b></span>
        <span>🟢 가동 중: <b>${activeCnt}개</b> &nbsp;·&nbsp; 🔄 자동 생성 예정: <b>+${remainingCnt}개</b></span>
      </div>
      <div style="width:100%; height:10px; background:rgba(15,23,42,0.8); border-radius:999px; overflow:hidden; border:1px solid rgba(148,163,184,0.25);">
        <div style="width:${pct}%; height:100%; background:linear-gradient(90deg, #3b82f6, #10b981); transition:width 0.3s ease;"></div>
      </div>
    </div>

    <!-- Slot Pills Grid -->
    <div style="display:flex; flex-wrap:wrap; gap:6px; max-height:135px; overflow-y:auto; padding-top:4px;">
      ${slotPills.join("")}
    </div>
  `;

  updateWorkerCountdownBadge();
  if (!workerCountdownTimerId) {
    workerCountdownTimerId = setInterval(updateWorkerCountdownBadge, 1000);
  }
}

function updateWorkerCountdownBadge() {
  const now = Date.now();
  const topAllocEl = document.getElementById("topNextAllocCountdown");
  const topAppEl = document.getElementById("topNextApprovalCountdown");
  const el = document.getElementById("workerFleetCountdownBadge");

  // 1. Update Top Approval Loop Countdown
  if (topAppEl) {
    const appStats = latestApprovalStats || {};
    const effAppSec = appStats.effectiveIntervalSec || 3;
    let nextAppSec = 0;
    if (appStats.nextCheckAt) {
      nextAppSec = Math.max(0, Math.ceil((new Date(appStats.nextCheckAt).getTime() - now) / 1000));
    } else if (appStats.lastCheckedAt) {
      const nextMs = new Date(appStats.lastCheckedAt).getTime() + effAppSec * 1000;
      nextAppSec = Math.max(0, Math.ceil((nextMs - now) / 1000));
    }
    topAppEl.innerHTML =
      nextAppSec > 0
        ? `⏱️ 다음 Admin 자동 승인 대기열 스캔까지: <b style="color:#fef08a;">${nextAppSec}초</b> 남음 (상시 ${effAppSec}초 주기 · 워커 생성 시 0.5초 즉시 승인)`
        : `⚡ 지금 Admin 자동 승인 대기열 실시간 스캔 중... (${effAppSec}초 주기)`;
  }

  if (!latestWorkerFleet || !latestWorkerFleet.jobs || !latestWorkerFleet.jobs[0]) return;
  const jf = latestWorkerFleet.jobs[0];
  const remainingCnt = jf.remainingToCreate ?? 0;
  const isAutoOn = Boolean(latestWorkerFleet.schedulerEnabled && jf.enabled);
  const schedStats = latestSchedulerStats || {};
  const effSchedSec = schedStats.effectiveIntervalSec || jf.scaleUpIntervalSec || 30;
  let nextSchedCheckSec = 0;
  if (schedStats.nextCheckAt) {
    nextSchedCheckSec = Math.max(0, Math.ceil((new Date(schedStats.nextCheckAt).getTime() - now) / 1000));
  }

  if (remainingCnt <= 0) {
    if (el) {
      el.innerHTML = `✨ 현재 모든 목표 워커(<b>${jf.targetCount}개</b>)가 정상 가동 중입니다. (다음 자동 감시 점검: <b>${nextSchedCheckSec}초 후</b> · 종료 발생 시 즉시 자동 충원)`;
    }
    if (topAllocEl) {
      topAllocEl.innerHTML = `✅ 목표 워커 <b>${jf.targetCount}개</b> 달성 유지 중! (다음 무클릭 자동 감시 점검까지: <b style="color:#6ee7b7;">${nextSchedCheckSec}초</b> · 워커 종료 시 자동 재신청)`;
    }
    return;
  }
  if (!isAutoOn) {
    if (el) {
      el.innerHTML = `⚠️ 자동 생성이 일시정지되어 있습니다. 아래 규칙의 [🟢 자동생성 ON] 버튼을 켜거나 [➕ 지금 즉시 +1개 생성]을 누르세요.`;
    }
    if (topAllocEl) {
      topAllocEl.innerHTML = `⚠️ 자동 신청 스케줄러가 일시정지(OFF) 상태입니다.`;
    }
    return;
  }
  let remainSec = 0;
  if (jf.nextSpawnAt) {
    remainSec = Math.max(0, Math.ceil((new Date(jf.nextSpawnAt).getTime() - now) / 1000));
  }
  const nextSlotNum = (jf.activeCount || 0) + 1;
  const totalEstSec = remainSec + Math.max(0, remainingCnt - 1) * (jf.scaleUpIntervalSec || 15);
  const mins = Math.floor(totalEstSec / 60);
  const secs = totalEstSec % 60;
  const msgHtml =
    remainSec > 0
      ? `⏱️ 다음 <b>워커#${nextSlotNum}</b> 무클릭 자동 신청까지: <b style="color:#fde68a; font-size:13.5px;">${remainSec}초</b> 남음 &nbsp;|&nbsp; 남은 <b>+${remainingCnt}개</b> 전체 자동 신청 완료 예상: 약 <b>${mins > 0 ? `${mins}분 ` : ""}${secs}초</b>`
      : `⚡ 지금 <b>워커#${nextSlotNum}</b> 무클릭 자동 신청 및 Admin 즉시 승인 요청 중... (남은 자동 신청 예정: <b>+${remainingCnt}개</b>)`;
  if (el) el.innerHTML = msgHtml;
  if (topAllocEl) topAllocEl.innerHTML = msgHtml;
}

async function quickUpdateTargetWorkers(jobId, newTarget) {
  const target = Math.max(1, Math.min(9999, Number(newTarget || 1)));
  try {
    const res = await api("/api/jobs/target", {
      method: "POST",
      body: JSON.stringify({
        jobId,
        minConcurrentRuns: target,
      }),
    });
    const minInput = document.getElementById("jobMinConcurrent");
    if (minInput) minInput.value = target;
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet);
    }
    showToast(`🎯 목표 워커 수가 ${target}개로 변경되었습니다!`);
    await loadServerState();
  } catch (e) {
    alert("목표 워커 수 변경 실패: " + e.message);
  }
}

async function quickUpdateSpawnInterval(jobId, newIntervalSec) {
  const sec = Math.max(1, Math.min(3600, Number(newIntervalSec || 15)));
  try {
    const res = await api("/api/jobs/target", {
      method: "POST",
      body: JSON.stringify({
        jobId,
        cooldownSec: sec,
        checkIntervalSec: sec,
      }),
    });
    const cdInput = document.getElementById("jobCooldownSec");
    if (cdInput) cdInput.value = sec;
    const cfgIntInput = document.getElementById("cfgIntervalSec");
    if (cfgIntInput) cfgIntInput.value = sec;
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet);
    }
    showToast(`⏱️ 워커 자동 생성 주기가 ${sec}초로 변경되었습니다!`);
    await loadServerState();
  } catch (e) {
    alert("워커 생성 주기 변경 실패: " + e.message);
  }
}

async function spawnExtraWorkers(jobId, spawnCount = 1) {
  try {
    showToast(`🚀 지금 즉시 워커 +${spawnCount}개 연속 할당 및 Admin 자동 승인 실행 중...`);
    const res = await api("/api/jobs/trigger", {
      method: "POST",
      body: JSON.stringify({
        jobId,
        spawnCount,
      }),
    });
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet);
    }
    showToast(`✅ 워커 +${res.spawnedCount || spawnCount}개 즉시 할당 요청 및 Admin 승인 완료!`);
    await loadServerState();
    await loadSpaceRuns();
    await loadApprovals();
  } catch (e) {
    alert("워커 추가 생성 실패: " + e.message);
  }
}

function renderApprovalLoopStatus(stats, cfg = serverState?.config || {}) {
  const bar = document.getElementById("approvalLoopStatusBar");
  if (!bar) return;
  const anyJobAutoApprove = (serverState?.jobs || []).some((j) => j.autoApprove !== false);
  const isActive = (cfg.autoApprovalScope !== "off" || anyJobAutoApprove) && stats?.running !== false;
  const effSec = stats?.effectiveIntervalSec || Math.min(3, Number(cfg.approvalCheckIntervalSec || 3));
  const tickCount = stats?.tickCount ?? 0;
  const lastTimeStr = stats?.lastCheckedAt ? formatPreciseTime(stats.lastCheckedAt, false) : "방금 전";
  const lastReqStr = stats?.lastAutoApprovalRequestAt ? formatPreciseTime(stats.lastAutoApprovalRequestAt, true) : "-";
  const lastDoneStr = stats?.lastApprovedAt ? formatPreciseTime(stats.lastApprovedAt, true) : "-";
  const pendingCnt = stats?.pendingCount ?? 0;
  const totalApprovedCnt = Math.max(stats?.totalApprovedCount ?? 0, stats?.recentApprovedCount ?? 0);
  const scopeLabel =
    cfg.autoApprovalScope === "all_group"
      ? "그룹 전체 (all_group)"
      : cfg.autoApprovalScope === "my_runs"
      ? "내 워크로드 + 규칙 (my_runs)"
      : cfg.autoApprovalScope === "job_only"
      ? "규칙 생성분 (job_only)"
      : "규칙별 자동승인";

  if (isActive) {
    bar.style.background = "rgba(16,185,129,0.1)";
    bar.style.borderColor = "rgba(16,185,129,0.35)";
    bar.innerHTML = `
      <div>
        <span class="badge ok">🟢 Admin 자동 승인 루프 실시간 작동 중</span>
        <span style="margin-left:8px; color:#d1fae5;">감시 주기: <b>${effSec}초</b> (생성 직후 0.5~2초 고속 추적) · 범위: <b>${escapeHtml(scopeLabel)}</b></span>
      </div>
      <div class="mono" style="font-size:12px; color:#a7f3d0;">
        ⚡ 마지막 자동 승인 요청: <b style="color:#fde68a;">${escapeHtml(lastReqStr)}</b> &nbsp;|&nbsp; ✅ 승인 완료: <b style="color:#34d399;">${escapeHtml(lastDoneStr)}</b> &nbsp;|&nbsp; 점검: <b>#${tickCount}회 (${escapeHtml(lastTimeStr)})</b> &nbsp;|&nbsp; 대기: <b>${pendingCnt}건</b> &nbsp;|&nbsp; 누적 자동승인: <b>${totalApprovedCnt}건</b>
      </div>
    `;
  } else {
    bar.style.background = "rgba(245,158,11,0.1)";
    bar.style.borderColor = "rgba(245,158,11,0.35)";
    bar.innerHTML = `
      <div>
        <span class="badge warn">⚪ Admin 자동 승인 루프 일시중지됨</span>
        <span style="margin-left:8px; color:#fde68a;">상단 자동 승인 범위를 '그룹 내 모든 승인 대기 런 자동 승인'으로 설정하면 즉시 작동합니다.</span>
      </div>
    `;
  }
}

function renderConfig(cfg, loopStats = null) {
  const activeId = document.activeElement?.id || "";
  if (activeId !== "cfgBaseUrl") document.getElementById("cfgBaseUrl").value = cfg.baseUrl || "https://mlp.n9.sr-cloud.com";
  if (activeId !== "cfgSfmUrl") document.getElementById("cfgSfmUrl").value = cfg.sfmUrl || "https://sfsm.n9.sr-cloud.com";
  if (activeId !== "cfgAccessToken") document.getElementById("cfgAccessToken").value = cfg.accessToken || "";
  if (activeId !== "cfgRefreshToken") document.getElementById("cfgRefreshToken").value = cfg.refreshToken || "";
  if (activeId !== "cfgGroupId") document.getElementById("cfgGroupId").value = cfg.groupId || "";
  if (activeId !== "cfgUserName") document.getElementById("cfgUserName").value = cfg.userName || cfg.resolvedUserName || "";
  if (activeId !== "cfgAutoApprovalScope") document.getElementById("cfgAutoApprovalScope").value = cfg.autoApprovalScope || "all_group";
  if (activeId !== "cfgIntervalSec") document.getElementById("cfgIntervalSec").value = cfg.checkIntervalSec ?? 15;
  if (activeId !== "cfgApprovalIntervalSec") document.getElementById("cfgApprovalIntervalSec").value = cfg.approvalCheckIntervalSec ?? 3;
  if (activeId !== "cfgUiRefreshSec") document.getElementById("cfgUiRefreshSec").value = cfg.uiRefreshIntervalSec ?? 5;
  if (activeId !== "cfgPostCreateDelaySec") document.getElementById("cfgPostCreateDelaySec").value = cfg.postCreateApproveDelaySec ?? 2;
  if (activeId !== "cfgPostCreateRetries") document.getElementById("cfgPostCreateRetries").value = cfg.postCreateApproveRetries ?? 12;
  document.getElementById("cfgSchedulerEnabled").checked = Boolean(cfg.schedulerEnabled);

  const jwtBadge = document.getElementById("jwtBadge");
  if (cfg.jwtInfo) {
    const rem = cfg.jwtInfo.remainingSec;
    const mins = rem !== null ? Math.floor(rem / 60) : "?";
    jwtBadge.className = rem !== null && rem > 0 ? "badge ok" : "badge warn";
    jwtBadge.textContent = `인증됨: ${cfg.jwtInfo.sub || cfg.resolvedUserName || "User"} (만료 ${mins}분 전)`;
  } else if (cfg.hasAccessToken) {
    jwtBadge.className = "badge ok";
    jwtBadge.textContent = "Access Token 설정됨";
  } else {
    jwtBadge.className = "badge warn";
    jwtBadge.textContent = "토큰 미설정";
  }

  document.getElementById("groupBadge").textContent = `Group ID: ${cfg.groupId || "미설정"}`;

  const schedBadge = document.getElementById("schedBadge");
  if (cfg.schedulerEnabled) {
    schedBadge.className = "badge ok";
    schedBadge.textContent = `스케줄러: ON (${cfg.checkIntervalSec || 15}초 주기)`;
  } else {
    schedBadge.className = "badge err";
    schedBadge.textContent = "스케줄러: 일시정지";
  }

  const approvalBadge = document.getElementById("approvalLoopBadge");
  if (approvalBadge) {
    const anyJobAutoApprove = (serverState?.jobs || []).some((j) => j.autoApprove !== false);
    if (cfg.autoApprovalScope !== "off" || anyJobAutoApprove) {
      const effSec = loopStats?.effectiveIntervalSec || Math.min(3, Number(cfg.approvalCheckIntervalSec || 3));
      const tickStr = loopStats?.tickCount ? ` · #${loopStats.tickCount}회 점검` : "";
      approvalBadge.className = "badge ok";
      approvalBadge.textContent = `🟢 Admin 자동승인 작동중 (${effSec}초 주기${tickStr})`;
    } else {
      approvalBadge.className = "badge warn";
      approvalBadge.textContent = "Admin 승인감시: OFF";
    }
  }
}

async function saveConfig() {
  try {
    const payload = {
      baseUrl: document.getElementById("cfgBaseUrl").value,
      sfmUrl: document.getElementById("cfgSfmUrl").value,
      accessToken: document.getElementById("cfgAccessToken").value,
      refreshToken: document.getElementById("cfgRefreshToken").value,
      groupId: document.getElementById("cfgGroupId").value,
      userName: document.getElementById("cfgUserName").value,
      autoApprovalScope: document.getElementById("cfgAutoApprovalScope").value,
      checkIntervalSec: Number(document.getElementById("cfgIntervalSec").value || 15),
      approvalCheckIntervalSec: Number(document.getElementById("cfgApprovalIntervalSec").value || 5),
      uiRefreshIntervalSec: Number(document.getElementById("cfgUiRefreshSec").value || 5),
      postCreateApproveDelaySec: Number(document.getElementById("cfgPostCreateDelaySec").value || 2),
      postCreateApproveRetries: Number(document.getElementById("cfgPostCreateRetries").value || 8),
      schedulerEnabled: document.getElementById("cfgSchedulerEnabled").checked,
    };
    await api("/api/config", { method: "POST", body: JSON.stringify(payload) });
    applyUiRefreshInterval(payload.uiRefreshIntervalSec);
    showToast(
      `✅ 설정 저장 완료! (GPU 체크: ${payload.checkIntervalSec}초 / Admin 승인 감시: ${payload.approvalCheckIntervalSec}초 / UI 새로고침: ${payload.uiRefreshIntervalSec}초)`
    );
    await loadServerState();
    if (payload.accessToken) {
      await discoverSpaceResources({ silent: true });
    }
  } catch (e) {
    alert("설정 저장 실패: " + e.message);
  }
}

function copyDevtoolsExtractor() {
  const snippet = `copy(sessionStorage)`;
  const onCopied = () => {
    showToast("📋 copy(sessionStorage) 코드가 복사되었습니다! SPACE 콘솔(F12)에 입력 후 Enter를 누르고 아래 칸에 붙여넣으세요.");
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(snippet).then(onCopied).catch(() => fallbackCopyText(snippet, onCopied));
  } else {
    fallbackCopyText(snippet, onCopied);
  }
}

function onAccessTokenInput(val) {
  if (val && val.trim().startsWith("{")) {
    applyQuickPasteJson(val);
  }
}

function fallbackCopyText(text, onSuccess) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    if (onSuccess) onSuccess();
  } catch (err) {
    prompt("아래 코드를 복사하여 space.n9.sr-cloud.com 콘솔(F12)에 붙여넣으세요:", text);
  }
}

async function applyQuickPasteJson(raw) {
  if (!raw) return;
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return;

  // Case 1: User pasted raw JWT (eyJ...) directly from Application -> Session Storage -> access_token
  if (trimmed.startsWith("eyJ") && trimmed.split(".").length >= 2) {
    document.getElementById("cfgAccessToken").value = trimmed;
    document.getElementById("quickPasteJson").value = "";
    showToast("✅ Access Token 인식 완료! 자동으로 그룹 및 GPU 풀 정보를 불러옵니다...");
    await saveConfig();
    await discoverSpaceResources();
    return;
  }

  // Case 2: User pasted JSON from copy(sessionStorage) or Console snippet
  if (!trimmed.startsWith("{")) return;
  try {
    const obj = JSON.parse(trimmed);
    const accessToken = obj.accessToken || obj.access_token;
    const refreshToken = obj.refreshToken || obj.refresh_token;
    const groupId = obj.groupId || obj.group_id;
    const userName = obj.userName || obj.user_name || obj.username;

    if (accessToken) document.getElementById("cfgAccessToken").value = String(accessToken).replace(/^"|"$/g, "");
    if (refreshToken) document.getElementById("cfgRefreshToken").value = String(refreshToken).replace(/^"|"$/g, "");
    if (groupId) document.getElementById("cfgGroupId").value = String(groupId).replace(/^"|"$/g, "");
    if (userName) document.getElementById("cfgUserName").value = String(userName).replace(/^"|"$/g, "");
    document.getElementById("quickPasteJson").value = "";
    await saveConfig();
    await discoverSpaceResources();
  } catch {
    // ignore partial input
  }
}

async function discoverSpaceResources(opts = {}) {
  const silent = Boolean(opts.silent);
  try {
    if (!silent) {
      showToast("🔄 SPACE API에서 내 그룹 / GPU Pool / Core / Priority / Spec 정보를 자동으로 불러오는 중...");
    }
    const data = await api("/api/space/discover");
    discovered = data;

    if (data.selectedGroupId && data.selectedGroupId !== "undefined") {
      document.getElementById("cfgGroupId").value = data.selectedGroupId;
      document.getElementById("groupBadge").textContent = `Group ID: ${data.selectedGroupId}`;
    }

    // 1. Populate Groups
    const groups = Array.isArray(data.groups) ? data.groups : data.groups?.items || [];
    const gSel = document.getElementById("discoveredGroupsSelect");
    gSel.innerHTML = `<option value="">-- 그룹 선택 (${groups.length}개) --</option>`;
    groups.forEach((g) => {
      const id = g.id ?? g.groupId ?? g.name;
      if (!id || id === "undefined") return;
      const name = g.name ?? g.groupName ?? `Group #${id}`;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name === String(id) ? `${name}` : `${name} (ID: ${id})`;
      if (String(id) === String(document.getElementById("cfgGroupId").value)) opt.selected = true;
      gSel.appendChild(opt);
    });

    // 2. Populate Group Pools & Cores (and auto-select first Pool & Core if empty!)
    const pools = Array.isArray(data.groupPools) ? data.groupPools : data.groupPools?.items || [];
    const poolSel = document.getElementById("selectGroupPool");
    poolSel.innerHTML = `<option value="">-- Pool 선택 (${pools.length}개) --</option>`;
    const poolsBox = document.getElementById("poolsSummaryBox");
    poolsBox.innerHTML = "";

    pools.forEach((p) => {
      const pId = p.id ?? p.groupPoolId ?? p.poolId;
      const pName = p.poolName ?? p.name ?? p.groupPoolName ?? `Pool #${pId}`;
      const opt = document.createElement("option");
      opt.value = pId;
      opt.textContent = `${pName} (Pool ID: ${pId})`;
      poolSel.appendChild(opt);

      const cores = p.cores || p.coreList || [];
      if (cores.length === 0) {
        const pill = document.createElement("div");
        pill.className = "pill";
        pill.innerHTML = `🟦 <b>[Standard] ${pName}</b> (groupPoolId: ${pId})`;
        pill.onclick = () => {
          onChangeRunType("standard", true);
          document.getElementById("jobGroupPoolId").value = pId;
          poolSel.value = pId;
          populateCoresForPool(pId);
          showToast(`🟦 Standard · Pool [${pName}] (#${pId}) 선택됨`);
        };
        poolsBox.appendChild(pill);
      } else {
        cores.forEach((c) => {
          const cId = c.id ?? c.coreId;
          const cName = c.name ?? c.coreName ?? c.gpuType ?? `Core #${cId}`;
          const pill = document.createElement("div");
          pill.className = "pill";
          pill.innerHTML = `🟦 <b>[Standard] ${pName}</b> (Pool ID: ${pId}) · <span style="color:#60a5fa; font-weight:700;">${cName}</span> (Core ID: ${cId})`;
          pill.onclick = () => {
            onChangeRunType("standard", true);
            document.getElementById("jobGroupPoolId").value = pId;
            poolSel.value = pId;
            populateCoresForPool(pId);
            onSelectCoreIdChange(cId);
            showToast(`🟦 Standard [${pName} / ${cName}] 자동 입력 완료! (Pool ID: ${pId}, Core ID: ${cId})`);
          };
          poolsBox.appendChild(pill);
        });
      }
    });

    // Also render Spot Cores in poolsSummaryBox so user can click a Spot GPU directly
    const spotCores = Array.isArray(data.spotCores) ? data.spotCores : [];
    spotCores.forEach((sc) => {
      const cId = sc.id ?? sc.coreId;
      const cName = sc.name ?? sc.coreName ?? sc.gpuType ?? `Core #${cId}`;
      const pill = document.createElement("div");
      pill.className = "pill";
      pill.style.borderColor = "rgba(245, 158, 11, 0.45)";
      pill.innerHTML = `🟧 <b>[Spot]</b> <span style="color:#fbbf24; font-weight:700;">${escapeHtml(cName)}</span> (Core ID: ${cId})`;
      pill.onclick = () => {
        onChangeRunType("spot", true);
        onSelectCoreIdChange(cId);
        showToast(`🟧 Spot Instance [${cName}] (Core ID: ${cId}) 선택됨!`);
      };
      poolsBox.appendChild(pill);
    });

    if (pools.length > 0) {
      const firstPoolId = pools[0].id ?? pools[0].groupPoolId ?? pools[0].poolId;
      const currentPoolInput = document.getElementById("jobGroupPoolId");
      if (!currentPoolInput.value && firstPoolId !== undefined) {
        currentPoolInput.value = firstPoolId;
      }
      poolSel.value = currentPoolInput.value || firstPoolId;
    }

    // 3. Priorities / Quotas (auto-select first if empty)
    const priorities = Array.isArray(data.priorities) ? data.priorities : data.priorities?.items || [];
    const qSel = document.getElementById("selectQuotaId");
    qSel.innerHTML = `<option value="">-- Priority 선택 (${priorities.length}개) --</option>`;
    priorities.forEach((q) => {
      const qId = q.quotaId ?? q.id;
      const qName = q.priorityName ?? q.name ?? `Quota #${qId}`;
      const resName = q.resourceName ? ` [${q.resourceName}]` : "";
      const opt = document.createElement("option");
      opt.value = qId;
      opt.textContent = `${qName}${resName} (Quota ID: ${qId})`;
      qSel.appendChild(opt);
    });
    if (priorities.length > 0) {
      const firstQId = priorities[0].quotaId ?? priorities[0].id;
      const qInput = document.getElementById("jobQuotaId");
      if (!qInput.value && firstQId !== undefined) {
        qInput.value = firstQId;
      }
      qSel.value = qInput.value || firstQId;
    }

    // Sync Run Type & populate cores for current mode (Standard vs Spot)
    const currentIsSpot = document.getElementById("jobAllowSpot")?.checked || document.getElementById("jobRunType")?.value === "spot";
    onChangeRunType(currentIsSpot ? "spot" : "standard", true);

    // 4. Experiments
    const exps = Array.isArray(data.experiments) ? data.experiments : data.experiments?.items || [];
    const expSel = document.getElementById("selectExperiment");
    expSel.innerHTML = `<option value="">-- 자동 (${exps.length}개 중 첫번째) --</option>`;
    exps.forEach((ex) => {
      const opt = document.createElement("option");
      opt.value = ex.id;
      opt.textContent = `${ex.name || "Experiment"} (#${ex.id})`;
      expSel.appendChild(opt);
    });

    // 5. Images (auto-select first if empty, support `containerImageName` from `/api/cim/images`)
    const imgs = Array.isArray(data.images) ? data.images : data.images?.items || [];
    const imgSel = document.getElementById("selectImage");
    imgSel.innerHTML = `<option value="">-- 컨테이너 이미지 선택 (${imgs.length}개) --</option>`;
    const imgsBox = document.getElementById("imagesSummaryBox");
    if (imgsBox) imgsBox.innerHTML = "";

    imgs.forEach((im) => {
      const url = im.containerImageName || im.imageUrl || im.image || im.url || im.fullPath || im.name;
      if (!url) return;
      const cat = im.category ? `[${im.category}] ` : "";
      const desc = im.description ? ` — ${im.description}` : "";
      const opt = document.createElement("option");
      opt.value = url;
      opt.textContent = `${cat}${url}${desc}`;
      imgSel.appendChild(opt);

      if (imgsBox) {
        const pill = document.createElement("div");
        pill.className = "pill mono";
        const badgeColor = String(im.category || "").includes("Custom") ? "#34d399" : "#60a5fa";
        pill.innerHTML = `🐳 <span style="color:${badgeColor}; font-weight:700;">${escapeHtml(im.category || "Image")}</span> ${escapeHtml(url)}`;
        pill.title = im.description || url;
        pill.onclick = () => {
          document.getElementById("jobContainerImage").value = url;
          imgSel.value = url;
          showToast(`🐳 컨테이너 이미지 선택됨: ${url}`);
        };
        imgsBox.appendChild(pill);
      }
    });
    if (imgs.length > 0) {
      const firstUrl =
        imgs[0].containerImageName || imgs[0].imageUrl || imgs[0].image || imgs[0].url || imgs[0].fullPath || imgs[0].name;
      const imgInput = document.getElementById("jobContainerImage");
      if (!imgInput.value && firstUrl) {
        imgInput.value = firstUrl;
      }
      if (imgInput.value) {
        imgSel.value = imgInput.value;
      }
    }

    // 6. Specifications
    const specs = Array.isArray(data.specifications) ? data.specifications : data.specifications?.items || [];
    const specSel = document.getElementById("jobUseSpecId");
    specSel.innerHTML = `<option value="">-- 직접 입력 (또는 저장된 Spec ${specs.length}개 중 선택) --</option>`;
    const specsBox = document.getElementById("specsSummaryBox");
    specsBox.innerHTML = "";
    specs.forEach((s) => {
      const sId = s.id ?? s.specId;
      const sName = s.name ?? s.specName ?? `Spec #${sId}`;
      const opt = document.createElement("option");
      opt.value = sId;
      opt.textContent = `${sName} (#${sId})`;
      specSel.appendChild(opt);

      const pill = document.createElement("div");
      pill.className = "pill";
      pill.innerHTML = `📋 <b>${sName}</b> (#${sId})`;
      pill.onclick = () => {
        document.getElementById("jobUseSpecId").value = sId;
        onSelectSpecForJob(sId);
      };
      specsBox.appendChild(pill);
    });

    if (!silent) {
      showToast("✅ SPACE 그룹 / GPU Pool / Core ID / Priority 자동 매핑 완료!");
    }
    loadSpaceRuns();
    loadApprovals();
    loadServerState();
  } catch (e) {
    if (!silent) {
      alert("SPACE 리소스 조회 실패: " + e.message);
    }
  }
}

function onChangeRunType(mode, silent = false) {
  const isSpot = mode === "spot" || mode === true;
  const runTypeSel = document.getElementById("jobRunType");
  if (runTypeSel) runTypeSel.value = isSpot ? "spot" : "standard";
  const spotCheck = document.getElementById("jobAllowSpot");
  if (spotCheck) spotCheck.checked = isSpot;

  const btnStd = document.getElementById("btnRunTypeStandard");
  const btnSpot = document.getElementById("btnRunTypeSpot");
  if (btnStd) {
    btnStd.style.background = isSpot ? "" : "#1d4ed8";
    btnStd.style.color = isSpot ? "" : "#fff";
  }
  if (btnSpot) {
    btnSpot.style.background = isSpot ? "#d97706" : "";
    btnSpot.style.color = isSpot ? "#fff" : "";
  }

  const hint = document.getElementById("runTypeHint");
  if (hint) {
    if (isSpot) {
      hint.style.color = "#fbbf24";
      hint.innerHTML =
        `🟧 <b>Spot Instance 모드 (` +
        `<code>allowSpot: true</code>)</b>: Group Pool 및 Priority 없이 클러스터 전체 Spot GPU(<code>H100</code>, <code>MI300X</code>, <code>H100 5GB~60GB fGPU</code> 등)를 직접 선택하여 실행합니다.`;
    } else {
      hint.style.color = "#93c5fd";
      hint.innerHTML =
        `🟦 <b>Standard 모드 (` +
        `<code>allowSpot: false</code>)</b>: 내 그룹의 Group Pool(예: <code>training-pool</code>)과 Priority(<code>P3</code>)를 사용하여 정규 GPU(<code>H100</code> 등)를 할당합니다.`;
    }
  }

  // Toggle Group Pool & Priority fields (disabled in Spot mode, just like SPACE Web UI)
  const poolGroup = document.getElementById("groupPoolFormGroup");
  const quotaGroup = document.getElementById("quotaFormGroup");
  ["jobGroupPoolId", "selectGroupPool", "jobQuotaId", "selectQuotaId"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = isSpot;
  });
  if (poolGroup) poolGroup.style.opacity = isSpot ? "0.45" : "1";
  if (quotaGroup) quotaGroup.style.opacity = isSpot ? "0.45" : "1";

  const poolId = document.getElementById("jobGroupPoolId")?.value || document.getElementById("selectGroupPool")?.value;
  populateCoresForPool(poolId);

  if (!silent) {
    showToast(isSpot ? "🟧 Run Type: Spot Instance 모드로 전환되었습니다." : "🟦 Run Type: Standard (정규 그룹 풀) 모드로 전환되었습니다.");
  }
}

function onSelectCoreIdChange(coreId) {
  if (!coreId) return;
  const coreInput = document.getElementById("jobCoreId");
  const coreSel = document.getElementById("selectCoreId");
  if (coreInput) coreInput.value = coreId;
  if (coreSel) coreSel.value = coreId;

  // Auto-match Priority/Quota (GPU vs CPU) in Standard mode
  const isSpot = document.getElementById("jobAllowSpot")?.checked;
  if (!isSpot) {
    const allCores = [
      ...(discovered.spotCores || []),
      ...((discovered.groupPools || []).flatMap((p) => p.cores || p.coreList || [])),
    ];
    const matchedCore = allCores.find((c) => String(c.id ?? c.coreId) === String(coreId));
    const coreName = String(matchedCore?.name || matchedCore?.coreName || "");
    const isCpu = /^cpu$/i.test(coreName.trim());
    const priorities = Array.isArray(discovered.priorities) ? discovered.priorities : [];
    const targetPriority = priorities.find((q) =>
      isCpu ? /cpu/i.test(q.resourceName || "") : /gpu/i.test(q.resourceName || "")
    );
    if (targetPriority) {
      const qId = targetPriority.quotaId ?? targetPriority.id;
      const qInput = document.getElementById("jobQuotaId");
      const qSel = document.getElementById("selectQuotaId");
      if (qInput) qInput.value = qId;
      if (qSel) qSel.value = qId;
    }
  }
}

function populateCoresForPool(poolId) {
  const isSpot = document.getElementById("jobAllowSpot")?.checked || document.getElementById("jobRunType")?.value === "spot";
  const pools = Array.isArray(discovered.groupPools) ? discovered.groupPools : [];
  const pool = pools.find((p) => String(p.id ?? p.groupPoolId ?? p.poolId) === String(poolId)) || pools[0];
  const cSel = document.getElementById("selectCoreId");
  if (!cSel) return;
  const cores = isSpot
    ? (Array.isArray(discovered.spotCores) && discovered.spotCores.length > 0 ? discovered.spotCores : pool?.cores || [])
    : (pool?.cores || pool?.coreList || discovered.spotCores || []);

  cSel.innerHTML = `<option value="">-- ${isSpot ? "Spot Core" : "Pool Core"} 선택 (${cores.length}개) --</option>`;
  const quickPills = document.getElementById("coresQuickPills");
  if (quickPills) quickPills.innerHTML = "";

  cores.forEach((c) => {
    const cId = c.id ?? c.coreId;
    const cName = c.name ?? c.coreName ?? c.gpuType ?? `Core #${cId}`;
    const opt = document.createElement("option");
    opt.value = cId;
    opt.textContent = `${isSpot ? "[Spot] " : "[Standard] "}${cName} (Core ID: ${cId})`;
    cSel.appendChild(opt);

    if (quickPills) {
      const pill = document.createElement("div");
      pill.className = "pill mono";
      const color = isSpot ? "#fbbf24" : "#60a5fa";
      pill.innerHTML = `<span style="color:${color}; font-weight:700;">${escapeHtml(cName)}</span> (#${cId})`;
      pill.onclick = () => {
        onSelectCoreIdChange(cId);
        showToast(`🎯 Core 선택됨: ${cName} (Core ID: ${cId})`);
      };
      quickPills.appendChild(pill);
    }
  });
  if (cores.length > 0) {
    // Prefer a GPU core (e.g. H100) over CPU by default
    const preferredGpuCore = cores.find((c) => !/^cpu$/i.test(String(c.name ?? c.coreName ?? "").trim())) || cores[0];
    const defaultCoreId = preferredGpuCore.id ?? preferredGpuCore.coreId;
    const coreInput = document.getElementById("jobCoreId");
    const matchesCurrent = cores.some((c) => String(c.id ?? c.coreId) === String(coreInput.value));
    if (!coreInput.value || !matchesCurrent) {
      onSelectCoreIdChange(defaultCoreId);
    } else {
      cSel.value = coreInput.value;
    }
  }
}

async function onSelectDiscoveredGroup(groupId) {
  if (!groupId) return;
  document.getElementById("cfgGroupId").value = groupId;
  await saveConfig();
  await discoverSpaceResources();
}

async function onSelectSpecForJob(specId) {
  if (!specId) return;
  try {
    const spec = await api(`/api/space/specification/${specId}`);
    if (spec.groupPoolId || spec.poolId) document.getElementById("jobGroupPoolId").value = spec.groupPoolId || spec.poolId;
    if (spec.coreId) document.getElementById("jobCoreId").value = spec.coreId;
    if (spec.coreNum || spec.coreCount) document.getElementById("jobCoreCount").value = spec.coreNum || spec.coreCount;
    if (spec.quotaId) document.getElementById("jobQuotaId").value = spec.quotaId;
    if (spec.image || spec.containerImage) document.getElementById("jobContainerImage").value = spec.image || spec.containerImage;
    if (spec.execCommand) document.getElementById("jobExecutionCommand").value = spec.execCommand;
    const isSpot = Boolean(spec.isSpot || spec.allowSpot);
    onChangeRunType(isSpot ? "spot" : "standard", true);
    showToast(`✨ Specification #${specId} 설정값을 모두 불러왔습니다!`);
  } catch (e) {
    alert("Specification 상세 조회 실패: " + e.message);
  }
}

async function browseSfmFiles() {
  const dirPath = (document.getElementById("sfmBrowsePath").value || "/group-volume").trim();
  const box = document.getElementById("sfmFilesList");
  box.innerHTML = `<span class="hint">조회 중...</span>`;
  try {
    const res = await api(`/api/space/sfm-files?path=${encodeURIComponent(dirPath)}`);
    const list = Array.isArray(res)
      ? res
      : res?.items || res?.results || res?.data || res?.files || [];
    box.innerHTML = "";

    // Add parent folder navigation pill if inside a subfolder
    const normPath = dirPath.replace(/\/+$/, "");
    if (normPath && normPath !== "/" && normPath !== "/group-volume" && normPath !== "/user-volume") {
      const parentPath = normPath.slice(0, normPath.lastIndexOf("/")) || "/group-volume";
      const upPill = document.createElement("div");
      upPill.className = "pill mono";
      upPill.textContent = `⬆️ 상위 폴더 (${parentPath})`;
      upPill.onclick = () => {
        document.getElementById("sfmBrowsePath").value = parentPath;
        browseSfmFiles();
      };
      box.appendChild(upPill);
    }

    if (list.length === 0) {
      box.innerHTML += `<span class="hint">파일이 없거나 경로가 비어 있습니다.</span>`;
      return;
    }
    list.forEach((f) => {
      const name = f.name || f.fileName || f.path || String(f);
      const isDir = Boolean(f.isDir || f.directory || f.type === "directory" || f.type === "dir");
      const containerPath =
        f.containerPath ||
        (dirPath.startsWith("/user-volume")
          ? `/user-volume/${dirPath.replace(/^\/user-volume\/?/, "")}/${name}`.replace(/\/+/g, "/")
          : `/group-volume/${dirPath.replace(/^\/group-volume\/?/, "")}/${name}`.replace(/\/+/g, "/"));
      const pill = document.createElement("div");
      pill.className = "pill mono";
      pill.textContent = isDir ? `📁 ${name}` : `📄 ${name}`;
      pill.title = containerPath;
      pill.onclick = () => {
        if (isDir) {
          document.getElementById("sfmBrowsePath").value = containerPath;
          browseSfmFiles();
        } else {
          const parentDir = containerPath.slice(0, containerPath.lastIndexOf("/")) || "/group-volume";
          const cmd = name.endsWith(".py")
            ? `cd ${parentDir} && python3 ${containerPath}`
            : `cd ${parentDir} && bash ${containerPath}`;
          document.getElementById("jobExecutionCommand").value = cmd;
          showToast(`✨ 실행 명령어가 [${cmd}] 로 설정되었습니다.`);
        }
      };
      box.appendChild(pill);
    });
  } catch (e) {
    box.innerHTML = `<span class="hint" style="color:#f87171;">볼륨 파일 조회 실패: ${e.message} (직접 /group-volume/... 또는 /user-volume/... 경로를 입력하셔도 됩니다)</span>`;
  }
}

function renderJobsTable(jobs, fleet = latestWorkerFleet) {
  const tbody = document.getElementById("jobsTableBody");
  if (!jobs.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="hint">등록된 자동 실행 규칙이 없습니다.</td></tr>`;
    return;
  }
  const jobFleetMap = new Map();
  if (fleet && Array.isArray(fleet.jobs)) {
    fleet.jobs.forEach((jf) => jobFleetMap.set(jf.jobId, jf));
  }
  tbody.innerHTML = jobs
    .map((j) => {
      const jf = jobFleetMap.get(j.id);
      const activeCnt = jf ? jf.activeCount : "?";
      const targetCnt = j.minConcurrentRuns || 1;
      const remCnt = jf ? jf.remainingToCreate : Math.max(0, targetCnt);
      const fleetBadges = jf
        ? `<div style="margin-top:4px; display:flex; gap:5px; flex-wrap:wrap;">
            <span class="badge ok" style="background:rgba(16,185,129,0.2); color:#6ee7b7;">현재 가동: ${activeCnt}개 / 목표: ${targetCnt}개</span>
            ${
              remCnt > 0
                ? `<span class="badge warn">🔄 +${remCnt}개 자동생성 예정 (${jf.scaleUpIntervalSec || 15}초 간격)</span>`
                : `<span class="badge ok">✅ 목표치 충족</span>`
            }
          </div>`
        : "";
      const badge = j.enabled
        ? `<button class="success sm" style="padding:3px 8px; font-size:11px;" onclick="toggleJobEnabled('${j.id}', false)" title="클릭하면 주기적 자동 추가 생성을 일시정지합니다">🟢 자동생성 ON</button>`
        : `<button class="secondary sm" style="padding:3px 8px; font-size:11px; border-color:rgba(248,113,113,0.5); color:#fca5a5;" onclick="toggleJobEnabled('${j.id}', true)" title="클릭하면 주기적 자동 추가 생성을 활성화합니다 (Admin 자동 승인은 OFF 상태에서도 항상 작동)">⚪ 자동생성 OFF (켜기)</button>`;
      const modeLabel =
        j.mode === "ensure_running"
          ? "항상 실행 유지"
          : j.mode === "when_gpu_free"
          ? "유휴 GPU 감시"
          : "성공 시까지";
      const approvalBadge =
        j.autoApprove !== false
          ? `<span class="badge ok" style="margin-left:4px;">🟢 Admin자동승인 ON</span>`
          : `<span class="badge warn" style="margin-left:4px;">수동승인</span>`;
      const runTypeBadge = j.allowSpot
        ? `<span class="badge warn" style="margin-right:4px;">🟧 Spot</span>`
        : `<span class="badge ok" style="margin-right:4px; background:rgba(59,130,246,0.2); color:#93c5fd;">🟦 Standard</span>`;
      return `
        <tr>
          <td>${badge}</td>
          <td class="mono"><b>${escapeHtml(j.name)}</b></td>
          <td>${modeLabel} (목표 ${targetCnt}개) ${approvalBadge}${fleetBadges}</td>
          <td class="mono">${runTypeBadge}${j.allowSpot ? "" : `Pool:${j.groupPoolId || "-"} / `}Core:${j.coreId || "-"} / x${j.coreCount || 1}</td>
          <td class="mono" style="color:#93c5fd;">${escapeHtml(j.executionCommand)}</td>
          <td style="font-size:12px;">${escapeHtml(j.lastStatus || "대기 중")}</td>
          <td>
            <div class="btn-row">
              <button class="success sm" onclick="triggerJobNow('${j.id}')">▶ +1 즉시 할당+승인</button>
              <button class="secondary sm" onclick='loadJobToForm(${JSON.stringify(j).replace(/'/g, "&#39;")})'>✏️ 수정</button>
              <button class="danger sm" onclick="deleteJob('${j.id}')">삭제</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  if (!window.__initialJobLoaded && jobs[0]) {
    window.__initialJobLoaded = true;
    loadJobToForm(jobs[0]);
  }
}

async function toggleJobEnabled(jobId, enabled) {
  try {
    await api("/api/jobs/toggle", {
      method: "POST",
      body: JSON.stringify({ jobId, enabled }),
    });
    const formId = document.getElementById("jobId")?.value;
    if (formId === jobId) {
      document.getElementById("jobEnabled").checked = Boolean(enabled);
    }
    showToast(
      enabled
        ? "🟢 규칙의 주기적 컨테이너 자동 생성이 켜졌습니다 (ON)!"
        : "⚪ 규칙의 주기적 컨테이너 자동 생성이 일시정지되었습니다 (Admin 자동 승인 루프는 계속 작동합니다)."
    );
    await loadServerState();
  } catch (e) {
    alert("상태 변경 실패: " + e.message);
  }
}

function loadJobToForm(j) {
  document.getElementById("jobId").value = j.id;
  document.getElementById("jobName").value = j.name || "group-vol-worker";
  document.getElementById("jobMode").value = j.mode || "ensure_running";
  document.getElementById("jobUseSpecId").value = j.useSpecId || "";
  document.getElementById("jobMinConcurrent").value = j.minConcurrentRuns || 1;
  document.getElementById("jobGroupPoolId").value = j.groupPoolId || "";
  document.getElementById("jobCoreId").value = j.coreId || "";
  document.getElementById("jobCoreCount").value = j.coreCount || 1;
  document.getElementById("jobQuotaId").value = j.quotaId || "";
  document.getElementById("jobContainerImage").value = j.containerImage || "";
  const imgSel = document.getElementById("selectImage");
  if (imgSel && j.containerImage) imgSel.value = j.containerImage;
  document.getElementById("jobExperimentId").value = j.experimentId || "";
  document.getElementById("jobExpectedRunTime").value = j.expectedRunTime || "8h";
  document.getElementById("jobCooldownSec").value = j.cooldownSec || 10;
  document.getElementById("jobExecutionCommand").value = j.executionCommand || "bash /group-volume/run.sh";
  document.getElementById("jobEnabled").checked = Boolean(j.enabled);
  document.getElementById("jobAutoApprove").checked = j.autoApprove !== false;
  document.getElementById("jobRestartOnSuccess").checked = j.restartOnSuccess !== false;
  document.getElementById("jobRestartOnFail").checked = j.restartOnFail !== false;
  document.getElementById("jobAllowSpot").checked = Boolean(j.allowSpot);
  onChangeRunType(j.allowSpot ? "spot" : "standard", true);
  if (j.coreId) {
    document.getElementById("jobCoreId").value = j.coreId;
    const cSel = document.getElementById("selectCoreId");
    if (cSel) cSel.value = j.coreId;
  }
  document.getElementById("jobEnableWebConsole").checked = j.enableWebConsole !== false;
}

function resetJobForm() {
  loadJobToForm({
    id: "job-" + Date.now(),
    name: "group-vol-worker",
    mode: "ensure_running",
    minConcurrentRuns: 1,
    coreCount: 1,
    expectedRunTime: "8h",
    cooldownSec: 10,
    executionCommand: "bash /group-volume/run.sh",
    enabled: true,
    autoApprove: true,
    restartOnSuccess: true,
    restartOnFail: true,
    allowSpot: false,
    enableWebConsole: true,
  });
  showToast("새 규칙 입력 폼으로 초기화되었습니다.");
}

function collectJobFormPayload() {
  const isSpot =
    document.getElementById("jobRunType")?.value === "spot" ||
    document.getElementById("jobAllowSpot")?.checked;
  return {
    id: document.getElementById("jobId").value || "job-" + Date.now(),
    name: document.getElementById("jobName").value,
    mode: document.getElementById("jobMode").value,
    useSpecId: document.getElementById("jobUseSpecId").value,
    minConcurrentRuns: Number(document.getElementById("jobMinConcurrent").value || 1),
    groupPoolId: document.getElementById("jobGroupPoolId").value,
    coreId: document.getElementById("jobCoreId").value,
    coreCount: Number(document.getElementById("jobCoreCount").value || 1),
    quotaId: document.getElementById("jobQuotaId").value,
    containerImage: document.getElementById("jobContainerImage").value,
    experimentId: document.getElementById("jobExperimentId").value,
    expectedRunTime: document.getElementById("jobExpectedRunTime").value,
    cooldownSec: Number(document.getElementById("jobCooldownSec").value || 10),
    executionCommand: document.getElementById("jobExecutionCommand").value,
    enabled: document.getElementById("jobEnabled").checked,
    autoApprove: document.getElementById("jobAutoApprove").checked,
    restartOnSuccess: document.getElementById("jobRestartOnSuccess").checked,
    restartOnFail: document.getElementById("jobRestartOnFail").checked,
    allowSpot: Boolean(isSpot),
    enableWebConsole: document.getElementById("jobEnableWebConsole").checked,
  };
}

async function saveJobRule() {
  try {
    const payload = collectJobFormPayload();
    await api("/api/jobs", { method: "POST", body: JSON.stringify(payload) });
    showToast(`✅ 실행 명령어 및 규칙이 저장되었습니다! (cmd: ${payload.executionCommand})`);
    await loadServerState();
  } catch (e) {
    alert("규칙 저장 실패: " + e.message);
  }
}

async function deleteJob(id) {
  if (!confirm("이 자동 실행 규칙을 삭제하시겠습니까?")) return;
  await api(`/api/jobs/${id}`, { method: "DELETE" });
  await loadServerState();
}

async function triggerJobNow(jobId) {
  try {
    const formPayload = collectJobFormPayload();
    const targetJobId = jobId || formPayload.id;
    // Always sync the form's latest executionCommand/image/runType if this job is currently open in the form!
    const includeFormData = !jobId || formPayload.id === jobId;
    showToast(
      `🚀 [${includeFormData ? formPayload.executionCommand : targetJobId}] 명령어로 GPU 할당 요청 및 Admin 승인 중...`
    );
    const res = await api("/api/jobs/trigger", {
      method: "POST",
      body: JSON.stringify({
        jobId: targetJobId,
        ...(includeFormData ? { jobData: { ...formPayload, id: targetJobId } } : {}),
      }),
    });
    const appCnt = res.result?.approvalResult?.approvedCount || 0;
    const submittedCmd = res.result?.payload?.executionCommand || "";
    showToast(
      `✅ 실행 제출 완료: ${res.result?.payload?.containerName || ""} [cmd: ${submittedCmd}]${
        appCnt > 0 ? ` (Admin Run-Approval ${appCnt}건 즉시 승인됨!)` : ""
      }`
    );
    await loadServerState();
    await loadSpaceRuns();
    await loadApprovals();
  } catch (e) {
    alert("즉시 실행 실패: " + e.message);
    await loadServerState();
  }
}

async function triggerSchedulerTick() {
  try {
    showToast("⚡ 주기적 체크 루프(Tick + Admin Run-Approval 승인) 수동 실행 중...");
    await api("/api/scheduler/tick", { method: "POST", body: "{}" });
    await loadServerState();
    await loadSpaceRuns();
    await loadApprovals();
    showToast("✅ 주기적 체크 및 Admin Run-Approval 점검 완료!");
  } catch (e) {
    alert("주기 체크 실패: " + e.message);
  }
}

// ============================================================================
// Run-Approval (/run-approval) & TaskOrbit Queue Functions
// ============================================================================
async function loadApprovals() {
  if (!sessionPassword) return;
  const tbody = document.getElementById("approvalsTableBody");
  try {
    const data = await api("/api/space/approvals");
    if (data.schedulerLoopStats) {
      latestSchedulerStats = data.schedulerLoopStats;
    }
    if (data.approvalLoopStats) {
      latestApprovalStats = data.approvalLoopStats;
      renderApprovalLoopStatus(data.approvalLoopStats, serverState?.config || {});
      renderConfig(serverState?.config || {}, data.approvalLoopStats);
    }
    if (Array.isArray(data.autoApprovalTimeline)) {
      latestAutoApprovalTimeline = data.autoApprovalTimeline;
    }
    renderTopAutoStatusBanner();

    if (data.autoApprovedNow > 0) {
      showToast(`⚡ [Admin 자동 승인 루프] 대기 중이던 워크로드 ${data.autoApprovedNow}건이 클릭 없이 즉시 승인되었습니다!`);
    }
    const approvals = data.approvals || [];
    const recentApprovals = data.recentApprovals || [];
    const orbitRuns = data.taskOrbitRuns || [];
    const timeline = latestAutoApprovalTimeline || [];
    const tlByRunId = new Map();
    for (const t of timeline) {
      if (t.runId) tlByRunId.set(String(t.runId), t);
    }

    const rows = [];

    // 1. Pending items from `/taskorbit/api/v1/approvals` (SPACE `/run-approval` page)
    const seenRunIds = new Set();
    const seenApprovalIds = new Set();
    approvals.forEach((item) => {
      if (item.id) seenApprovalIds.add(String(item.id));
      const rId = String(item.runId || "");
      if (rId) seenRunIds.add(rId);
      const tl = tlByRunId.get(rId);
      const resInfo = item.resources || {};
      const resEntries = Object.entries(resInfo)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ");
      const resStr = item.resourceSummary || resEntries || `GPU: ${resInfo.gpu ?? 0}`;
      const reqIso = item.requestedAt || item.createdAt || tl?.autoApprovalRequestedAt || new Date().toISOString();
      rows.push({
        source: "Approvals (/run-approval)",
        approvalId: item.id,
        runId: item.runId || "-",
        runName: item.runName || item.runId || "-",
        user: `${tl?.triggerSource === "auto_scheduler" ? "🤖무클릭자동" : "👆수동"} · ${item.userId || "minsoo3.kim"}`,
        resourceText: resStr,
        requestTimeText: `⚡ ${formatPreciseTime(reqIso, true)} (${formatRelativeAgo(reqIso)})`,
        stageLabel: `⏳ PENDING (자동 승인 처리 중)`,
        isPending: !item.status || String(item.status).toLowerCase() === "pending",
        approvedInfo: "",
      });
    });

    // 2. Items from `/taskorbit/api/v1/runs` (TaskOrbit Queue)
    orbitRuns.forEach((r) => {
      const rId = String(r.runId || r.id || "");
      const stUpper = String(r.status || "").toUpperCase();
      if (seenRunIds.has(rId)) return;
      seenRunIds.add(rId);
      const tl = tlByRunId.get(rId);
      const reqIso = r.createdAt || tl?.autoApprovalRequestedAt || tl?.createdAt || null;
      const doneIso = tl?.approvedAt || null;
      rows.push({
        source: `TaskOrbit (${r.podClass || "standard"})`,
        approvalId: null,
        runId: rId,
        runName: r.runName || r.name || rId,
        user: `${tl?.triggerSource === "auto_scheduler" ? "🤖무클릭자동" : "👆수동"} · ${r.userId || "minsoo3.kim"}`,
        resourceText: r.resourceSummary || r.resourceProfile || r.coreName || `Priority: ${r.priorityValue ?? "Spot/Express"}`,
        requestTimeText: reqIso ? `⚡ ${formatPreciseTime(reqIso, true)}` : "-",
        stageLabel: stUpper === "PENDING" ? "⏳ PENDING" : `✅ ${stUpper}`,
        isPending: stUpper === "PENDING",
        approvedInfo: doneIso ? `✅ ${formatPreciseTime(doneIso, true)} (${tl?.approvalElapsedSec ?? 1.2}초 소요)` : "승인 통과됨",
      });
    });

    // 3. Recently approved items from `/taskorbit/api/v1/approvals` + `autoApprovalTimeline`
    recentApprovals.slice(0, 20).forEach((item) => {
      if (!item || (item.id && seenApprovalIds.has(String(item.id)))) return;
      const rId = String(item.runId || "");
      if (rId && seenRunIds.has(rId)) return;
      if (rId) seenRunIds.add(rId);
      const stLower = String(item.status || "").toLowerCase();
      if (stLower === "pending") return;
      const tl = tlByRunId.get(rId);
      const resInfo = item.resources || {};
      const resEntries = Object.entries(resInfo)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ");
      const resStr = item.resourceSummary || resEntries || `GPU×${tl?.coreCount || 4}`;
      const reqIso = item.requestedAt || item.createdAt || tl?.autoApprovalRequestedAt || tl?.createdAt || item.approvedAt;
      const doneIso = item.approvedAt || tl?.approvedAt;
      rows.push({
        source: "Approvals (/run-approval)",
        approvalId: item.id ? String(item.id).slice(0, 8) : null,
        runId: item.runId || "-",
        runName: item.runName || tl?.runName || item.runId || "-",
        user: `${tl?.triggerSource === "auto_scheduler" ? "🤖무클릭자동" : "👆수동신청"} · ${item.userId || "minsoo3.kim"}`,
        resourceText: resStr,
        requestTimeText: reqIso ? `⚡ ${formatPreciseTime(reqIso, true)} (${formatRelativeAgo(reqIso)})` : "-",
        stageLabel: stLower === "approved" ? "✅ APPROVED" : stLower.toUpperCase(),
        isPending: false,
        approvedInfo: `✅ ${formatPreciseTime(doneIso, true)} (${tl?.approvalElapsedSec ?? 1.4}초 소요 · ${item.approvedBy || "Admin 자동승인"})`,
      });
    });

    timeline.slice(0, 20).forEach((tl) => {
      const rId = String(tl.runId || "");
      if (!rId || rId === "-" || seenRunIds.has(rId)) return;
      seenRunIds.add(rId);
      const reqIso = tl.autoApprovalRequestedAt || tl.createdAt || tl.allocationRequestedAt;
      const doneIso = tl.approvedAt;
      rows.push({
        source: "Auto-Approval 루프",
        approvalId: tl.approvalId ? String(tl.approvalId).slice(0, 8) : null,
        runId: rId,
        runName: tl.runName || `Run #${rId}`,
        user: `${tl.triggerSource === "auto_scheduler" ? "🤖무클릭자동" : "👆수동신청"} · ${tl.approvedBy || "minsoo3.kim"}`,
        resourceText: `H100 GPU×${tl.coreCount || 4}`,
        requestTimeText: reqIso ? `⚡ ${formatPreciseTime(reqIso, true)} (${formatRelativeAgo(reqIso)})` : "-",
        stageLabel: "✅ APPROVED",
        isPending: false,
        approvedInfo: `✅ ${formatPreciseTime(doneIso, true)} (${tl.approvalElapsedSec ?? 1.4}초 만에 무클릭 승인 완료)`,
      });
    });

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="hint">현재 승인 대기 중(PENDING)이거나 최근 승인 내역이 없습니다.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .slice(0, 25)
      .map((row) => {
        const actionBtns = row.isPending
          ? `<div class="btn-row">
              <button class="success sm" onclick="approveSingleItem('${row.approvalId || ""}', '${escapeHtml(row.runId)}')">✅ Admin 승인(Approve)</button>
              <button class="danger sm" onclick="rejectSingleItem('${row.approvalId || ""}', '${escapeHtml(row.runId)}')">❌ 반려(Reject)</button>
            </div>`
          : `<span class="mono" style="color:#6ee7b7; font-weight:700; font-size:12px;">${escapeHtml(row.approvedInfo || "승인 통과됨")}</span>`;
        return `
          <tr>
            <td class="mono">${escapeHtml(row.source)}${row.approvalId ? ` (#${row.approvalId})` : ""}</td>
            <td class="mono"><b>${escapeHtml(row.runName)}</b><br/><span class="hint">#${escapeHtml(row.runId)}</span></td>
            <td class="mono">${escapeHtml(row.user)}</td>
            <td class="mono">${escapeHtml(row.resourceText)}</td>
            <td class="mono" style="color:#fde68a; font-weight:700;">${escapeHtml(row.requestTimeText || "-")}</td>
            <td>${actionBtns}</td>
          </tr>
        `;
      })
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="hint" style="color:#f87171;">승인 대기 목록 조회 실패: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function approveSingleItem(approvalId, runId) {
  try {
    await api("/api/space/approvals/approve", {
      method: "POST",
      body: JSON.stringify({
        approvalId: approvalId || undefined,
        runId: runId && runId !== "-" ? runId : undefined,
      }),
    });
    showToast(`✅ Admin 승인 완료! (${approvalId ? "Approval #" + approvalId : "Run #" + runId})`);
    await loadApprovals();
    await loadSpaceRuns();
    await loadServerState();
  } catch (e) {
    alert("승인 요청 실패: " + e.message);
  }
}

async function rejectSingleItem(approvalId, runId) {
  const reason = prompt("반려 사유(Reason)를 입력하세요:", "Rejected by admin");
  if (reason === null) return;
  try {
    await api("/api/space/approvals/reject", {
      method: "POST",
      body: JSON.stringify({
        approvalId: approvalId || undefined,
        runId: runId && runId !== "-" ? runId : undefined,
        reason,
      }),
    });
    showToast(`🛑 반려 처리 완료`);
    await loadApprovals();
    await loadSpaceRuns();
    await loadServerState();
  } catch (e) {
    alert("반려 요청 실패: " + e.message);
  }
}

async function approveAllPending() {
  try {
    showToast("⚡ 승인 대기 중인 모든 워크로드 Admin 일괄 승인 요청 중...");
    const res = await api("/api/space/approvals/approve", {
      method: "POST",
      body: JSON.stringify({ approveAll: true }),
    });
    showToast(`✅ 총 ${res.approvedCount || 0}건의 승인 대기 워크로드가 Admin 승인되었습니다.`);
    await loadApprovals();
    await loadSpaceRuns();
    await loadServerState();
  } catch (e) {
    alert("일괄 승인 실패: " + e.message);
  }
}

async function loadSpaceRuns() {
  if (!sessionPassword) return;
  const tbody = document.getElementById("runsTableBody");
  try {
    const data = await api("/api/space/runs");
    if (data.workerFleet) {
      latestWorkerFleet = data.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet);
      if (serverState?.jobs) {
        renderJobsTable(serverState.jobs, latestWorkerFleet);
      }
    }
    const runs = data.runs || [];
    if (!runs.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="hint">현재 조회된 WLM 워크로드(Run)가 없습니다.</td></tr>`;
      return;
    }
    tbody.innerHTML = runs
      .slice(0, 30)
      .map((r) => {
        const id = r.id ?? r.runId;
        const name = r.containerName ?? r.name ?? `run-${id}`;
        const st = String(r.status ?? r.state ?? r.phase ?? "UNKNOWN");
        const stUpper = st.toUpperCase();
        const isAlreadyApproved = String(r.approvalStatus || "").toLowerCase() === "approved";
        let cls = "badge";
        if (stUpper.includes("PENDING") && !isAlreadyApproved) cls = "badge warn";
        else if (["RUNNING", "CREATING", "STAGING", "APPROVED", "ADMITTED", "SCHEDULED"].some((k) => stUpper.includes(k)) || isAlreadyApproved) cls = "badge ok";
        else if (["FAILED", "ERROR", "STOPPED", "KILLED", "REJECTED"].some((k) => stUpper.includes(k))) cls = "badge err";
        const displayStatus =
          stUpper.includes("PENDING") && isAlreadyApproved ? `${st} (✅ Admin 승인됨 · 시작 중)` : st;
        const gpuInfo = `${r.coreName || r.gpuName || r.coreId || "-"} x${r.coreCount ?? r.coreNum ?? 1}`;
        const cmd = r.executionCommand || r.execCommand || r.containerImage || "-";
        const reasonText = r.reason ? `<div class="hint" style="margin-top:2px; font-size:11px; color:${cls.includes("err") ? "#f87171" : "var(--muted)"};">${escapeHtml(r.reason)}</div>` : "";
        const approveBtn =
          stUpper.includes("PENDING") && !isAlreadyApproved
            ? `<button class="success sm" onclick="approveSingleItem('', '${escapeHtml(String(id))}')">✅ Admin 승인</button>`
            : "";
        return `
          <tr>
            <td class="mono">#${id}</td>
            <td class="mono"><b>${escapeHtml(name)}</b></td>
            <td><span class="${cls}">${escapeHtml(displayStatus)}</span>${reasonText}</td>
            <td class="mono">${escapeHtml(gpuInfo)}</td>
            <td class="mono" style="max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(cmd)}">${escapeHtml(cmd)}</td>
            <td>
              <div class="btn-row">
                ${approveBtn}
                <button class="secondary sm" onclick="viewRunLog('${id}', '${escapeHtml(name)}')">📜 로그 보기</button>
                <button class="danger sm" onclick="stopRun('${id}')">중지</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="hint" style="color:#f87171;">런 목록 조회 오류: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function viewRunLog(runId, name) {
  currentLogRunId = runId;
  document.getElementById("logViewerTitle").textContent = `📜 컨테이너 실시간 로그 — #${runId} (${name || ""})`;
  const box = document.getElementById("runLogBox");
  box.textContent = "로그 불러오는 중...";
  try {
    const res = await api(`/api/space/runs/${runId}/log`);
    box.textContent = res.log || "(출력된 로그가 없습니다)";
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    box.textContent = `로그 조회 실패: ${e.message}`;
  }
}

function refreshCurrentRunLog() {
  if (!currentLogRunId) return showToast("먼저 런 목록에서 [로그 보기]를 선택하세요.");
  viewRunLog(currentLogRunId, "");
}

async function stopRun(runId) {
  if (!confirm(`Run #${runId} 워크로드를 강제 중지하시겠습니까?`)) return;
  try {
    await api(`/api/space/runs/${runId}/stop`, { method: "POST", body: "{}" });
    showToast(`🛑 Run #${runId} 중지 요청 완료`);
    await loadSpaceRuns();
    await loadServerState();
  } catch (e) {
    alert("중지 실패: " + e.message);
  }
}

function renderHistoryTable(history) {
  const tbody = document.getElementById("historyTableBody");
  if (!history.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="hint">아직 기록된 스케줄러 이벤트가 없습니다.</td></tr>`;
    return;
  }
  tbody.innerHTML = history
    .map((h) => {
      const lvl = String(h.level || "info").toUpperCase();
      const cls = lvl === "ERROR" ? "badge err" : lvl === "WARN" ? "badge warn" : "badge ok";
      const timeStr = h.time ? new Date(h.time).toLocaleString("ko-KR") : "-";
      return `
        <tr>
          <td class="mono" style="font-size:11px; color:var(--muted);">${escapeHtml(timeStr)}</td>
          <td><span class="${cls}">${lvl}</span></td>
          <td style="font-size:12px;">${escapeHtml(h.message)}</td>
        </tr>
      `;
    })
    .join("");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Always start locked on every visit / page refresh and focus password input
window.addEventListener("DOMContentLoaded", () => {
  lockDashboard();
});
