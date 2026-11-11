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

let bgRefreshTickCounter = 0;
let lastKnownPendingApprovals = 0;
let lastKnownActiveWorkerIdsSig = "";

function applyUiRefreshInterval(sec) {
  const cleanSec = Math.max(2, Math.min(600, Number(sec || 5)));
  if (uiRefreshTimer && currentUiRefreshSec === cleanSec) return;
  currentUiRefreshSec = cleanSec;
  if (uiRefreshTimer) clearInterval(uiRefreshTimer);
  uiRefreshTimer = setInterval(async () => {
    if (!sessionPassword) return;
    bgRefreshTickCounter += 1;
    await loadServerState({ background: true });
    // Avoid redundant back-to-back DOM redraws: /api/state already includes approvalLoopStats & timeline.
    // Only poll /api/space/approvals or /api/space/runs when pending approvals exist, active runs changed, or every 3rd tick.
    if (lastKnownPendingApprovals > 0 || bgRefreshTickCounter % 3 === 0) {
      loadApprovals({ background: true });
    }
  }, cleanSec * 1000);
}

let currentSiteId = localStorage.getItem("space_active_site_id") || "n9";
let sitesList = [
  {
    id: "n9",
    name: "SPACE N9 (H100 클러스터)",
    gpuModel: "H100",
    portalUrl: "https://space.n9.sr-cloud.com",
    baseUrl: "https://mlp.n9.sr-cloud.com",
    sfmUrl: "https://sfsm.n9.sr-cloud.com",
  },
  {
    id: "n6",
    name: "SPACE N6 (A100 클러스터)",
    gpuModel: "A100",
    portalUrl: "https://space.n6.sr-cloud.com",
    baseUrl: "https://mlp.n6.sr-cloud.com",
    sfmUrl: "https://sfsm.n6.sr-cloud.com",
  },
];

function getActiveSiteProfile(siteId = currentSiteId) {
  const found = (sitesList || []).find((s) => s.id === siteId);
  if (found) return found;
  if (siteId === "n6") {
    return {
      id: "n6",
      name: "SPACE N6 (A100 클러스터)",
      gpuModel: "A100",
      portalUrl: "https://space.n6.sr-cloud.com",
      baseUrl: "https://mlp.n6.sr-cloud.com",
      sfmUrl: "https://sfsm.n6.sr-cloud.com",
    };
  }
  return {
    id: siteId || "n9",
    name: `SPACE ${(siteId || "n9").toUpperCase()} (${siteId === "n6" ? "A100" : "H100"} 클러스터)`,
    gpuModel: siteId === "n6" ? "A100" : "H100",
    portalUrl: `https://space.${siteId || "n9"}.sr-cloud.com`,
    baseUrl: `https://mlp.${siteId || "n9"}.sr-cloud.com`,
    sfmUrl: `https://sfsm.${siteId || "n9"}.sr-cloud.com`,
  };
}

function getActiveGpuModel(siteId = currentSiteId) {
  return getActiveSiteProfile(siteId).gpuModel || (siteId === "n6" ? "A100" : "H100");
}

function getActiveSiteHost(siteId = currentSiteId) {
  const portal = getActiveSiteProfile(siteId).portalUrl || `https://space.${siteId || "n9"}.sr-cloud.com`;
  return portal.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

async function selectSpaceSite(siteId, options = {}) {
  const target = String(siteId || "n9").trim().toLowerCase();
  if (!target) return;
  currentSiteId = target;
  try {
    localStorage.setItem("space_active_site_id", currentSiteId);
  } catch {}
  focusedFleetJobId = "";
  lastKnownActiveWorkerIdsSig = "";
  try {
    await api("/api/sites/select", {
      method: "POST",
      body: JSON.stringify({ siteId: currentSiteId }),
    });
  } catch {}
  if (!options.silent) {
    const prof = getActiveSiteProfile(currentSiteId);
    showToast(`🌐 관리 사이트 전환: ${prof.name} (${prof.gpuModel})`);
  }
  await loadServerState();
  const firstJob = (serverState?.jobs || [])[0];
  if (firstJob) {
    loadJobToForm(firstJob, false, false);
  } else {
    startNewJobRule();
  }
  if (serverState?.config?.hasAccessToken) {
    discoverSpaceResources({ silent: true });
    loadApprovals({ background: true });
    loadSpaceRuns({ background: true });
  } else {
    discovered = { groups: [], groupPools: [], groupPoolsStatus: [], spotCores: [], priorities: [], experiments: [], specifications: [], images: [] };
    const runsBody = document.getElementById("runsTableBody");
    if (runsBody) {
      runsBody.innerHTML = `<tr><td colspan="6" class="hint">${getActiveSiteProfile().name} 토큰이 아직 설정되지 않았습니다. [🔑 SPACE 토큰 연동/갱신]에서 ${getActiveSiteHost()} 토큰을 등록해 주세요.</td></tr>`;
    }
  }
}

async function promptAddCustomSite() {
  const idInput = prompt("추가할 SPACE 클러스터 ID를 입력하세요 (예: n6, n7, n8, n10):", "n6");
  if (!idInput || !idInput.trim()) return;
  const cleanId = idInput.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!cleanId) return;
  const defaultGpu = cleanId === "n6" ? "A100" : "H100";
  const gpuModelInput = prompt(`해당 사이트(${cleanId.toUpperCase()})의 기본 GPU 모델명을 입력하세요 (예: A100, H100, H200, L40S):`, defaultGpu);
  if (gpuModelInput === null) return;
  const gpuModel = (gpuModelInput || defaultGpu).trim().toUpperCase();
  const nameInput = prompt(`사이트 표시 이름을 입력하세요:`, `SPACE ${cleanId.toUpperCase()} (${gpuModel} 클러스터)`);
  if (nameInput === null) return;
  try {
    await api("/api/sites", {
      method: "POST",
      body: JSON.stringify({
        id: cleanId,
        name: nameInput.trim() || `SPACE ${cleanId.toUpperCase()} (${gpuModel} 클러스터)`,
        gpuModel,
        portalUrl: `https://space.${cleanId}.sr-cloud.com`,
        baseUrl: `https://mlp.${cleanId}.sr-cloud.com`,
        sfmUrl: `https://sfsm.${cleanId}.sr-cloud.com`,
      }),
    });
    showToast(`✅ 신규 사이트 추가 완료: SPACE ${cleanId.toUpperCase()} (${gpuModel})`);
    await selectSpaceSite(cleanId, { silent: true });
  } catch (e) {
    alert("사이트 추가 실패: " + e.message);
  }
}

function renderMultiSiteSwitcherBar(sites = sitesList, activeId = currentSiteId) {
  const tabsEl = document.getElementById("multiSiteTabsContainer");
  const badgeEl = document.getElementById("activeSiteSummaryBadge");
  const tokenBtnsEl = document.getElementById("tokenSiteQuickButtons");
  const tokenTargetNameEl = document.getElementById("tokenTargetSiteName");
  const hostLabelEl = document.getElementById("authSiteHostLabel");
  const consoleLinkEl = document.getElementById("spaceConsoleQuickLink");

  const activeProf = getActiveSiteProfile(activeId);
  if (badgeEl) {
    badgeEl.innerHTML = `현재 사이트: <b>${escapeHtml(activeProf.name)}</b> · 기본 GPU: <b>${escapeHtml(activeProf.gpuModel)}</b>`;
  }
  if (tokenTargetNameEl) {
    tokenTargetNameEl.textContent = `${activeProf.name} (${activeProf.gpuModel})`;
  }
  if (hostLabelEl) {
    hostLabelEl.textContent = getActiveSiteHost(activeId);
  }
  if (consoleLinkEl) {
    consoleLinkEl.href = `${activeProf.portalUrl || `https://space.${activeId}.sr-cloud.com`}/console/home`;
    consoleLinkEl.textContent = `🔗 SPACE ${activeId.toUpperCase()} (${activeProf.gpuModel}) 콘솔 열기`;
  }

  if (tabsEl && Array.isArray(sites) && sites.length > 0) {
    const sig = sites
      .map((s) => `${s.id}:${s.id === activeId}:${s.tokenValid}:${s.hasAccessToken}:${s.activeRunsCount}:${s.runningRunsCount}:${s.enabledJobCount}:${s.totalTargetWorkers}`)
      .join("|");
    const html =
      `<span style="font-size:13px; font-weight:800; color:#6ee7b7; margin-right:4px;">🌐 관리 대상 SPACE 사이트:</span>` +
      sites
        .map((s) => {
          const isCurrent = s.id === activeId;
          const tokenDot = s.tokenValid ? "🟢" : s.hasAccessToken ? "🚨만료" : "⚪미등록";
          const workerInfo =
            s.activeRunsCount > 0 || s.enabledJobCount > 0
              ? ` · 워커 ${s.runningRunsCount || 0}/${s.totalTargetWorkers || 0}`
              : "";
          const bg = isCurrent
            ? s.gpuModel === "A100"
              ? "linear-gradient(135deg, #059669, #047857)"
              : "linear-gradient(135deg, #2563eb, #1d4ed8)"
            : "rgba(30,41,59,0.88)";
          const border = isCurrent ? (s.gpuModel === "A100" ? "#34d399" : "#60a5fa") : "rgba(148,163,184,0.35)";
          return `<button
            type="button"
            onclick="selectSpaceSite('${escapeHtml(s.id)}')"
            style="padding:8px 14px; font-size:13px; font-weight:800; border-radius:8px; background:${bg}; border:1.5px solid ${border}; color:${isCurrent ? "#fff" : "#cbd5e1"}; box-shadow:${isCurrent ? "0 4px 12px rgba(0,0,0,0.35)" : "none"};"
          >
            ${s.gpuModel === "A100" ? "⚡" : "🚀"} SPACE ${escapeHtml(s.id.toUpperCase())} (${escapeHtml(s.gpuModel)})
            <span class="mono" style="margin-left:5px; font-size:11px; padding:1px 6px; border-radius:999px; background:rgba(15,23,42,0.5); color:${s.tokenValid ? "#a7f3d0" : "#fde68a"};">
              ${tokenDot}${workerInfo}
            </span>
          </button>`;
        })
        .join("");
    updateHtmlIfSigChanged(tabsEl, sig, html);
  }

  if (tokenBtnsEl && Array.isArray(sites) && sites.length > 0) {
    const btnSig = sites.map((s) => `${s.id}:${s.id === activeId}:${s.tokenValid}:${s.hasAccessToken}`).join("|");
    const btnHtml = sites
      .map((s) => {
        const isCurrent = s.id === activeId;
        const stLabel = s.tokenValid
          ? `🟢인증됨(${Math.max(1, Math.floor((s.jwtInfo?.remainingSec || 60) / 60))}m)`
          : s.hasAccessToken
          ? "🚨만료됨"
          : "⚪미설정";
        return `<button
          type="button"
          class="${isCurrent ? "sm" : "secondary sm"}"
          onclick="selectSpaceSite('${escapeHtml(s.id)}')"
          style="padding:4px 10px; font-size:11.5px; font-weight:700; ${isCurrent ? "background:#2563eb; border-color:#60a5fa; color:#fff;" : ""}"
        >
          ${escapeHtml(s.id.toUpperCase())} (${escapeHtml(s.gpuModel)}) 토큰: ${stLabel}
        </button>`;
      })
      .join("");
    updateHtmlIfSigChanged(tokenBtnsEl, btnSig, btnHtml);
  }
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Admin-Password": sessionPassword,
    "X-Site-Id": currentSiteId,
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
let latestLoadMonitor = null;
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

let lastSeenAlertId = null;

function maybeTriggerBrowserAlert(alerts, cfg) {
  if (!Array.isArray(alerts) || alerts.length === 0) return;
  const newest = alerts[0];
  if (!newest || !newest.id) return;
  if (lastSeenAlertId === null) {
    lastSeenAlertId = newest.id;
    return;
  }
  if (newest.id === lastSeenAlertId) return;
  lastSeenAlertId = newest.id;

  showToast(`🔔 [${newest.title}] ${newest.message}`);
  if (cfg?.browserNotifyEnabled !== false && "Notification" in window) {
    if (Notification.permission === "granted") {
      try {
        new Notification(`SPACE GPU: ${newest.title}`, { body: newest.message });
      } catch {
        // ignore
      }
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().catch(() => {});
    }
  }
}

async function loadServerState(options = {}) {
  if (!sessionPassword) return;
  try {
    const data = await api("/api/state");
    serverState = data;
    if (data.sites) {
      const rawSitesArr = Array.isArray(data.sites) ? data.sites : Object.values(data.sites);
      if (rawSitesArr.length > 0) {
        sitesList = rawSitesArr.map((s) => ({
          ...s,
          tokenValid:
            s.tokenValid !== undefined
              ? Boolean(s.tokenValid)
              : Boolean(s.hasAccessToken && (!s.jwtInfo || !s.jwtInfo.expired)),
          activeRunsCount: s.activeWorkers ?? s.activeRunsCount ?? 0,
          runningRunsCount: s.runningWorkers ?? s.runningRunsCount ?? 0,
          totalTargetWorkers: s.targetWorkers ?? s.totalTargetWorkers ?? 0,
        }));
      }
    }
    if (data.activeSiteId) {
      currentSiteId = data.activeSiteId;
    }
    renderMultiSiteSwitcherBar(sitesList, currentSiteId);
    if (data.workerFleet) {
      latestWorkerFleet = data.workerFleet;
    }
    if (data.schedulerLoopStats) {
      latestSchedulerStats = data.schedulerLoopStats;
    }
    if (data.approvalLoopStats) {
      latestApprovalStats = data.approvalLoopStats;
      lastKnownPendingApprovals = Number(data.approvalLoopStats.pendingCount || 0);
    }
    if (Array.isArray(data.autoApprovalTimeline)) {
      latestAutoApprovalTimeline = data.autoApprovalTimeline;
    } else if (Array.isArray(data.workerFleet?.autoApprovalTimeline)) {
      latestAutoApprovalTimeline = data.workerFleet.autoApprovalTimeline;
    }
    if (data.loadMonitor || data.workerFleet?.loadMonitor) {
      latestLoadMonitor = data.loadMonitor || data.workerFleet?.loadMonitor;
    }
    maybeTriggerBrowserAlert(data.alerts || data.workerFleet?.notifications?.alerts || [], data.config);
    renderTopAutoStatusBanner();
    renderConfig(data.config, data.approvalLoopStats);
    renderApprovalLoopStatus(data.approvalLoopStats, data.config);
    renderPresetsBar(data.presets || latestWorkerFleet?.presets || []);
    renderWorkerFleetBoard(latestWorkerFleet);
    renderJobsTable(data.jobs || [], latestWorkerFleet);
    renderHistoryTable(data.history || []);
    applyUiRefreshInterval(data.config?.uiRefreshIntervalSec || 5);

    // If active worker IDs or statuses changed during background poll, sync the bottom runs table calmly
    const activeSig = (latestWorkerFleet?.jobs || [])
      .map((j) => (j.activeWorkers || []).map((w) => `${w.id}:${w.status}`).join(","))
      .join(";");
    if (activeSig !== lastKnownActiveWorkerIdsSig) {
      const wasInitial = lastKnownActiveWorkerIdsSig === "";
      lastKnownActiveWorkerIdsSig = activeSig;
      if (!wasInitial && options.background && data.config?.hasAccessToken) {
        loadSpaceRuns({ background: true });
      }
    }

    if (!window._initialEditorLoaded) {
      window._initialEditorLoaded = true;
      openSfmScriptEditor(undefined, { silent: true }).catch(() => {});
    }
  } catch (e) {
    console.error(e);
  }
}

let focusedFleetJobId = "";
let currentMainView = "monitor";

function switchMainView(view = "monitor", targetSection = "") {
  currentMainView = view === "setup" ? "setup" : "monitor";
  const monEl = document.getElementById("viewMonitorSection");
  const setEl = document.getElementById("viewSetupSection");
  const btnMon = document.getElementById("tabBtnMonitor");
  const btnSet = document.getElementById("tabBtnSetup");

  if (monEl) monEl.style.display = currentMainView === "monitor" ? "block" : "none";
  if (setEl) setEl.style.display = currentMainView === "setup" ? "block" : "none";

  if (btnMon && btnSet) {
    if (currentMainView === "monitor") {
      btnMon.style.background = "linear-gradient(135deg, #2563eb, #1d4ed8)";
      btnMon.style.borderColor = "#60a5fa";
      btnMon.style.color = "#fff";
      btnMon.style.boxShadow = "0 4px 14px rgba(37,99,235,0.4)";

      btnSet.style.background = "rgba(30,41,59,0.85)";
      btnSet.style.borderColor = "rgba(148,163,184,0.35)";
      btnSet.style.color = "#cbd5e1";
      btnSet.style.boxShadow = "none";
    } else {
      btnSet.style.background = "linear-gradient(135deg, #2563eb, #1d4ed8)";
      btnSet.style.borderColor = "#60a5fa";
      btnSet.style.color = "#fff";
      btnSet.style.boxShadow = "0 4px 14px rgba(37,99,235,0.4)";

      btnMon.style.background = "rgba(30,41,59,0.85)";
      btnMon.style.borderColor = "rgba(148,163,184,0.35)";
      btnMon.style.color = "#cbd5e1";
      btnMon.style.boxShadow = "none";
    }
  }

  if (currentMainView === "setup" && targetSection) {
    setTimeout(() => {
      if (targetSection === "auth") {
        const el = document.getElementById("authConfigCard");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        const pasteBox = document.getElementById("quickPasteJson");
        if (pasteBox) pasteBox.focus();
      } else if (targetSection === "rules") {
        const el = document.getElementById("rulesConfigCard");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (targetSection === "form") {
        const el = document.getElementById("jobRuleFormBox");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 50);
  }
}

function openNewJobRuleInSetup() {
  switchMainView("setup", "form");
  startNewJobRule();
}

function editJobRuleInSetup(jobId) {
  switchMainView("setup", "form");
  selectAndEditJobRule(jobId, true);
}

function getFocusedJobFleet(fleet = latestWorkerFleet) {
  const jobs = Array.isArray(fleet?.jobs) ? fleet.jobs : [];
  if (jobs.length === 0) {
    return (serverState?.jobs && serverState.jobs[0]) || {};
  }
  if (focusedFleetJobId) {
    const matched = jobs.find((j) => String(j.jobId || j.id) === String(focusedFleetJobId));
    if (matched) return matched;
  }
  const activeEnabled = jobs.find((j) => j.enabled && (j.activeCount || 0) > 0);
  if (activeEnabled) return activeEnabled;
  const firstEnabled = jobs.find((j) => j.enabled);
  if (firstEnabled) return firstEnabled;
  const anyActive = jobs.find((j) => (j.activeCount || 0) > 0);
  return anyActive || jobs[0];
}

function selectFleetJobTab(jobId) {
  if (!jobId) return;
  focusedFleetJobId = String(jobId);
  const jobObj = (serverState?.jobs || []).find((j) => String(j.id) === String(jobId));
  if (jobObj) {
    loadJobToForm(jobObj, false, false);
  } else {
    if (latestWorkerFleet) renderWorkerFleetBoard(latestWorkerFleet, { force: true });
    renderTopAutoStatusBanner();
  }
}

// ============================================================================
// Anti-Flicker / Partial DOM Diffing & Slot Hover-Freeze State
// ============================================================================
let isSlotBoardFrozen = false; // Manual freeze toggle button
let autoFreezeOnSlotHover = true; // Auto-freeze slot grid while mouse cursor is over #wfSlotPillsGrid
let isMouseOverSlotGrid = false;
let isMouseOverRunsTable = false;
let pendingSlotItemsBuffer = null;

function updateHtmlIfSigChanged(el, sig, html) {
  if (!el) return false;
  const sigStr = String(sig ?? "");
  if (el.getAttribute("data-render-sig") === sigStr) {
    return false;
  }
  el.setAttribute("data-render-sig", sigStr);
  el.innerHTML = html;
  return true;
}

function setSlotGridHover(isHovering) {
  const nextVal = Boolean(isHovering);
  if (isMouseOverSlotGrid === nextVal) return;
  isMouseOverSlotGrid = nextVal;
  const badgeEl = document.getElementById("wfSlotFreezeStatusBadge");
  if (badgeEl) {
    if (isSlotBoardFrozen) {
      badgeEl.style.display = "inline-flex";
      badgeEl.textContent = "🔒 슬롯 화면 수동 고정 중";
    } else if (autoFreezeOnSlotHover && isMouseOverSlotGrid) {
      badgeEl.style.display = "inline-flex";
      badgeEl.textContent = "⏸️ 마우스 올림 — 슬롯 움직임 일시 고정됨";
    } else {
      badgeEl.style.display = "none";
    }
  }
  // When mouse leaves the slot grid and manual freeze is off, flush any buffered slot updates cleanly in-place
  if (!isMouseOverSlotGrid && !isSlotBoardFrozen && pendingSlotItemsBuffer) {
    const gridEl = document.getElementById("wfSlotPillsGrid");
    if (gridEl) {
      patchSlotPillsGrid(gridEl, pendingSlotItemsBuffer, true);
    }
    pendingSlotItemsBuffer = null;
  }
}

function toggleAutoFreezeOnSlotHover(checked) {
  autoFreezeOnSlotHover = Boolean(checked);
  if (!autoFreezeOnSlotHover && !isSlotBoardFrozen && pendingSlotItemsBuffer) {
    const gridEl = document.getElementById("wfSlotPillsGrid");
    if (gridEl) patchSlotPillsGrid(gridEl, pendingSlotItemsBuffer, true);
    pendingSlotItemsBuffer = null;
  }
  renderWorkerFleetBoard(latestWorkerFleet, { force: true });
}

function toggleSlotBoardFreeze(forceState) {
  if (typeof forceState === "boolean") {
    isSlotBoardFrozen = forceState;
  } else {
    isSlotBoardFrozen = !isSlotBoardFrozen;
  }
  showToast(
    isSlotBoardFrozen
      ? "🔒 슬롯 화면이 고정되었습니다. (해제 전까지 슬롯 재배치가 멈춥니다)"
      : "🔓 슬롯 화면 고정이 해제되어 최신 상태가 반영되었습니다."
  );
  renderWorkerFleetBoard(latestWorkerFleet, { force: true });
}

function patchSlotPillsGrid(gridEl, slotItems, forceRender = false) {
  if (!gridEl || !Array.isArray(slotItems)) return;
  if (!forceRender && (isSlotBoardFrozen || (autoFreezeOnSlotHover && isMouseOverSlotGrid))) {
    pendingSlotItemsBuffer = slotItems;
    return;
  }
  pendingSlotItemsBuffer = null;

  const fullGridSig = slotItems.map((it) => `${it.key}:${it.sig}`).join("||");
  if (gridEl.getAttribute("data-grid-sig") === fullGridSig) {
    return; // Zero changes across all slots -> 0 DOM mutations!
  }
  gridEl.setAttribute("data-grid-sig", fullGridSig);

  const prevScrollTop = gridEl.scrollTop;
  const existingMap = new Map();
  for (const child of Array.from(gridEl.children)) {
    const k = child.getAttribute("data-slot-key");
    if (k) existingMap.set(k, child);
  }

  const desiredKeys = new Set(slotItems.map((it) => it.key));
  // Remove stale slot elements no longer in the list
  for (const [k, node] of existingMap.entries()) {
    if (!desiredKeys.has(k)) {
      node.remove();
      existingMap.delete(k);
    }
  }

  // Patch or insert each slot in exact order while keeping unchanged DOM nodes 100% intact
  slotItems.forEach((item, idx) => {
    let node = existingMap.get(item.key);
    if (!node) {
      const temp = document.createElement("div");
      temp.innerHTML = item.html.trim();
      node = temp.firstElementChild;
      if (!node) return;
      node.setAttribute("data-slot-key", item.key);
      node.setAttribute("data-slot-sig", item.sig);
      const refNode = gridEl.children[idx] || null;
      gridEl.insertBefore(node, refNode);
      existingMap.set(item.key, node);
    } else {
      if (node.getAttribute("data-slot-sig") !== item.sig) {
        const temp = document.createElement("div");
        temp.innerHTML = item.html.trim();
        const newNode = temp.firstElementChild;
        if (newNode) {
          newNode.setAttribute("data-slot-key", item.key);
          newNode.setAttribute("data-slot-sig", item.sig);
          node.replaceWith(newNode);
          node = newNode;
          existingMap.set(item.key, node);
        }
      }
      const currentAtIdx = gridEl.children[idx];
      if (currentAtIdx !== node) {
        gridEl.insertBefore(node, currentAtIdx || null);
      }
    }
  });

  if (prevScrollTop > 0) {
    gridEl.scrollTop = prevScrollTop;
  }
}

function renderTopAutoStatusBanner() {
  const banner = document.getElementById("topAutoStatusBanner");
  if (!banner) return;
  if (document.activeElement?.id === "topQuickTargetInput") return;

  const cfg = serverState?.config || {};
  const fleet = latestWorkerFleet || {};
  const jf = getFocusedJobFleet(fleet);
  const schedStats = latestSchedulerStats || {};
  const appStats = latestApprovalStats || {};
  const timeline = latestAutoApprovalTimeline || [];
  const lm = latestLoadMonitor || fleet.loadMonitor || {};
  const lmApi = lm.api || {};
  const lmHost = lm.host || {};
  const isLoadGuardOn = lm.enabled !== undefined ? Boolean(lm.enabled) : cfg.smartLoadGuardEnabled !== false;
  const maxPendingCap = lm.maxPendingWorkers || cfg.maxPendingWorkers || 2;
  const inFlightPending = lm.inFlightPendingCount ?? (jf.pendingCount ?? fleet.totalPendingWorkers ?? 0);
  const loadLevel = lm.loadLevel || "GREEN";
  const loadBadgeColor =
    loadLevel === "RED"
      ? "#f87171"
      : loadLevel === "ORANGE"
      ? "#fb923c"
      : loadLevel === "YELLOW"
      ? "#fbbf24"
      : "#34d399";
  const loadBoxBorder =
    loadLevel === "RED"
      ? "rgba(239,68,68,0.65)"
      : loadLevel === "ORANGE"
      ? "rgba(249,115,22,0.6)"
      : loadLevel === "YELLOW"
      ? "rgba(245,158,11,0.55)"
      : "rgba(16,185,129,0.55)";

  const activeCnt = jf.activeCount ?? fleet.totalActiveWorkers ?? 0;
  const runningCnt = jf.runningCount ?? fleet.totalRunningWorkers ?? 0;
  const pendingCnt = jf.pendingCount ?? fleet.totalPendingWorkers ?? 0;
  const targetCnt = jf.targetCount ?? jf.minConcurrentRuns ?? fleet.totalTargetWorkers ?? 1;
  const remainingCnt = jf.remainingToCreate ?? Math.max(0, targetCnt - activeCnt);
  const excessPendingCnt = jf.excessPendingCount ?? Math.max(0, Math.min(pendingCnt, activeCnt - targetCnt));
  const gpusPerWorker = jf.coreCountPerWorker ?? jf.coreCount ?? 4;
  const runningGpus = jf.runningGpuCount ?? runningCnt * gpusPerWorker;
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

  const bannerHtml = `
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
        <button type="button" class="secondary sm" style="${allocIntervalSec === 5 ? "background:#2563eb; border-color:#60a5fa; color:#fff;" : "border-color:#38bdf8; color:#7dd3fc;"}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId || "job-default-1")}', 5)">⚡ 5초</button>
        <button type="button" class="secondary sm" style="${allocIntervalSec === 15 ? "background:#2563eb; border-color:#60a5fa; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId || "job-default-1")}', 15)">15초</button>
        <button type="button" class="secondary sm" style="${allocIntervalSec === 30 ? "background:#2563eb; border-color:#60a5fa; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId || "job-default-1")}', 30)">30초</button>
        <button type="button" class="secondary sm" style="${allocIntervalSec === 60 ? "background:#2563eb; border-color:#60a5fa; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId || "job-default-1")}', 60)">1분</button>
        <button type="button" class="secondary sm" style="${allocIntervalSec === 120 ? "background:#2563eb; border-color:#60a5fa; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId || "job-default-1")}', 120)">2분</button>
        <button type="button" class="secondary sm" style="${allocIntervalSec === 180 ? "background:#2563eb; border-color:#60a5fa; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId || "job-default-1")}', 180)">3분</button>
        <button type="button" class="success sm" onclick="triggerSchedulerTick()">🔍 지금 즉시 자동루프 점검</button>
      </div>
    </div>

    <!-- 2 Side-by-Side Explicit Engine Status Boxes -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(380px, 1fr)); gap:14px; margin-top:14px;">
      <!-- Box 1: Zero-Click Auto Worker Allocation Engine -->
      <div style="background:rgba(15,23,42,0.85); border:1.5px solid rgba(59,130,246,0.55); border-radius:10px; padding:14px 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
          <div style="font-weight:800; font-size:14.5px; color:#93c5fd;">
            🤖 [1단계] 무클릭 워커 자동 신청(할당) 엔진 <span class="mono" style="font-size:12px; color:#fde68a;">[${escapeHtml(jf.jobName || jf.name || " 기본 규칙")}]</span>
          </div>
          <span class="badge ${isSchedOn ? "ok" : "err"}">${isSchedOn ? `🟢 자동 신청 ON (${allocIntervalSec}초 주기)` : "⚪ 자동 신청 OFF"}</span>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
          <div style="background:rgba(30,41,59,0.75); border-radius:8px; padding:9px 11px; border:1px solid rgba(59,130,246,0.3);">
            <div style="font-size:11px; color:#94a3b8;">🟢 실제 가동 중(Running) / 목표 워커</div>
            <div class="mono" style="font-size:20px; font-weight:800; color:#34d399; margin-top:2px;">
              ${runningCnt}개 <span style="font-size:14px; color:#cbd5e1;">/ 목표 ${targetCnt}개</span>
              <span style="font-size:12px; color:#a7f3d0;">(가동 GPU ${runningGpus}장)</span>
            </div>
            <div style="font-size:11px; color:#fde68a; margin-top:2px;">
              ⏳ Pending 대기: <b>${pendingCnt}개</b>${excessPendingCnt > 0 ? ` <span style="color:#fbbf24;">(초과 +${excessPendingCnt}개)</span>` : ""} &nbsp;|&nbsp; <span style="color:#93c5fd;">전체 활성 합계: <b>${activeCnt}개</b> (${activeGpus}장)</span>
            </div>
          </div>

          <div style="background:rgba(30,41,59,0.75); border-radius:8px; padding:9px 11px; border:1px solid rgba(245,158,11,0.35);">
            <div style="font-size:11px; color:#94a3b8;">${remainingCnt > 0 ? "앞으로 무클릭 자동 신청될 워커" : runningCnt < targetCnt ? "⏳ 클러스터 Running 전환 대기 현황" : "앞으로 무클릭 자동 신청될 워커"}</div>
            <div class="mono" style="font-size:20px; font-weight:800; color:${remainingCnt > 0 ? "#fbbf24" : runningCnt < targetCnt ? "#fde68a" : "#34d399"}; margin-top:2px;">
              ${
                remainingCnt > 0
                  ? `+${remainingCnt}개 <span style="font-size:12.5px; color:#fde68a;">(GPU +${remainingGpus}장)</span>`
                  : runningCnt < targetCnt
                  ? `⏳ 대기 ${pendingCnt}개 <span style="font-size:12.5px; color:#cbd5e1;">(Running 부족 ${targetCnt - runningCnt}개)</span>`
                  : `+0개 <span style="font-size:12.5px; color:#6ee7b7;">(전원 Running!)</span>`
              }
            </div>
            <div style="font-size:11px; color:#cbd5e1; margin-top:2px;">
              ${
                remainingCnt > 0
                  ? `${allocIntervalSec}초마다 1개씩 클릭 없이 자동 신청됨`
                  : runningCnt < targetCnt
                  ? `목표 ${targetCnt}개 모두 신청 완료 · 클러스터 노드 배정 시 Running 전환`
                  : `목표 Running ${targetCnt}개 100% 가동 중! (종료 시 즉시 자동 재신청)`
              }
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
          <div>📌 <b>마지막 승인 대기열(Queue) 스캔 시각:</b> <span id="topQueueScanTimeSpan" style="color:#6ee7b7; font-weight:700;">${escapeHtml(formatPreciseTime(appStats.lastCheckedAt, true))}</span> <span id="topQueueScanTickSpan" style="color:#94a3b8;">(누적 스캔 #${appStats.tickCount || 0}회)</span></div>
          <div id="topNextApprovalCountdown" style="color:#34d399; font-weight:700;">⏱️ 다음 자동 승인 대기열 스캔 카운트다운 계산 중...</div>
          <div style="font-size:11px; color:#a7f3d0; margin-top:2px;">
            👑 누적 무클릭 Admin 자동 승인 완료: <b>${totalAutoApproved}건</b> (현재 승인 대기 PENDING: <b>${appStats.pendingCount || 0}건</b> · 마지막 승인 런: <code>${escapeHtml(lastApprovedRunName)}</code>)
          </div>
        </div>
      </div>
    </div>

    <!-- 🛡️ Smart Server & Cluster Load Monitor Bar (Prevents Overloading SPACE & Local Host) -->
    <div style="margin-top:14px; background:rgba(15,23,42,0.88); border:1.5px solid ${loadBoxBorder}; border-radius:10px; padding:12px 15px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span class="badge ${loadLevel === "GREEN" ? "ok" : loadLevel === "RED" ? "err" : "warn"}" style="font-weight:800; font-size:12.5px; padding:4px 10px;">
            🛡️ ${escapeHtml(lm.loadBadgeText || (isLoadGuardOn ? "🟢 쾌적 · 안전 할당" : "⚪ 부하보호 OFF"))}
          </span>
          <span style="font-weight:800; font-size:13.5px; color:#f8fafc;">
            서버/클러스터 무리 방지 모니터링 가드 (${isLoadGuardOn ? "활성" : "비활성"})
          </span>
          <span id="topLoadSummaryTextSpan" style="font-size:12px; color:${loadBadgeColor}; font-weight:600;">
            — ${escapeHtml(lm.summaryText || "실시간 API 응답속도 및 Pending 워커 수 감시 중")}
          </span>
        </div>
        <div class="btn-row" style="gap:5px;">
          <button type="button" class="secondary sm" style="padding:3px 8px; ${isLoadGuardOn ? "border-color:#10b981; color:#6ee7b7;" : ""}" onclick="quickUpdateLoadGuard({ smartLoadGuardEnabled: ${!isLoadGuardOn} })">
            ${isLoadGuardOn ? "🛡️ 부하보호 ON (클릭시 OFF)" : "⚪ 부하보호 OFF (클릭시 ON)"}
          </button>
          <button type="button" class="secondary sm" style="padding:3px 8px; ${maxPendingCap === 1 ? "background:#065f46; color:#fff;" : ""}" onclick="quickUpdateLoadGuard({ smartLoadGuardEnabled: true, maxPendingWorkers: 1 })" title="한 번에 1개씩만 준비시켜 Running 진입을 확인한 뒤 다음 워커를 할당합니다 (가장 안전)">
            안전 1개씩(Running 확인후 순차)
          </button>
          <button type="button" class="secondary sm" style="padding:3px 8px; ${maxPendingCap === 2 ? "background:#1e40af; color:#fff;" : ""}" onclick="quickUpdateLoadGuard({ smartLoadGuardEnabled: true, maxPendingWorkers: 2 })">
            동시 준비 2개(권장)
          </button>
          <button type="button" class="secondary sm" style="padding:3px 8px; ${maxPendingCap === 4 ? "background:#1e40af; color:#fff;" : ""}" onclick="quickUpdateLoadGuard({ smartLoadGuardEnabled: true, maxPendingWorkers: 4 })">
            동시 준비 4개(고속)
          </button>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:8px; margin-top:10px;">
        <div class="mono" style="background:rgba(2,6,23,0.6); border:1px solid rgba(148,163,184,0.2); border-radius:7px; padding:7px 10px; font-size:11.5px;">
          <div style="color:#94a3b8;">⏳ 준비중(Pending/Creating) 워커 가드</div>
          <div id="topInFlightGuardSpan" style="font-size:14px; font-weight:800; color:${inFlightPending >= maxPendingCap ? "#fbbf24" : "#34d399"}; margin-top:2px;">
            현재 ${inFlightPending}개 대기 / 상한 ${maxPendingCap}개
            ${lm.oldestPendingWaitSec > 0 ? `<span style="font-size:11px; color:#fde68a;">(최장 ${lm.oldestPendingWaitSec}초)</span>` : ""}
          </div>
        </div>

        <div class="mono" style="background:rgba(2,6,23,0.6); border:1px solid rgba(148,163,184,0.2); border-radius:7px; padding:7px 10px; font-size:11.5px;">
          <div style="color:#94a3b8;">📡 SPACE API 응답속도 (Latency)</div>
          <div id="topApiLatencySpan" style="font-size:14px; font-weight:800; color:${(lmApi.avgLatencyMs || 0) >= 1800 ? "#fbbf24" : "#60a5fa"}; margin-top:2px;">
            최근 ${lmApi.lastLatencyMs || 0}ms · 평균 ${lmApi.avgLatencyMs || 0}ms <span style="font-size:11px; color:#94a3b8;">(P95 ${lmApi.p95LatencyMs || 0}ms)</span>
          </div>
        </div>

        <div class="mono" style="background:rgba(2,6,23,0.6); border:1px solid rgba(148,163,184,0.2); border-radius:7px; padding:7px 10px; font-size:11.5px;">
          <div style="color:#94a3b8;">🔄 API 호출 빈도 &amp; 스마트 캐시 보호</div>
          <div id="topApiRpmSpan" style="font-size:14px; font-weight:800; color:#a7f3d0; margin-top:2px;">
            분당 ${lmApi.requestsPerMinute || 0}회 호출 · 캐시절감 ${lmApi.cacheHitsPerMinute || 0}회/분
          </div>
        </div>

        <div class="mono" style="background:rgba(2,6,23,0.6); border:1px solid rgba(148,163,184,0.2); border-radius:7px; padding:7px 10px; font-size:11.5px;">
          <div style="color:#94a3b8;">🖥️ 로컬 런너 서버 리소스 &amp; 페이싱 배율</div>
          <div id="topHostCpuSpan" style="font-size:14px; font-weight:800; color:#e2e8f0; margin-top:2px;">
            CPU ${lmHost.cpuLoadPct ?? 0}% (Load ${lmHost.loadAvg1m ?? 0}) · RAM ${lmHost.rssMb ?? 0}MB · 간격 ${(lm.pacingMultiplier || 1).toFixed(1)}x
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
      <div id="topTimelineTableScrollWrap" style="overflow-x:auto; max-height:240px; overflow-y:auto;">
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

  // Compute structural signature excluding 3-second tickCount / latency jitter so the banner doesn't flicker
  const timelineSig = timeline
    .slice(0, 12)
    .map((it) => `${it.runId}:${it.runStatus}:${it.approvedAt}`)
    .join(",");
  const bannerStructuralSig = [
    jf.jobId,
    runningCnt,
    pendingCnt,
    activeCnt,
    targetCnt,
    remainingCnt,
    excessPendingCnt,
    isSchedOn,
    isApprovalOn,
    allocIntervalSec,
    approvalIntervalSec,
    lastAllocReqTime,
    lastApprovalReqTime,
    lastApprovedDoneTime,
    lastApprovedRunId,
    autoAllocTotal,
    manualAllocTotal,
    totalAutoApproved,
    appStats.pendingCount || 0,
    isLoadGuardOn,
    maxPendingCap,
    loadLevel,
    inFlightPending,
    timelineSig,
  ].join("|");

  if (banner.getAttribute("data-banner-sig") === bannerStructuralSig) {
    // Only update volatile live telemetry spans in-place without touching the rest of the banner DOM!
    const scanTimeEl = document.getElementById("topQueueScanTimeSpan");
    if (scanTimeEl) scanTimeEl.textContent = formatPreciseTime(appStats.lastCheckedAt, true);
    const scanTickEl = document.getElementById("topQueueScanTickSpan");
    if (scanTickEl) scanTickEl.textContent = `(누적 스캔 #${appStats.tickCount || 0}회)`;
    const latEl = document.getElementById("topApiLatencySpan");
    if (latEl) {
      latEl.innerHTML = `최근 ${lmApi.lastLatencyMs || 0}ms · 평균 ${lmApi.avgLatencyMs || 0}ms <span style="font-size:11px; color:#94a3b8;">(P95 ${lmApi.p95LatencyMs || 0}ms)</span>`;
    }
    const rpmEl = document.getElementById("topApiRpmSpan");
    if (rpmEl) {
      rpmEl.textContent = `분당 ${lmApi.requestsPerMinute || 0}회 호출 · 캐시절감 ${lmApi.cacheHitsPerMinute || 0}회/분`;
    }
    const cpuEl = document.getElementById("topHostCpuSpan");
    if (cpuEl) {
      cpuEl.textContent = `CPU ${lmHost.cpuLoadPct ?? 0}% (Load ${lmHost.loadAvg1m ?? 0}) · RAM ${lmHost.rssMb ?? 0}MB · 간격 ${(lm.pacingMultiplier || 1).toFixed(1)}x`;
    }
  } else {
    const prevScroll = document.getElementById("topTimelineTableScrollWrap")?.scrollTop || 0;
    banner.setAttribute("data-banner-sig", bannerStructuralSig);
    banner.innerHTML = bannerHtml;
    const newScrollWrap = document.getElementById("topTimelineTableScrollWrap");
    if (newScrollWrap && prevScroll > 0) newScrollWrap.scrollTop = prevScroll;
  }

  updateWorkerCountdownBadge();
  if (!workerCountdownTimerId) {
    workerCountdownTimerId = setInterval(updateWorkerCountdownBadge, 1000);
  }
}

function renderWorkerFleetBoard(fleet, options = {}) {
  const panel = document.getElementById("workerFleetPanel");
  if (!panel) return;
  const activeElId = document.activeElement?.id || "";
  if (
    activeElId === "quickTargetInput" ||
    activeElId === "quickTargetPendingInput" ||
    activeElId === "quickIntervalInput" ||
    activeElId === "slotRangeKillInput"
  ) {
    return;
  }
  if (!fleet || !Array.isArray(fleet.jobs) || fleet.jobs.length === 0) {
    panel.removeAttribute("data-wf-skeleton");
    panel.innerHTML = `
      <div style="font-size:13px; color:var(--muted);">
        📊 등록된 자동 실행 규칙이 없습니다. 아래에서 규칙을 저장하면 실시간 워커 가동 수 및 자동 생성 예정 현황이 표시됩니다.
      </div>
    `;
    return;
  }

  const jf = getFocusedJobFleet(fleet);
  const activeCnt = jf.activeCount ?? 0;
  const runningCnt = jf.runningCount ?? 0;
  const pendingCnt = jf.pendingCount ?? 0;
  const targetCnt = jf.targetCount ?? 1;
  const targetPendingCnt = jf.targetPendingCount ?? jf.targetPendingRuns ?? 0;
  const remainingCnt = jf.remainingToCreate ?? (targetPendingCnt > 0 ? Math.max(0, targetPendingCnt - pendingCnt) : Math.max(0, targetCnt - activeCnt));
  const excessPendingCnt =
    jf.excessPendingCount ??
    (targetPendingCnt > 0 ? Math.max(0, pendingCnt - targetPendingCnt) : Math.max(0, Math.min(pendingCnt, activeCnt - targetCnt)));
  const gpusPerWorker = jf.coreCountPerWorker ?? jf.gpusPerWorker ?? 1;
  const runningGpus = jf.runningGpuCount ?? jf.runningGpus ?? runningCnt * gpusPerWorker;
  const pendingGpus = jf.pendingGpuCount ?? jf.pendingGpus ?? pendingCnt * gpusPerWorker;
  const activeGpus = jf.activeGpuCount ?? jf.activeGpus ?? activeCnt * gpusPerWorker;
  const targetGpus = jf.targetGpuCount ?? jf.targetGpus ?? targetCnt * gpusPerWorker;
  const remainingGpus = jf.remainingGpuToCreate ?? jf.remainingGpus ?? remainingCnt * gpusPerWorker;
  const runningPct = targetCnt > 0 ? Math.min(100, Math.round((runningCnt / targetCnt) * 100)) : 100;
  const pendingPct = targetCnt > 0 ? Math.min(Math.max(0, 100 - runningPct), Math.round((pendingCnt / targetCnt) * 100)) : 0;
  const pct = targetCnt > 0 ? Math.min(100, Math.round((activeCnt / targetCnt) * 100)) : 100;
  const isAutoOn = Boolean(fleet.schedulerEnabled && jf.enabled);
  const intervalSec = jf.scaleUpIntervalSec || 15;
  const recon = fleet.spaceReconciliation || null;

  // Build exact SPACE Cluster Reconciliation Bar so user sees why Rule vs My Account vs Group numbers differ
  let reconciliationBarHtml = "";
  if (recon) {
    const myUnmatched = Array.isArray(recon.myUnmatchedActiveRuns) ? recon.myUnmatchedActiveRuns : [];
    const otherUsers = Array.isArray(recon.otherUserActiveRuns) ? recon.otherUserActiveRuns : [];
    const myUnmatchedBadges = myUnmatched
      .map(
        (u) =>
          `<span class="mono" style="display:inline-flex; align-items:center; gap:4px; background:rgba(56,189,248,0.18); border:1px solid rgba(56,189,248,0.5); color:#7dd3fc; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:700;" title="현재 규칙 이름과 다른 내 계정 워크로드">
            <span style="cursor:pointer;" onclick="viewRunLog('${escapeHtml(String(u.id))}', '${escapeHtml(u.name)}')">📌 규칙외 내 런: ${escapeHtml(u.name)} (#${escapeHtml(String(u.id))} · ${escapeHtml(u.status)} · ${escapeHtml(u.coreName)}×${u.coreCount})</span>
            <button type="button" class="danger sm" style="padding:1px 5px; font-size:10px;" onclick="event.stopPropagation(); killSingleWorkerSlot('${escapeHtml(String(u.id))}', '${escapeHtml(u.name)}', '규칙외 #${escapeHtml(String(u.id))}', false, '')">🛑Kill</button>
          </span>`
      )
      .join(" ");
    const otherUserBadges = otherUsers
      .map(
        (u) =>
          `<span class="mono" style="display:inline-flex; align-items:center; gap:4px; background:rgba(168,85,247,0.18); border:1px solid rgba(168,85,247,0.5); color:#d8b4fe; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:700;" title="그룹 내 다른 사용자 워크로드">
            <span style="cursor:pointer;" onclick="viewRunLog('${escapeHtml(String(u.id))}', '${escapeHtml(u.name)}')">👥 타유저(${escapeHtml(u.userName)}): ${escapeHtml(u.name)} (#${escapeHtml(String(u.id))} · ${escapeHtml(u.status)} · ${escapeHtml(u.coreName)}×${u.coreCount})</span>
            <button type="button" class="danger sm" style="padding:1px 5px; font-size:10px;" onclick="event.stopPropagation(); killSingleWorkerSlot('${escapeHtml(String(u.id))}', '${escapeHtml(u.name)}', '타유저 #${escapeHtml(String(u.id))}', false, '')">🛑Kill</button>
          </span>`
      )
      .join(" ");

    reconciliationBarHtml = `
      <div style="margin-bottom:12px; padding:10px 13px; border-radius:9px; background:rgba(2,6,23,0.78); border:1.5px solid rgba(56,189,248,0.42); display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:12.5px;">
            <span style="font-weight:800; color:#38bdf8;">📊 SPACE 실제 워커 실시간 대조표:</span>
            <span class="mono" style="background:rgba(16,185,129,0.15); border:1px solid rgba(16,185,129,0.45); padding:3px 8px; border-radius:6px; color:#d1fae5;">
              ① 규칙 <b>[${escapeHtml(jf.jobName)}]</b>: <b style="color:#34d399;">🟢 Running ${runningCnt}개</b>(${runningGpus}GPU) + <b style="color:#fde68a;">⏳ Pending ${pendingCnt}${targetPendingCnt > 0 ? `/${targetPendingCnt}(목표)` : ""}개</b>(${pendingGpus}GPU) = <b>활성 ${activeCnt}개</b> / 목표 ${targetCnt}개
            </span>
            <span class="mono" style="background:rgba(59,130,246,0.15); border:1px solid rgba(59,130,246,0.45); padding:3px 8px; border-radius:6px; color:#dbeafe;">
              ② 내 계정 전체(<code>${escapeHtml(recon.currentUserName || "me")}</code>): <b style="color:#60a5fa;">🟢 Running ${recon.mySpaceRunningWorkers}개</b>(${recon.mySpaceRunningGpus}GPU) + ⏳ Pending ${recon.mySpacePendingWorkers}개 = <b>총 ${recon.mySpaceActiveWorkers}개</b>
            </span>
            <span class="mono" style="background:rgba(148,163,184,0.14); border:1px solid rgba(148,163,184,0.35); padding:3px 8px; border-radius:6px; color:#e2e8f0;">
              ③ 그룹 전체(<code>${escapeHtml(recon.groupId || "Group")}</code>): <b>🟢 Running ${recon.spaceTotalRunningWorkers}개</b>(${recon.spaceTotalRunningGpus}GPU) + ⏳ Pending ${recon.spaceTotalPendingWorkers}개 = <b>총 ${recon.spaceTotalActiveWorkers}개</b>
            </span>
          </div>
          ${
            excessPendingCnt > 0
              ? `<button type="button" class="secondary sm" style="border-color:#fbbf24; background:rgba(245,158,11,0.18); color:#fde68a; font-weight:800; padding:4px 10px;" onclick="bulkControlWorkers('trim_excess_pending', { jobId: '${escapeHtml(jf.jobId)}' })">✂️ 초과 Pending +${excessPendingCnt}개 자동 정리 (${targetPendingCnt > 0 ? `목표 Pending ${targetPendingCnt}개` : `${targetCnt}개`} 맞춤)</button>`
              : ""
          }
        </div>
        ${
          myUnmatched.length > 0 || otherUsers.length > 0
            ? `<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11.5px; color:#cbd5e1;">
                <span style="color:#94a3b8;">💡 규칙 외 SPACE 가동 워크로드 (즉시 Kill 가능):</span>
                ${myUnmatchedBadges}
                ${otherUserBadges}
              </div>`
            : ""
        }
      </div>
    `;
  }

  const multiRuleTabsHtml =
    fleet.jobs.length > 1
      ? `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px; padding:8px 12px; border-radius:8px; background:rgba(15,23,42,0.82); border:1px solid rgba(59,130,246,0.4);">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span style="font-size:12px; font-weight:800; color:#93c5fd;">📋 규칙별 현황 선택:</span>
          ${fleet.jobs
            .map((item) => {
              const isFocused = String(item.jobId) === String(jf.jobId);
              return `
                <button type="button" class="${isFocused ? "" : "secondary"} sm"
                  onclick="selectFleetJobTab('${escapeHtml(item.jobId)}')"
                  style="padding:4px 10px; font-size:12px; font-weight:700; ${
                    isFocused
                      ? "background:#2563eb; border:1px solid #60a5fa; color:#fff;"
                      : "border-color:rgba(148,163,184,0.35);"
                  }">
                  ${item.enabled ? "🟢" : "⚪"} ${escapeHtml(item.jobName)} (Running ${item.runningCount ?? 0}${item.pendingCount ? `+대기${item.pendingCount}` : ""}/${item.targetCount})
                </button>
              `;
            })
            .join("")}
        </div>
        <div class="mono" style="font-size:11.5px; color:#a7f3d0;">
          전체 활성 규칙 합계: <b>🟢 Running ${fleet.totalRunningWorkers}개</b> + ⏳ 대기 ${fleet.totalPendingWorkers}개 = <b>${fleet.totalActiveWorkers}/${fleet.totalTargetWorkers} 워커</b> (가동 GPU <b>${fleet.totalRunningGpus}장</b>)
        </div>
      </div>
    `
      : "";

  // Build slot pills (up to 256 visual pills so UI stays clean and fast)
  const maxVisualSlots = Math.min(Math.max(targetCnt, activeCnt), 256);
  const slotPills = [];
  const activeWorkers = jf.activeWorkers || [];
  const wd = fleet.watchdog || {};
  const ts = fleet.timeScale || {};
  const hf = fleet.hybridFallback || {};
  const shardingOn = Boolean(fleet.sharding?.injectWorkerEnv ?? serverState?.config?.injectWorkerEnv);
  const notif = fleet.notifications || {};
  const bng = fleet.badNodeGuard || {};
  const pipe = fleet.pipeline || {};
  const tel = fleet.telemetry || {};

  // Clean up any stale selected IDs that are no longer active anywhere
  const allCurrentActiveIds = new Set();
  for (const jItem of fleet.jobs || []) {
    for (const aw of jItem.activeWorkers || []) {
      if (aw.id !== undefined && aw.id !== null) allCurrentActiveIds.add(String(aw.id));
    }
  }
  if (recon && Array.isArray(recon.unmatchedActiveRuns)) {
    for (const u of recon.unmatchedActiveRuns) {
      if (u.id !== undefined && u.id !== null) allCurrentActiveIds.add(String(u.id));
    }
  }
  for (const r of latestRawSpaceRuns || []) {
    if (classifyUiRunStatus(r.status ?? r.state ?? r.phase) === "ACTIVE") {
      allCurrentActiveIds.add(String(r.id ?? r.runId));
    }
  }
  if (allCurrentActiveIds.size > 0) {
    for (const selId of Array.from(selectedWorkerRunIds)) {
      if (!allCurrentActiveIds.has(String(selId))) {
        selectedWorkerRunIds.delete(selId);
      }
    }
  }

  for (let i = 0; i < maxVisualSlots; i++) {
    const w = activeWorkers[i];
    if (w) {
      const wIdStr = String(w.id);
      const isSelected = selectedWorkerRunIds.has(wIdStr);
      const stUpper = String(w.status || "").toUpperCase();
      const isRun = stUpper.includes("RUN");
      const isExcess = Boolean(w.isExcessPending);
      const hasErr = Boolean(w.hasLogError);
      const prog = w.progress || null;
      const isStraggler = Boolean(prog?.isStraggler);
      const dot = hasErr ? "🚨" : isStraggler ? "🐢" : isRun ? "🟢" : isExcess ? "⚠️" : "⏳";
      const bg = isSelected
        ? "rgba(56,189,248,0.28)"
        : hasErr
        ? "rgba(239,68,68,0.22)"
        : isStraggler
        ? "rgba(249,115,22,0.22)"
        : isRun
        ? "rgba(16,185,129,0.18)"
        : isExcess
        ? "rgba(245,158,11,0.28)"
        : "rgba(245,158,11,0.18)";
      const border = isSelected
        ? "#38bdf8"
        : hasErr
        ? "#f87171"
        : isStraggler
        ? "#fb923c"
        : isRun
        ? "rgba(16,185,129,0.5)"
        : isExcess
        ? "#fbbf24"
        : "rgba(245,158,11,0.5)";
      const color = hasErr ? "#fecaca" : isStraggler ? "#fed7aa" : isRun ? "#6ee7b7" : "#fde68a";
      const srcTag = w.triggerSource === "auto_scheduler" ? "🤖자동" : "👆수동";
      const seqNum = i + 1;
      const stateIdx = w.stateOrderIndex || (isRun ? seqNum : seqNum - runningCnt);
      const pillHeaderLabel = isRun
        ? `워커 #${stateIdx}`
        : isExcess
        ? `초과Pending #${seqNum} (대기#${stateIdx})`
        : `Pending대기 #${seqNum} (대기#${stateIdx})`;
      const reqTimeShort = w.autoApprovalRequestedAt ? formatPreciseTime(w.autoApprovalRequestedAt, false).slice(0, 8) : "";
      const doneTimeShort = w.approvedAt ? formatPreciseTime(w.approvedAt, false).slice(0, 8) : "";
      const logLineShort = w.lastLogLine ? String(w.lastLogLine).slice(0, 44) : "";

      const progParts = [];
      if (prog) {
        if (prog.pct !== null && prog.pct !== undefined) progParts.push(`${prog.pct}%`);
        if (prog.stepInfo) progParts.push(prog.stepInfo);
        if (prog.loss) progParts.push(`loss=${prog.loss}`);
        if (prog.speedText) progParts.push(prog.speedText);
        if (prog.eta) progParts.push(`ETA ${prog.eta}`);
      }
      const progBadgeHtml =
        progParts.length > 0
          ? `<span style="font-size:10px; color:${isStraggler ? "#fdba74" : "#38bdf8"}; font-weight:700;">📈 ${escapeHtml(progParts.join(" · "))}${isStraggler ? ` (🐢느림 < 중앙값 ${prog.medianSpeed})` : ""}</span>`
          : "";

      const slotSig = [
        seqNum,
        stateIdx,
        w.status,
        isSelected ? 1 : 0,
        isExcess ? 1 : 0,
        hasErr ? 1 : 0,
        isStraggler ? 1 : 0,
        reqTimeShort,
        doneTimeShort,
        logLineShort,
        progParts.join(","),
      ].join("|");

      slotPills.push({
        key: `active-${wIdStr}`,
        sig: slotSig,
        html: `
        <div class="mono" onclick="viewRunLog('${escapeHtml(wIdStr)}', '${escapeHtml(w.name)}')"
          title="클릭하여 로그 보기: ${escapeHtml(w.name)} (#${escapeHtml(wIdStr)}) · 상태: ${escapeHtml(w.status)} · ${pillHeaderLabel} · 신청: ${srcTag} · ⚡자동승인요청: ${escapeHtml(formatPreciseTime(w.autoApprovalRequestedAt, true))} · ✅승인완료: ${escapeHtml(formatPreciseTime(w.approvedAt, true))}${w.lastLogLine ? ` · 최근로그: ${escapeHtml(w.lastLogLine)}` : ""}"
          style="cursor:pointer; display:inline-flex; flex-direction:column; gap:3px; padding:5px 8px; border-radius:7px; font-size:11px; background:${bg}; border:${isSelected ? "2px" : "1px"} solid ${border}; ${isSelected ? "box-shadow:0 0 0 2px rgba(56,189,248,0.28);" : ""} color:${color}; font-weight:600;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
            <label onclick="event.stopPropagation();" style="display:inline-flex; align-items:center; gap:4px; cursor:pointer; margin:0; font-weight:700; color:${color};">
              <input type="checkbox" ${isSelected ? "checked" : ""} onchange="toggleSelectWorkerRun('${escapeHtml(wIdStr)}', this.checked)" style="width:13px; height:13px; margin:0; accent-color:#38bdf8; cursor:pointer;" />
              <span>${dot} ${pillHeaderLabel} <span style="opacity:0.9;">(#${escapeHtml(wIdStr)})</span></span>
            </label>
            <div style="display:inline-flex; align-items:center; gap:3px;" onclick="event.stopPropagation();">
              <button type="button" class="danger sm" style="padding:1px 5px; font-size:9.5px; line-height:1.25; font-weight:800;"
                onclick="killSingleWorkerSlot('${escapeHtml(wIdStr)}', '${escapeHtml(w.name)}', '${escapeHtml(pillHeaderLabel)}', false, '${escapeHtml(jf.jobId)}')"
                title="이 슬롯(#${escapeHtml(wIdStr)})을 즉시 강제 종료(Stop/Kill)합니다 (자동충원 유지)">🛑Kill</button>
              <button type="button" class="secondary sm" style="padding:1px 5px; font-size:9.5px; line-height:1.25; font-weight:800; border-color:rgba(244,63,94,0.65); color:#fecdd3; background:rgba(159,18,57,0.45);"
                onclick="killSingleWorkerSlot('${escapeHtml(wIdStr)}', '${escapeHtml(w.name)}', '${escapeHtml(pillHeaderLabel)}', true, '${escapeHtml(jf.jobId)}')"
                title="이 슬롯(#${escapeHtml(wIdStr)})을 즉시 종료(Kill)하고 목표 워커 수를 -1 차감하여 다시 생성되지 않게 영구 삭제합니다">🗑️삭제</button>
            </div>
          </div>
          ${reqTimeShort ? `<span style="font-size:10px; color:#fde68a;">⚡승인 ${escapeHtml(reqTimeShort)} → ✅${escapeHtml(doneTimeShort)} (${srcTag})</span>` : `<span style="font-size:10px; opacity:0.85;">상태: ${escapeHtml(w.status)} (${srcTag} · ${escapeHtml(w.name.slice(0, 14))})</span>`}
          ${progBadgeHtml}
          ${
            hasErr
              ? `<span style="font-size:10px; color:#fca5a5;">🚨 에러감지: ${escapeHtml(w.logErrorKeyword || "Error")}</span>`
              : logLineShort
              ? `<span style="font-size:9.5px; color:#cbd5e1; max-width:210px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">📝 ${escapeHtml(logLineShort)}</span>`
              : ""
          }
        </div>
      `,
      });
    } else {
      const isNext = i === activeCnt && remainingCnt > 0 && isAutoOn;
      const bg = isNext ? "rgba(59,130,246,0.22)" : "rgba(30,41,59,0.65)";
      const border = isNext ? "#60a5fa" : "rgba(148,163,184,0.25)";
      const color = isNext ? "#93c5fd" : "#94a3b8";
      const nextSlotNum = i + 1;
      slotPills.push({
        key: `wait-slot-${nextSlotNum}`,
        sig: `${nextSlotNum}|${isNext ? 1 : 0}|${targetCnt}|${jf.jobId}`,
        html: `
        <div class="mono"
          title="${isNext ? "다음 차례에 자동 생성될 워커 슬롯입니다 (우측 🗑️삭제 클릭 시 목표 워커 수 -1 차감)" : "순차적으로 자동 생성 예정인 워커 슬롯입니다 (우측 🗑️삭제 클릭 시 목표 워커 수 -1 차감)"}"
          style="display:inline-flex; align-items:center; justify-content:space-between; gap:6px; padding:4px 8px; border-radius:6px; font-size:11.5px; background:${bg}; border:1px dashed ${border}; color:${color};">
          <span>${isNext ? "⚡" : "🔄"} 워커 #${nextSlotNum} <span style="font-size:10.5px;">${isNext ? "(다음 생성)" : "(자동생성 대기)"}</span></span>
          <button type="button" class="secondary sm" style="padding:1px 5px; font-size:9.5px; border-color:rgba(244,63,94,0.5); color:#fda4af;"
            onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', ${Math.max(1, targetCnt - 1)})"
            title="대기 슬롯 1개를 삭제하여 목표 워커 수를 ${Math.max(1, targetCnt - 1)}개로 줄입니다">🗑️-1</button>
        </div>
      `,
      });
    }
  }

  // Also append unmatched active SPACE runs (e.g. `fss #352713` or other user runs) so all SPACE active runs are visible and directly killable
  if (recon && Array.isArray(recon.unmatchedActiveRuns) && recon.unmatchedActiveRuns.length > 0) {
    for (const u of recon.unmatchedActiveRuns) {
      const uIdStr = String(u.id);
      const isSelected = selectedWorkerRunIds.has(uIdStr);
      const isMine = Boolean(u.isMine);
      const pillBg = isSelected ? "rgba(56,189,248,0.28)" : isMine ? "rgba(56,189,248,0.16)" : "rgba(168,85,247,0.16)";
      const pillBorder = isSelected ? "#38bdf8" : isMine ? "rgba(56,189,248,0.55)" : "rgba(168,85,247,0.55)";
      const pillColor = isMine ? "#7dd3fc" : "#d8b4fe";
      slotPills.push({
        key: `unmatched-${uIdStr}`,
        sig: `${uIdStr}|${u.status}|${isSelected ? 1 : 0}|${u.coreCount}`,
        html: `
        <div class="mono" onclick="viewRunLog('${escapeHtml(uIdStr)}', '${escapeHtml(u.name)}')"
          title="클릭하여 로그 보기: ${escapeHtml(u.name)} (#${escapeHtml(uIdStr)}) · 계정: ${escapeHtml(u.userName)} · 상태: ${escapeHtml(u.status)}"
          style="cursor:pointer; display:inline-flex; flex-direction:column; gap:3px; padding:5px 8px; border-radius:7px; font-size:11px; background:${pillBg}; border:${isSelected ? "2px" : "1px"} solid ${pillBorder}; color:${pillColor}; font-weight:600;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
            <label onclick="event.stopPropagation();" style="display:inline-flex; align-items:center; gap:4px; cursor:pointer; margin:0; color:${pillColor};">
              <input type="checkbox" ${isSelected ? "checked" : ""} onchange="toggleSelectWorkerRun('${escapeHtml(uIdStr)}', this.checked)" style="width:13px; height:13px; margin:0; accent-color:#38bdf8; cursor:pointer;" />
              <span>${isMine ? "📌 규칙외(내 런)" : `👥 타유저(${escapeHtml(u.userName)})`} <b>${escapeHtml(u.name)}</b> (#${escapeHtml(uIdStr)})</span>
            </label>
            <button type="button" class="danger sm" style="padding:1px 5px; font-size:9.5px; line-height:1.25; font-weight:800;"
              onclick="event.stopPropagation(); killSingleWorkerSlot('${escapeHtml(uIdStr)}', '${escapeHtml(u.name)}', '규칙외 #${escapeHtml(uIdStr)}', false, '')"
              title="이 워크로드(#${escapeHtml(uIdStr)})를 즉시 강제 종료(Stop/Kill)합니다">🛑Kill</button>
          </div>
          <span style="font-size:10px; opacity:0.9;">${u.isRunning ? "🟢 Running" : `⏳ ${escapeHtml(u.status)}`} · ${escapeHtml(u.coreName)}×${u.coreCount}</span>
        </div>
      `,
      });
    }
  }

  // Live 1-line Log & Progress Summary Rows for active workers that have scanned logs
  const workersWithLogs = activeWorkers.filter((w) => w.lastLogLine);
  const stragglerCount = activeWorkers.filter((w) => w.progress?.isStraggler).length;
  const liveLogSummaryHtml =
    workersWithLogs.length > 0
      ? `
      <div style="margin-top:10px; background:rgba(15,23,42,0.75); border:1px solid rgba(148,163,184,0.25); border-radius:8px; padding:8px 12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; flex-wrap:wrap; gap:6px;">
          <span style="font-size:12px; font-weight:700; color:#93c5fd;">📈 2. 가동 워커 실시간 진행률(% · Loss · Speed · ETA) &amp; 로그 요약 보드 (${workersWithLogs.length}/${activeWorkers.length}개 스캔됨${stragglerCount > 0 ? ` · 🐢 느린 워커 ${stragglerCount}개 감지` : ""})</span>
          <span class="mono" style="font-size:11px; color:#94a3b8;">Watchdog 자동교체: ${wd.zombieTerminatedCount || 0}건 · 로그에러 감지: ${wd.logErrorDetectedCount || 0}건</span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:6px; max-height:125px; overflow-y:auto;">
          ${workersWithLogs
            .slice(0, 16)
            .map((w) => {
              const p = w.progress;
              const pSummary = p
                ? [
                    p.pct !== null && p.pct !== undefined ? `${p.pct}%` : null,
                    p.stepInfo,
                    p.loss ? `loss:${p.loss}` : null,
                    p.speedText,
                    p.eta ? `ETA:${p.eta}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "";
              return `
            <div class="mono" onclick="viewRunLog('${escapeHtml(String(w.id))}', '${escapeHtml(w.name)}')"
              style="cursor:pointer; font-size:11px; padding:4px 8px; border-radius:5px; background:${
                w.hasLogError
                  ? "rgba(239,68,68,0.18)"
                  : p?.isStraggler
                  ? "rgba(249,115,22,0.18)"
                  : "rgba(30,41,59,0.7)"
              }; border:1px solid ${
                w.hasLogError
                  ? "rgba(239,68,68,0.5)"
                  : p?.isStraggler
                  ? "rgba(249,115,22,0.5)"
                  : "rgba(148,163,184,0.2)"
              }; display:flex; align-items:center; gap:6px; overflow:hidden;">
              <span style="color:${w.hasLogError ? "#f87171" : p?.isStraggler ? "#fb923c" : "#34d399"}; font-weight:700; flex-shrink:0;">슬롯#${w.assignedSlot || w.slotIndex} (#${escapeHtml(String(w.id))})</span>
              ${pSummary ? `<span style="background:rgba(56,189,248,0.16); color:#38bdf8; padding:1px 5px; border-radius:4px; font-size:10px; flex-shrink:0;">${p?.isStraggler ? "🐢 " : ""}${escapeHtml(pSummary)}</span>` : ""}
              <span style="color:#e2e8f0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(w.lastLogLine)}</span>
            </div>
          `;
            })
            .join("")}
        </div>
      </div>
    `
      : "";

  // Feature 5: Cumulative GPU-Hours Telemetry & Time-Series Mini Bar Chart Board
  const tsSeries = Array.isArray(tel.timeSeries) ? tel.timeSeries.slice(-24) : [];
  const maxSeriesGpu = Math.max(1, targetGpus, ...tsSeries.map((pt) => Number(pt.runningGpus || 0)));
  const miniBarsHtml =
    tsSeries.length > 0
      ? tsSeries
          .map((pt) => {
            const hPct = Math.max(10, Math.min(100, Math.round(((pt.runningGpus || 0) / maxSeriesGpu) * 100)));
            return `<div title="${escapeHtml(pt.time || "")} — 가동 GPU: ${pt.runningGpus || 0}/${pt.targetGpus || targetGpus}장 (Running 워커 ${pt.runningWorkers || 0}개 · API ${pt.avgApiMs || 0}ms)" style="flex:1; min-width:5px; max-width:14px; height:${hPct}%; background:linear-gradient(180deg, #34d399, #3b82f6); border-radius:2px 2px 0 0;"></div>`;
          })
          .join("")
      : `<span class="hint" style="font-size:11px;">시계열 샘플 수집 중...</span>`;

  const telemetryBoardHtml = `
    <div style="margin-top:10px; padding:9px 12px; border-radius:8px; background:rgba(15,23,42,0.78); border:1px solid rgba(16,185,129,0.32); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <div>
          <div style="font-size:11px; color:#94a3b8;">📊 5. 누적 GPU-Hours 가동 통계</div>
          <div class="mono" style="font-size:15px; font-weight:800; color:#34d399;">
            총 ${tel.totalGpuHours ?? 0} GPU-Hours <span style="font-size:11.5px; color:#a7f3d0; font-weight:600;">(오늘 ${tel.todayDate || ""}: ${tel.todayGpuHours ?? 0} GPU-h)</span>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:2px;">
          <span style="font-size:10.5px; color:#94a3b8;">시간대별 가동 GPU 추이 (최근 ${tsSeries.length}샘플)</span>
          <div style="display:flex; align-items:flex-end; gap:2px; height:26px; width:180px; padding:2px 4px; background:rgba(2,6,23,0.65); border-radius:4px; border:1px solid rgba(148,163,184,0.2);">
            ${miniBarsHtml}
          </div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <button type="button" class="secondary sm" style="padding:3px 9px; font-size:11px; border-color:rgba(16,185,129,0.45); color:#6ee7b7;" onclick="exportTelemetryReport('csv')">📥 CSV 리포트 다운로드</button>
        <button type="button" class="secondary sm" style="padding:3px 9px; font-size:11px;" onclick="exportTelemetryReport('json')">📥 JSON 리포트</button>
      </div>
    </div>
  `;

  let statusHeadline = "";
  let statusBadgeClass = "ok";
  let statusBadgeLabel = "";
  if (remainingCnt > 0) {
    statusBadgeClass = "warn";
    statusBadgeLabel = `🚀 자동 스케일업 진행 중 (🟢 Running ${runningCnt} · ⏳ 대기 ${pendingCnt} · 활성 ${activeCnt}/${targetCnt})`;
    if (isAutoOn) {
      statusHeadline = `🔄 현재 <b>🟢 Running ${runningCnt}개</b> + ⏳ 대기 ${pendingCnt}개(활성 ${activeCnt}개) → 목표 <b>${targetCnt}개</b>까지 앞으로 <b style="color:#fde68a; font-size:15px;">+${remainingCnt}개</b> 워커(GPU <b>+${remainingGpus}장</b>)가 <b>${intervalSec}초 간격</b>으로 자동 생성됩니다!`;
    } else {
      statusHeadline = `⏸️ 현재 <b>🟢 Running ${runningCnt}개</b> + ⏳ 대기 ${pendingCnt}개(활성 ${activeCnt}/${targetCnt}개 · 미달 <b>+${remainingCnt}개</b>) — 현재 자동 생성이 일시정지(OFF) 상태입니다.`;
    }
  } else if (runningCnt < targetCnt) {
    statusBadgeClass = "warn";
    statusBadgeLabel = `⏳ 클러스터 노드 대기 중 (🟢 Running ${runningCnt} / 목표 ${targetCnt}개 · Pending ${pendingCnt}개)`;
    statusHeadline = `🟢 현재 실제 가동(Running) <b>${runningCnt}개</b>(GPU <b>${runningGpus}장</b>) + ⏳ 클러스터 대기(Pending) <b style="color:#fde68a;">${pendingCnt}개</b>(GPU <b>${pendingGpus}장</b>) = 전체 활성 <b>${activeCnt}개</b> (목표 <b>${targetCnt}개</b> 신청 완료${
      excessPendingCnt > 0 ? ` · <span style="color:#fbbf24;">초과 Pending +${excessPendingCnt}개</span>` : ""
    })`;
  } else {
    statusBadgeClass = "ok";
    statusBadgeLabel = `✅ 목표 Running 100% 달성 (🟢 Running ${runningCnt}/${targetCnt}개${pendingCnt > 0 ? ` · 대기 ${pendingCnt}개` : ""})`;
    statusHeadline = `✅ 목표 워커 <b>${targetCnt}개</b> 중 <b>🟢 실제 가동(Running) ${runningCnt}개</b> (총 GPU <b>${runningGpus}장</b>)${
      pendingCnt > 0 ? ` + ⏳ 대기 ${pendingCnt}개` : ""
    } 가동 중입니다! (워커 종료 시 자동으로 즉시 재생성)`;
  }

  // Ensure persistent skeleton inside #workerFleetPanel so we never destroy scroll positions, hover states, or <details>
  if (panel.getAttribute("data-wf-skeleton") !== "1") {
    panel.setAttribute("data-wf-skeleton", "1");
    panel.innerHTML = `
      <div id="wfMultiRuleTabs"></div>
      <div id="wfReconciliationBar"></div>
      <div id="wfHeadlineSection"></div>
      <div id="wfMetricCardsSection"></div>
      <div id="wfProgressBarSection"></div>
      <div id="wfSlotSelectionBar"></div>
      <div id="wfSlotPillsGrid"
        onmouseenter="setSlotGridHover(true)"
        onmouseleave="setSlotGridHover(false)"
        style="display:flex; flex-wrap:wrap; gap:6px; max-height:225px; overflow-y:auto; padding-top:4px;"></div>
      <details id="wfAdvancedDetails" style="margin-top:10px; padding:8px 12px; border-radius:8px; background:rgba(15,23,42,0.65); border:1px solid rgba(59,130,246,0.3);">
        <summary style="cursor:pointer; font-size:12px; font-weight:700; color:#93c5fd; user-select:none;">
          ⚙️ 무인 운영 상세 도구 펼치기 (Watchdog · 슬롯샤딩 · 폴백 · 야간부스트 · 전체 로그 스캔 · GPU-Hours 리포트)
        </summary>
        <div id="wfAutomationToggles"></div>
        <div id="wfLiveLogSummary"></div>
        <div id="wfTelemetryBoard"></div>
      </details>
    `;
  }

  // 1. Multi-rule tabs (only update when job counts/focus change)
  const multiTabsSig = fleet.jobs
    .map((it) => `${it.jobId}:${it.enabled}:${it.runningCount}:${it.pendingCount}:${it.targetCount}:${String(it.jobId) === String(jf.jobId)}`)
    .join(";");
  updateHtmlIfSigChanged(document.getElementById("wfMultiRuleTabs"), multiTabsSig, multiRuleTabsHtml);

  // 2. SPACE Reconciliation Bar (only update when counts or unmatched run IDs/statuses change)
  const reconSig = recon
    ? [
        jf.jobName,
        runningCnt,
        pendingCnt,
        activeCnt,
        targetCnt,
        excessPendingCnt,
        recon.mySpaceRunningWorkers,
        recon.mySpacePendingWorkers,
        recon.mySpaceActiveWorkers,
        recon.spaceTotalRunningWorkers,
        recon.spaceTotalPendingWorkers,
        recon.spaceTotalActiveWorkers,
        (recon.myUnmatchedActiveRuns || []).map((u) => `${u.id}:${u.status}`).join(","),
        (recon.otherUserActiveRuns || []).map((u) => `${u.id}:${u.status}`).join(","),
      ].join("|")
    : "none";
  updateHtmlIfSigChanged(document.getElementById("wfReconciliationBar"), reconSig, reconciliationBarHtml);

  // 3. Headline section
  const headlineSig = `${jf.jobId}|${runningCnt}|${pendingCnt}|${activeCnt}|${targetCnt}|${remainingCnt}|${excessPendingCnt}|${isAutoOn}|${intervalSec}`;
  const headlineHtml = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px; margin-bottom:12px;">
      <div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span class="badge ${statusBadgeClass}" style="font-size:12.5px; padding:4px 10px;">
            ${statusBadgeLabel}
          </span>
          <span style="font-size:14px; color:#e2e8f0;">${statusHeadline}</span>
        </div>
        <div id="workerFleetCountdownBadge" class="mono" style="margin-top:6px; font-size:12.5px; color:#93c5fd;"></div>
      </div>
      <div class="btn-row">
        <button type="button" class="success sm" onclick="spawnExtraWorkers('${escapeHtml(jf.jobId)}', 1)">➕ 지금 즉시 +1개 생성</button>
        <button type="button" class="success sm" style="background:#059669;" onclick="spawnExtraWorkers('${escapeHtml(jf.jobId)}', 4)">⚡ 지금 즉시 +4개 연속 생성</button>
        ${
          excessPendingCnt > 0
            ? `<button type="button" class="secondary sm" style="border-color:#fbbf24; background:rgba(245,158,11,0.18); color:#fde68a; font-weight:800;" onclick="bulkControlWorkers('trim_excess_pending', { jobId: '${escapeHtml(jf.jobId)}' })">✂️ 초과 Pending(+${excessPendingCnt}개) 정리</button>`
            : ""
        }
        <button type="button" class="secondary sm" style="border-color:rgba(245,158,11,0.5); color:#fde68a;" onclick="bulkControlWorkers('stop_pending')">⏳ Pending(${pendingCnt}개) 전체취소</button>
        <button type="button" class="danger sm" onclick="bulkControlWorkers('stop_all')">🛑 전체 워커 종료</button>
      </div>
    </div>
  `;
  updateHtmlIfSigChanged(document.getElementById("wfHeadlineSection"), headlineSig, headlineHtml);

  // 4. Metric cards section (only update when worker/target/interval counts change)
  const metricSig = `${jf.jobId}|${runningCnt}|${pendingCnt}|${activeCnt}|${targetCnt}|${targetPendingCnt}|${remainingCnt}|${excessPendingCnt}|${gpusPerWorker}|${intervalSec}`;
  const metricHtml = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:10px; margin-bottom:12px;">
      <div style="background:rgba(15,23,42,0.75); border:1px solid rgba(16,185,129,0.45); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11.5px; color:#94a3b8;">🟢 실제 가동 중(Running) 워커 수</div>
        <div class="mono" style="font-size:22px; font-weight:800; color:#34d399; margin-top:2px;">
          ${runningCnt}개 <span style="font-size:14px; color:#cbd5e1;">/ 목표 ${targetCnt}개</span>
          <span style="font-size:12.5px; font-weight:600; color:#a7f3d0;">(가동 GPU ${runningGpus}장)</span>
        </div>
        <div style="font-size:11.5px; color:#cbd5e1; margin-top:2px;">
          ⏳ Pending 대기: <b style="color:#fde68a;">${pendingCnt}개${targetPendingCnt > 0 ? ` / 목표 ${targetPendingCnt}개` : ""}</b>(${pendingGpus}장) &nbsp;|&nbsp; 전체 활성: <b>${activeCnt}개</b>(${activeGpus}장)
        </div>
      </div>

      <div style="background:rgba(15,23,42,0.75); border:1px solid rgba(245,158,11,0.45); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11.5px; color:#94a3b8;">${
          targetPendingCnt > 0
            ? `⏳ Pending 목표(${targetPendingCnt}개) 자동 유지 상태`
            : remainingCnt > 0
            ? "🔄 앞으로 자동 생성될 워커 수"
            : "⏳ 클러스터 Pending 대기 및 추가 생성"
        }</div>
        <div class="mono" style="font-size:21px; font-weight:800; color:${remainingCnt > 0 ? "#fbbf24" : pendingCnt > 0 ? "#fde68a" : "#6ee7b7"}; margin-top:2px;">
          ${
            remainingCnt > 0
              ? `+${remainingCnt}개 생성 예정 <span style="font-size:12.5px; font-weight:600; color:#fde68a;">(${
                  targetPendingCnt > 0 ? `Pending ${pendingCnt}→${targetPendingCnt}개` : `GPU +${remainingGpus}장`
                })</span>`
              : pendingCnt > 0
              ? `⏳ Pending ${pendingCnt}개 대기 <span style="font-size:12.5px; font-weight:600; color:#cbd5e1;">(${
                  excessPendingCnt > 0
                    ? `목표초과 +${excessPendingCnt}개`
                    : targetPendingCnt > 0
                    ? `목표 Pending ${targetPendingCnt}개 유지중`
                    : `Running 전환 대기`
                })</span>`
              : `대기 0개 <span style="font-size:12.5px; font-weight:600; color:#6ee7b7;">(전원 Running!)</span>`
          }
        </div>
        <div style="font-size:11.5px; color:#cbd5e1; margin-top:2px;">
          ${
            remainingCnt > 0 && targetPendingCnt > 0
              ? `부족한 Pending <b>+${remainingCnt}개</b> 일괄 연속 보충 · Running 전환 시 즉시 보충 (주기 점검: <b>${
                  intervalSec >= 60 && intervalSec % 60 === 0 ? `${intervalSec / 60}분(${intervalSec}초)` : `${intervalSec}초`
                }</b>)`
              : remainingCnt > 0
              ? `<b>${
                  intervalSec >= 60 && intervalSec % 60 === 0 ? `${intervalSec / 60}분(${intervalSec}초)` : `${intervalSec}초`
                }</b>마다 1개씩 자동 생성 · 약 <b>${Math.ceil((remainingCnt * intervalSec) / 60)}분</b> 내 전부 생성`
              : targetPendingCnt > 0
              ? `목표 Pending <b>${targetPendingCnt}개</b> 유지 완료 · Running 진입 시 즉시 새 Pending 보충`
              : pendingCnt > 0
              ? `목표 ${targetCnt}개 신청 완료 · 클러스터 GPU 노드 배정 시 Running 진입`
              : `추가 생성 대기 없음 (목표 Running 100% 충족)`
          }
        </div>
      </div>

      <div style="background:rgba(15,23,42,0.82); border:1.5px solid ${
        targetPendingCnt > 0 ? "rgba(245,158,11,0.75)" : "rgba(245,158,11,0.38)"
      }; border-radius:8px; padding:10px 12px;">
        <div style="font-size:11.5px; color:#fde68a; font-weight:700;">⏳ 유지할 목표 Pending 대기 개수 (빠른 지정)</div>
        <div style="display:flex; align-items:center; gap:4px; margin-top:4px; flex-wrap:wrap;">
          <span class="mono" style="font-size:19px; font-weight:800; color:${
            targetPendingCnt > 0 ? "#fbbf24" : "#94a3b8"
          }; margin-right:3px;">${targetPendingCnt > 0 ? `${targetPendingCnt}개` : "자동(OFF)"}</span>
          <button type="button" class="secondary sm" style="padding:2px 6px; ${
            targetPendingCnt === 0 ? "background:#475569; border-color:#94a3b8; color:#fff;" : ""
          }" onclick="quickUpdateTargetPending('${escapeHtml(jf.jobId)}', 0)" title="0으로 설정 시 전체 목표 워커 수 기준으로 자동 운영">해제(0)</button>
          <button type="button" class="secondary sm" style="padding:2px 6px;" onclick="quickUpdateTargetPending('${escapeHtml(jf.jobId)}', { delta: -1 })">-1</button>
          <button type="button" class="secondary sm" style="padding:2px 6px;" onclick="quickUpdateTargetPending('${escapeHtml(jf.jobId)}', { delta: 1 })">+1</button>
          <button type="button" class="secondary sm" style="padding:2px 6px; ${
            targetPendingCnt === 2 ? "background:#d97706; border-color:#fbbf24; color:#fff;" : ""
          }" onclick="quickUpdateTargetPending('${escapeHtml(jf.jobId)}', 2)">2</button>
          <button type="button" class="secondary sm" style="padding:2px 6px; ${
            targetPendingCnt === 5 ? "background:#d97706; border-color:#fbbf24; color:#fff;" : ""
          }" onclick="quickUpdateTargetPending('${escapeHtml(jf.jobId)}', 5)">5</button>
          <button type="button" class="secondary sm" style="padding:2px 6px; ${
            targetPendingCnt === 8 ? "background:#d97706; border-color:#fbbf24; color:#fff;" : ""
          }" onclick="quickUpdateTargetPending('${escapeHtml(jf.jobId)}', 8)">8</button>
          <button type="button" class="secondary sm" style="padding:2px 6px; ${
            targetPendingCnt === 10 ? "background:#d97706; border-color:#fbbf24; color:#fff;" : ""
          }" onclick="quickUpdateTargetPending('${escapeHtml(jf.jobId)}', 10)">10</button>
          <input type="number" id="quickTargetPendingInput" class="mono" min="0" max="9999" value="${targetPendingCnt}" style="width:56px; padding:3px 5px; font-size:12px;" title="유지할 목표 Pending 대기 개수 (0=해제)" />
          <button type="button" class="sm" style="padding:3px 8px; background:#d97706;" onclick="quickUpdateTargetPending('${escapeHtml(jf.jobId)}', Number(document.getElementById('quickTargetPendingInput').value || 0))">적용</button>
        </div>
        <div style="font-size:11px; color:#cbd5e1; margin-top:3px;">
          ${
            targetPendingCnt > 0
              ? `현재 Pending <b style="color:#fde68a;">${pendingCnt}개</b> / 목표 <b style="color:#fbbf24;">${targetPendingCnt}개</b> (Running 진입 시 즉시 보충)`
              : `1 이상 입력 시 해당 개수만큼 Pending 대기열을 항상 유지합니다`
          }
        </div>
      </div>

      <div style="background:rgba(15,23,42,0.75); border:1px solid rgba(59,130,246,0.45); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11.5px; color:#94a3b8;">🎯 유지할 목표 총 워커 수 (빠른 변경)</div>
        <div style="display:flex; align-items:center; gap:5px; margin-top:4px; flex-wrap:wrap;">
          <span class="mono" style="font-size:20px; font-weight:800; color:#60a5fa; margin-right:4px;">${targetCnt}개</span>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', { delta: -4 })">-4</button>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', { delta: 4 })">+4</button>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', 48)">48</button>
          <button type="button" class="secondary sm" style="padding:2px 7px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', 56)">56</button>
          <input type="number" id="quickTargetInput" class="mono" min="1" max="9999" value="${targetCnt}" style="width:64px; padding:3px 6px; font-size:12.5px;" />
          <button type="button" class="sm" style="padding:3px 8px;" onclick="quickUpdateTargetWorkers('${escapeHtml(jf.jobId)}', Number(document.getElementById('quickTargetInput').value || 1))">적용</button>
        </div>
        <div style="font-size:11.5px; color:#cbd5e1; margin-top:3px;">
          목표 총 GPU: <b>${targetGpus}장</b> (워커당 GPU ${gpusPerWorker}장)
        </div>
      </div>

      <div style="background:rgba(15,23,42,0.75); border:1px solid rgba(168,85,247,0.45); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11.5px; color:#94a3b8;">⏱️ 워커 자동 할당·생성 주기 (초/분)</div>
        <div style="display:flex; align-items:center; gap:4px; margin-top:4px; flex-wrap:wrap;">
          <span class="mono" style="font-size:18px; font-weight:800; color:#c084fc; margin-right:3px;">${
            intervalSec >= 60 && intervalSec % 60 === 0 ? `${intervalSec / 60}분(${intervalSec}초)` : `${intervalSec}초`
          }</span>
          <button type="button" class="secondary sm" style="padding:2px 5px; ${intervalSec === 15 ? "background:#7c3aed; border-color:#c084fc; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 15)">15초</button>
          <button type="button" class="secondary sm" style="padding:2px 5px; ${intervalSec === 30 ? "background:#7c3aed; border-color:#c084fc; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 30)">30초</button>
          <button type="button" class="secondary sm" style="padding:2px 5px; ${intervalSec === 60 ? "background:#7c3aed; border-color:#c084fc; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 60)">1분</button>
          <button type="button" class="secondary sm" style="padding:2px 5px; ${intervalSec === 120 ? "background:#7c3aed; border-color:#c084fc; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 120)">2분</button>
          <button type="button" class="secondary sm" style="padding:2px 5px; ${intervalSec === 180 ? "background:#7c3aed; border-color:#c084fc; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 180)">3분</button>
          <button type="button" class="secondary sm" style="padding:2px 6px; font-weight:700; ${intervalSec === 300 ? "background:#7c3aed; border-color:#c084fc; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 300)">5분</button>
          <button type="button" class="secondary sm" style="padding:2px 6px; font-weight:800; ${intervalSec === 600 ? "background:#7c3aed; border-color:#c084fc; color:#fff;" : "border-color:rgba(192,132,252,0.55); color:#e9d5ff;"}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 600)">10분</button>
          <button type="button" class="secondary sm" style="padding:2px 6px; ${intervalSec === 900 ? "background:#7c3aed; border-color:#c084fc; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 900)">15분</button>
          <button type="button" class="secondary sm" style="padding:2px 6px; ${intervalSec === 1800 ? "background:#7c3aed; border-color:#c084fc; color:#fff;" : ""}" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', 1800)">30분</button>
          <input type="number" id="quickIntervalInput" class="mono" min="1" max="86400" value="${intervalSec}" style="width:62px; padding:3px 5px; font-size:12px;" title="직접 초 단위 입력 (예: 180=3분, 300=5분, 600=10분, 1800=30분)" />
          <button type="button" class="sm" style="padding:3px 8px;" onclick="quickUpdateSpawnInterval('${escapeHtml(jf.jobId)}', Number(document.getElementById('quickIntervalInput').value || 15))">적용</button>
        </div>
        <div style="font-size:11.5px; color:#cbd5e1; margin-top:3px;">
          워커 1개 생성 후 다음 자동 할당까지 간격 (15초 ~ 30분 또는 초 단위 직접 입력)
        </div>
      </div>
    </div>
  `;
  updateHtmlIfSigChanged(document.getElementById("wfMetricCardsSection"), metricSig, metricHtml);

  // 5. Dual Progress Bar (only update when percentages or load badge change)
  const progSig = `${runningCnt}|${pendingCnt}|${activeCnt}|${targetCnt}|${runningPct}|${pendingPct}|${fleet.loadMonitor?.loadBadgeText || ""}`;
  const progHtml = `
    <div style="margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; font-size:12px; color:#cbd5e1; margin-bottom:4px; flex-wrap:wrap; gap:6px;">
        <span>🟢 실제 Running 달성률: <b style="color:#34d399;">${runningCnt} / ${targetCnt} 워커 (${runningPct}%)</b> &nbsp;·&nbsp; ⏳ Pending 대기: <b style="color:#fde68a;">${pendingCnt}개</b> (전체 활성 ${activeCnt}/${targetCnt}개)</span>
        <span>🛡️ 부하보호: <b>${escapeHtml(fleet.loadMonitor?.loadBadgeText || "🟢 쾌적 · 안전 할당")}</b> <span id="wfAvgApiSpan">(API 평균 ${fleet.loadMonitor?.api?.avgLatencyMs ?? 0}ms)</span></span>
        <span id="wfGpuHoursSpan">📊 누적 가동: <b>${tel.totalGpuHours ?? 0} GPU-Hours</b> (오늘 ${tel.todayGpuHours ?? 0} GPU-h)</span>
      </div>
      <div style="width:100%; height:10px; background:rgba(15,23,42,0.8); border-radius:999px; overflow:hidden; border:1px solid rgba(148,163,184,0.25); display:flex;">
        <div style="width:${runningPct}%; height:100%; background:linear-gradient(90deg, #10b981, #34d399); transition:width 0.3s ease;" title="실제 Running: ${runningCnt}개"></div>
        <div style="width:${pendingPct}%; height:100%; background:linear-gradient(90deg, #f59e0b, #fbbf24); transition:width 0.3s ease;" title="Pending 대기: ${pendingCnt}개"></div>
      </div>
    </div>
  `;
  if (!updateHtmlIfSigChanged(document.getElementById("wfProgressBarSection"), progSig, progHtml)) {
    const apiEl = document.getElementById("wfAvgApiSpan");
    if (apiEl) apiEl.textContent = `(API 평균 ${fleet.loadMonitor?.api?.avgLatencyMs ?? 0}ms)`;
    const gpuEl = document.getElementById("wfGpuHoursSpan");
    if (gpuEl) gpuEl.innerHTML = `📊 누적 가동: <b>${tel.totalGpuHours ?? 0} GPU-Hours</b> (오늘 ${tel.todayGpuHours ?? 0} GPU-h)`;
  }

  // 6. Slot Selection & Freeze Control Bar
  const slotBarSig = [
    jf.jobId,
    activeWorkers.length,
    runningCnt,
    pendingCnt,
    excessPendingCnt,
    selectedWorkerRunIds.size,
    instantKillWithoutConfirm ? 1 : 0,
    autoFreezeOnSlotHover ? 1 : 0,
    isSlotBoardFrozen ? 1 : 0,
  ].join("|");
  const freezeBadgeStyle =
    isSlotBoardFrozen || (autoFreezeOnSlotHover && isMouseOverSlotGrid) ? "display:inline-flex;" : "display:none;";
  const freezeBadgeText = isSlotBoardFrozen
    ? "🔒 슬롯 화면 수동 고정 중"
    : "⏸️ 마우스 올림 — 슬롯 움직임 일시 고정됨";
  const slotBarHtml = `
    <div style="margin-bottom:8px; padding:8px 11px; border-radius:8px; background:rgba(15,23,42,0.88); border:1.5px solid rgba(244,63,94,0.45); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11.5px;">
        <span style="font-weight:800; color:#fda4af;">🎯 특정 슬롯 직접 선택 &amp; 즉시 Kill:</span>
        <button type="button" class="secondary sm" style="padding:2px 7px; font-size:11px;" onclick="selectWorkerGroup('all', '${escapeHtml(jf.jobId)}')">☑️ 전체(${activeWorkers.length})</button>
        <button type="button" class="secondary sm" style="padding:2px 7px; font-size:11px; color:#6ee7b7;" onclick="selectWorkerGroup('running', '${escapeHtml(jf.jobId)}')">🟢 Running(${runningCnt})</button>
        <button type="button" class="secondary sm" style="padding:2px 7px; font-size:11px; color:#fde68a;" onclick="selectWorkerGroup('pending', '${escapeHtml(jf.jobId)}')">⏳ Pending(${pendingCnt})</button>
        ${
          excessPendingCnt > 0
            ? `<button type="button" class="secondary sm" style="padding:2px 7px; font-size:11px; border-color:#fbbf24; color:#fde68a; font-weight:700;" onclick="selectWorkerGroup('excess', '${escapeHtml(jf.jobId)}')">⚠️ 초과Pending(+${excessPendingCnt})</button>`
            : ""
        }
        <button type="button" class="secondary sm" style="padding:2px 7px; font-size:11px; color:#fca5a5;" onclick="selectWorkerGroup('problem', '${escapeHtml(jf.jobId)}')">🚨 에러·느림</button>
        <button type="button" class="secondary sm" style="padding:2px 7px; font-size:11px; color:#94a3b8;" onclick="selectWorkerGroup('none', '${escapeHtml(jf.jobId)}')">✖ 선택해제</button>

        <div style="display:inline-flex; align-items:center; gap:4px; margin-left:2px;">
          <input type="text" id="slotRangeKillInput" class="mono"
            placeholder="슬롯번호 (예: 1, 5, 58-62, #353028)"
            value="${escapeHtml(slotSpecDraftText)}"
            oninput="slotSpecDraftText = this.value"
            onkeydown="if(event.key==='Enter'){ event.preventDefault(); applySlotSpecSelection('${escapeHtml(jf.jobId)}'); }"
            style="width:195px; padding:3px 7px; font-size:11.5px; border-color:rgba(56,189,248,0.45);" />
          <button type="button" class="secondary sm" style="padding:3px 7px; font-size:11px; border-color:rgba(56,189,248,0.5); color:#7dd3fc;"
            onclick="applySlotSpecSelection('${escapeHtml(jf.jobId)}')"
            title="입력한 슬롯 번호(예: 1, 5, 58-62) 또는 #RunID를 즉시 체크 선택합니다">번호선택</button>
        </div>

        <span id="wfSlotFreezeStatusBadge" class="mono" style="${freezeBadgeStyle} align-items:center; gap:4px; padding:2px 8px; border-radius:999px; font-size:10.5px; font-weight:800; background:rgba(245,158,11,0.22); border:1px solid #fbbf24; color:#fde68a;">
          ${freezeBadgeText}
        </span>
      </div>

      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <label style="display:inline-flex; align-items:center; gap:4px; font-size:11px; color:#93c5fd; cursor:pointer; margin:0;" title="슬롯 영역에 마우스를 올리고 있을 때는 화면 새로고침이 일어나도 슬롯이 움직이거나 다시 그려지지 않게 자동 보호합니다">
          <input type="checkbox" ${autoFreezeOnSlotHover ? "checked" : ""} onchange="toggleAutoFreezeOnSlotHover(this.checked)" style="width:13px; height:13px; margin:0; accent-color:#38bdf8;" />
          🖱️ 마우스 올릴 때 슬롯 고정
        </label>
        <button type="button" class="secondary sm" style="padding:3px 8px; font-size:11px; font-weight:700; ${
          isSlotBoardFrozen
            ? "background:rgba(245,158,11,0.28); border-color:#fbbf24; color:#fef08a;"
            : "border-color:rgba(148,163,184,0.4); color:#cbd5e1;"
        }" onclick="toggleSlotBoardFreeze()" title="슬롯 화면을 수동으로 일시 고정하여 새로고침 시에도 전혀 움직이지 않게 합니다">
          ${isSlotBoardFrozen ? "🔒 슬롯 고정 중 (해제)" : "🔓 슬롯 화면 고정"}
        </button>
        <label style="display:inline-flex; align-items:center; gap:4px; font-size:11px; color:#fde68a; cursor:pointer; margin:0;" title="체크 시 각 슬롯의 [🛑Kill] / [🗑️삭제] 클릭 시 확인 팝업 없이 0.1초 만에 즉시 종료합니다">
          <input type="checkbox" ${instantKillWithoutConfirm ? "checked" : ""} onchange="toggleInstantKillMode(this.checked)" style="width:13px; height:13px; margin:0; accent-color:#f43f5e;" />
          ⚡ 원클릭 즉시 Kill
        </label>
        <button type="button" class="danger sm" style="padding:4px 10px; font-size:11.5px; font-weight:800;"
          onclick="executeSelectedWorkersKill(false, '${escapeHtml(jf.jobId)}')"
          title="선택한 슬롯(또는 입력창의 슬롯번호)을 즉시 강제 종료(Stop/Kill)합니다. 목표 워커 수는 그대로 유지되어 자동충원 ON 시 새 워커가 보충됩니다.">
          🛑 선택 슬롯(${selectedWorkerRunIds.size}개) 즉시 Stop/Kill <span style="font-size:10px; font-weight:600; opacity:0.9;">(자동충원 유지)</span>
        </button>
        <button type="button" class="secondary sm" style="padding:4px 10px; font-size:11.5px; font-weight:800; background:rgba(159,18,57,0.55); border-color:#f43f5e; color:#ffe4e6;"
          onclick="executeSelectedWorkersKill(true, '${escapeHtml(jf.jobId)}')"
          title="선택한 슬롯(또는 입력창의 슬롯번호)을 즉시 강제 종료(Kill)하고, 종료한 개수만큼 목표 워커 수도 함께 차감(-N)하여 다시 생성되지 않게 영구 삭제합니다.">
          🗑️ 선택 슬롯(${selectedWorkerRunIds.size}개) 영구 Delete <span style="font-size:10px; font-weight:600; color:#fda4af;">(Kill + 목표수 -${selectedWorkerRunIds.size || "N"} 차감)</span>
        </button>
      </div>
    </div>
  `;
  updateHtmlIfSigChanged(document.getElementById("wfSlotSelectionBar"), slotBarSig, slotBarHtml);

  // 7. Keyed Per-Slot DOM Patching (Unchanged slots are NEVER redrawn; paused while hovering or frozen)
  const slotGridEl = document.getElementById("wfSlotPillsGrid");
  patchSlotPillsGrid(slotGridEl, slotPills, Boolean(options.force));

  // 8. Advanced details sub-sections (preserves <details> open/closed state!)
  const autoTogglesSig = `${wd.enabled}|${wd.zombieTerminatedCount || 0}|${shardingOn}|${hf.enabled}|${ts.enabled}|${bng.enabled}|${pipe.autoStopOnComplete}`;
  const autoTogglesHtml = `
    <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11.5px;">
        <button type="button" class="${wd.enabled !== false ? "success" : "secondary"} sm" style="padding:3px 8px; font-size:11px;"
          onclick="quickUpdateAutomation({ watchdogEnabled: ${wd.enabled === false ? "true" : "false"} })">
          🧟 Watchdog: ${wd.enabled !== false ? `ON (교체 ${wd.zombieTerminatedCount || 0}건)` : "OFF"}
        </button>
        <button type="button" class="${shardingOn ? "success" : "secondary"} sm" style="padding:3px 8px; font-size:11px;"
          onclick="quickUpdateAutomation({ injectWorkerEnv: ${shardingOn ? "false" : "true"} })">
          🔢 WORKER_SLOT: ${shardingOn ? "ON" : "OFF"}
        </button>
        <button type="button" class="${hf.enabled !== false ? "success" : "secondary"} sm" style="padding:3px 8px; font-size:11px;"
          onclick="quickUpdateAutomation({ hybridFallbackEnabled: ${hf.enabled === false ? "true" : "false"} })">
          🔄 Spot↔Std 폴백: ${hf.enabled !== false ? "ON" : "OFF"}
        </button>
        <button type="button" class="${ts.enabled ? "success" : "secondary"} sm" style="padding:3px 8px; font-size:11px;"
          onclick="quickUpdateAutomation({ timeScaleEnabled: ${ts.enabled ? "false" : "true"} })">
          🌙 야간·주말 부스트: ${ts.enabled ? "ON" : "OFF"}
        </button>
        <button type="button" class="${bng.enabled !== false ? "success" : "secondary"} sm" style="padding:3px 8px; font-size:11px;"
          onclick="quickUpdateAutomation({ badNodeGuardEnabled: ${bng.enabled === false ? "true" : "false"} })">
          🩺 불량노드 가드: ${bng.enabled !== false ? "ON" : "OFF"}
        </button>
        <button type="button" class="${pipe.autoStopOnComplete !== false ? "success" : "secondary"} sm" style="padding:3px 8px; font-size:11px;"
          onclick="quickUpdateAutomation({ autoStopOnComplete: ${pipe.autoStopOnComplete === false ? "true" : "false"} })">
          ⛓️ 완료 자동정지: ${pipe.autoStopOnComplete !== false ? "ON" : "OFF"}
        </button>
      </div>
      <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
        <button type="button" class="secondary sm" style="padding:3px 8px; font-size:11px;" onclick="bulkControlWorkers('scan_logs')">🔍 전체 워커 로그 스캔</button>
        <button type="button" class="secondary sm" style="padding:3px 8px; font-size:11px;" onclick="bulkControlWorkers('rolling_restart', { batchSize: 1 })">🔄 1개씩 롤링 재시작</button>
      </div>
    </div>
  `;
  updateHtmlIfSigChanged(document.getElementById("wfAutomationToggles"), autoTogglesSig, autoTogglesHtml);

  const liveLogSig = workersWithLogs.map((w) => `${w.id}:${w.hasLogError}:${w.lastLogLine}`).join("||");
  updateHtmlIfSigChanged(document.getElementById("wfLiveLogSummary"), liveLogSig, liveLogSummaryHtml);

  const telSig = `${tel.totalGpuHours ?? 0}|${tel.todayGpuHours ?? 0}|${tsSeries.length}|${tsSeries[tsSeries.length - 1]?.time || ""}`;
  updateHtmlIfSigChanged(document.getElementById("wfTelemetryBoard"), telSig, telemetryBoardHtml);

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
  const jf = getFocusedJobFleet(latestWorkerFleet);
  const remainingCnt = jf.remainingToCreate ?? 0;
  const runningCnt = jf.runningCount ?? 0;
  const pendingCnt = jf.pendingCount ?? 0;
  const activeCnt = jf.activeCount ?? 0;
  const targetCnt = jf.targetCount ?? 1;
  const targetPendingCnt = jf.targetPendingCount ?? 0;
  const excessPendingCnt = jf.excessPendingCount ?? Math.max(0, Math.min(pendingCnt, activeCnt - targetCnt));
  const isAutoOn = Boolean(latestWorkerFleet.schedulerEnabled && jf.enabled);
  const schedStats = latestSchedulerStats || {};
  const effSchedSec = schedStats.effectiveIntervalSec || jf.scaleUpIntervalSec || 30;
  let nextSchedCheckSec = 0;
  if (schedStats.nextCheckAt) {
    nextSchedCheckSec = Math.max(0, Math.ceil((new Date(schedStats.nextCheckAt).getTime() - now) / 1000));
  }

  if (remainingCnt <= 0) {
    if (targetPendingCnt > 0) {
      const waitMsg = `✅ 목표 Pending 대기 <b>${pendingCnt}/${targetPendingCnt}개</b> 유지 중! — 현재 <b style="color:#34d399;">🟢 Running ${runningCnt}개</b> 가동 중이며 <b style="color:#fde68a;">⏳ Pending ${pendingCnt}개</b>가 GPU 노드 배정을 기다리고 있습니다.${
        excessPendingCnt > 0 ? ` (목표 Pending 대비 초과 +${excessPendingCnt}개)` : ""
      } (Running 진입 시 즉시 새 Pending 보충 · 다음 점검: <b>${nextSchedCheckSec}초 후</b>)`;
      if (el) el.innerHTML = waitMsg;
      if (topAllocEl) topAllocEl.innerHTML = waitMsg;
    } else if (runningCnt < targetCnt) {
      const waitMsg = `⏳ 목표 워커 <b>${targetCnt}개</b> 모두 신청 완료 — 현재 <b style="color:#34d399;">🟢 Running ${runningCnt}개</b> 가동 중이며 <b style="color:#fde68a;">⏳ Pending ${pendingCnt}개</b>가 클러스터 GPU 노드 배정을 기다리고 있습니다.${
        excessPendingCnt > 0 ? ` (목표 대비 초과 Pending +${excessPendingCnt}개)` : ""
      } (다음 감시 점검: <b>${nextSchedCheckSec}초 후</b>)`;
      if (el) el.innerHTML = waitMsg;
      if (topAllocEl) topAllocEl.innerHTML = waitMsg;
    } else {
      if (el) {
        el.innerHTML = `✨ 현재 목표 워커(<b>🟢 Running ${runningCnt}/${targetCnt}개</b>)가 전원 정상 가동 중입니다. (다음 자동 감시 점검: <b>${nextSchedCheckSec}초 후</b> · 종료 발생 시 즉시 자동 충원)`;
      }
      if (topAllocEl) {
        topAllocEl.innerHTML = `✅ 목표 Running 워커 <b>${runningCnt}/${targetCnt}개</b> 100% 가동 유지 중! (다음 무클릭 자동 감시 점검까지: <b style="color:#6ee7b7;">${nextSchedCheckSec}초</b> · 워커 종료 시 자동 재신청)`;
      }
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
  const perWorkerGapSec = targetPendingCnt > 0 ? 2 : jf.scaleUpIntervalSec || 15;
  const totalEstSec = remainSec + Math.max(0, remainingCnt - 1) * perWorkerGapSec;
  const mins = Math.floor(totalEstSec / 60);
  const secs = totalEstSec % 60;
  const targetDesc =
    targetPendingCnt > 0
      ? `남은 Pending 보충 <b>+${remainingCnt}개</b> (목표 Pending ${targetPendingCnt}개 일괄 채움)`
      : `남은 <b>+${remainingCnt}개</b> 전체 자동 신청`;
  const msgHtml =
    remainSec > 0
      ? `⏱️ 다음 <b>워커#${nextSlotNum}</b> 무클릭 자동 신청까지: <b style="color:#fde68a; font-size:13.5px;">${remainSec}초</b> 남음 &nbsp;|&nbsp; ${targetDesc} 완료 예상: 약 <b>${mins > 0 ? `${mins}분 ` : ""}${secs}초</b>`
      : `⚡ 지금 <b>워커#${nextSlotNum}</b> 무클릭 자동 신청 및 Admin 즉시 승인 요청 중... (${targetDesc})`;
  if (el) el.innerHTML = msgHtml;
  if (topAllocEl) topAllocEl.innerHTML = msgHtml;
}

async function quickUpdateTargetWorkers(jobId, valueOrOpts) {
  const jf = (latestWorkerFleet?.jobs || []).find((j) => j.jobId === jobId) || latestWorkerFleet?.jobs?.[0] || null;
  const quickInputEl = document.getElementById("quickTargetInput");
  const baseVal = Number(quickInputEl?.value ?? jf?.targetCount ?? 1);
  const rawTarget =
    typeof valueOrOpts === "object" && valueOrOpts !== null && valueOrOpts.delta !== undefined
      ? baseVal + Number(valueOrOpts.delta || 0)
      : Number(valueOrOpts || 1);
  const target = Math.max(1, Math.min(9999, rawTarget));
  if (quickInputEl) quickInputEl.value = target;
  const minInput = document.getElementById("jobMinConcurrent");
  if (minInput) minInput.value = target;
  if (jf) {
    jf.targetCount = target;
    renderWorkerFleetBoard(latestWorkerFleet, { force: true });
  }
  try {
    const res = await api("/api/jobs/target", {
      method: "POST",
      body: JSON.stringify({
        jobId,
        minConcurrentRuns: target,
      }),
    });
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet, { force: true });
    }
    showToast(`🎯 목표 워커 수가 ${target}개로 변경되었습니다!`);
    await loadServerState();
  } catch (e) {
    alert("목표 워커 수 변경 실패: " + e.message);
  }
}

async function quickUpdateTargetPending(jobId, valueOrOpts) {
  const jf = (latestWorkerFleet?.jobs || []).find((j) => j.jobId === jobId) || latestWorkerFleet?.jobs?.[0] || null;
  const quickInputEl = document.getElementById("quickTargetPendingInput");
  const baseVal = Number(quickInputEl?.value ?? jf?.targetPendingCount ?? 0);
  const rawTargetPending =
    typeof valueOrOpts === "object" && valueOrOpts !== null && valueOrOpts.delta !== undefined
      ? baseVal + Number(valueOrOpts.delta || 0)
      : Number(valueOrOpts ?? 0);
  const targetPending = Math.max(0, Math.min(9999, rawTargetPending));
  if (quickInputEl) quickInputEl.value = targetPending;
  const pendInput = document.getElementById("jobTargetPending");
  if (pendInput) pendInput.value = targetPending;
  if (jf) {
    jf.targetPendingCount = targetPending;
    jf.remainingToSpawn = targetPending > 0 ? Math.max(0, targetPending - (jf.pendingCount || 0)) : Math.max(0, (jf.targetCount || 1) - (jf.activeCount || 0));
    renderWorkerFleetBoard(latestWorkerFleet, { force: true });
  }
  try {
    const res = await api("/api/jobs/target", {
      method: "POST",
      body: JSON.stringify({
        jobId,
        targetPendingRuns: targetPending,
      }),
    });
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet, { force: true });
    }
    showToast(
      targetPending > 0
        ? `⏳ 목표 Pending 대기 개수가 ${targetPending}개로 지정되었습니다! (부족 시 즉시 ${targetPending}개까지 일괄 보충)`
        : `⏳ 목표 Pending 대기 개수 지정이 해제(0)되었습니다! (전체 목표 워커 수 기준으로 자동 운영)`
    );
    await loadServerState();
  } catch (e) {
    alert("목표 Pending 대기 개수 변경 실패: " + e.message);
  }
}

async function quickUpdateSpawnInterval(jobId, newIntervalSec) {
  const sec = Math.max(1, Math.min(86400, Number(newIntervalSec || 15)));
  const label = sec >= 60 && sec % 60 === 0 ? `${sec / 60}분(${sec}초)` : `${sec}초`;
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
      renderWorkerFleetBoard(latestWorkerFleet, { force: true });
    }
    showToast(`⏱️ 워커 자동 생성 주기가 ${label}로 변경되었습니다!`);
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
  const activeProf = getActiveSiteProfile(currentSiteId);
  const siteHost = getActiveSiteHost(currentSiteId);
  const siteLabel = `${activeProf.id.toUpperCase()} (${activeProf.gpuModel})`;
  const activeId = document.activeElement?.id || "";
  if (activeId !== "cfgBaseUrl") document.getElementById("cfgBaseUrl").value = cfg.baseUrl || activeProf.baseUrl || "https://mlp.n9.sr-cloud.com";
  if (activeId !== "cfgSfmUrl") document.getElementById("cfgSfmUrl").value = cfg.sfmUrl || activeProf.sfmUrl || "https://sfsm.n9.sr-cloud.com";
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
  const smartGuardEl = document.getElementById("cfgSmartLoadGuardEnabled");
  if (smartGuardEl) smartGuardEl.checked = cfg.smartLoadGuardEnabled !== false;
  if (activeId !== "cfgMaxPendingWorkers" && document.getElementById("cfgMaxPendingWorkers")) {
    document.getElementById("cfgMaxPendingWorkers").value = cfg.maxPendingWorkers ?? 2;
  }
  if (activeId !== "cfgApiLatencyWarnMs" && document.getElementById("cfgApiLatencyWarnMs")) {
    document.getElementById("cfgApiLatencyWarnMs").value = cfg.apiLatencyWarnMs ?? 1800;
  }
  if (activeId !== "cfgApiLatencyCriticalMs" && document.getElementById("cfgApiLatencyCriticalMs")) {
    document.getElementById("cfgApiLatencyCriticalMs").value = cfg.apiLatencyCriticalMs ?? 3500;
  }
  const stepCheckEl = document.getElementById("cfgStepByStepRunningCheck");
  if (stepCheckEl) stepCheckEl.checked = cfg.stepByStepRunningCheck !== false;

  // Features 1–6 Config Inputs
  const wdEl = document.getElementById("cfgWatchdogEnabled");
  if (wdEl) wdEl.checked = cfg.watchdogEnabled !== false;
  if (activeId !== "cfgMaxPendingTimeoutMin" && document.getElementById("cfgMaxPendingTimeoutMin")) {
    document.getElementById("cfgMaxPendingTimeoutMin").value = cfg.maxPendingTimeoutMin ?? 20;
  }
  const logRestartEl = document.getElementById("cfgLogErrorAutoRestart");
  if (logRestartEl) logRestartEl.checked = Boolean(cfg.logErrorAutoRestart);
  const injEnvEl = document.getElementById("cfgInjectWorkerEnv");
  if (injEnvEl) injEnvEl.checked = Boolean(cfg.injectWorkerEnv);
  const hybEl = document.getElementById("cfgHybridFallbackEnabled");
  if (hybEl) hybEl.checked = cfg.hybridFallbackEnabled !== false;
  const tsEl = document.getElementById("cfgTimeScaleEnabled");
  if (tsEl) tsEl.checked = Boolean(cfg.timeScaleEnabled);
  if (activeId !== "cfgDayTargetWorkers" && document.getElementById("cfgDayTargetWorkers")) {
    document.getElementById("cfgDayTargetWorkers").value = cfg.dayTargetWorkers ?? 20;
  }
  if (activeId !== "cfgNightTargetWorkers" && document.getElementById("cfgNightTargetWorkers")) {
    document.getElementById("cfgNightTargetWorkers").value = cfg.nightTargetWorkers ?? 48;
  }
  if (activeId !== "cfgWeekendTargetWorkers" && document.getElementById("cfgWeekendTargetWorkers")) {
    document.getElementById("cfgWeekendTargetWorkers").value = cfg.weekendTargetWorkers ?? 64;
  }
  if (activeId !== "cfgWebhookUrl" && document.getElementById("cfgWebhookUrl")) {
    document.getElementById("cfgWebhookUrl").value = cfg.webhookUrl || "";
  }
  const bNotifEl = document.getElementById("cfgBrowserNotifyEnabled");
  if (bNotifEl) bNotifEl.checked = cfg.browserNotifyEnabled !== false;

  // Batch 2 Config Inputs
  const bngEl = document.getElementById("cfgBadNodeGuardEnabled");
  if (bngEl) bngEl.checked = cfg.badNodeGuardEnabled !== false;
  if (activeId !== "cfgBadNodeCooldownSec" && document.getElementById("cfgBadNodeCooldownSec")) {
    document.getElementById("cfgBadNodeCooldownSec").value = cfg.badNodeCooldownSec ?? 25;
  }
  const syncScriptEl = document.getElementById("cfgSyncEditedScriptsOnStart");
  if (syncScriptEl) syncScriptEl.checked = cfg.syncEditedScriptsOnStart !== false;
  const autoStopEl = document.getElementById("cfgAutoStopOnComplete");
  if (autoStopEl) autoStopEl.checked = cfg.autoStopOnComplete !== false;
  if (activeId !== "cfgAutoStopOnCompleteKeyword" && document.getElementById("cfgAutoStopOnCompleteKeyword")) {
    document.getElementById("cfgAutoStopOnCompleteKeyword").value =
      cfg.autoStopOnCompleteKeyword ?? "ALL_TASKS_COMPLETED,TRAINING_FINISHED,PIPELINE_DONE";
  }
  if (activeId !== "cfgMaxTotalSucceededRuns" && document.getElementById("cfgMaxTotalSucceededRuns")) {
    document.getElementById("cfgMaxTotalSucceededRuns").value = cfg.maxTotalSucceededRuns ?? 0;
  }
  if (activeId !== "cfgNextStageCommand" && document.getElementById("cfgNextStageCommand")) {
    document.getElementById("cfgNextStageCommand").value = cfg.nextStageCommand || "";
  }

  document.getElementById("cfgSchedulerEnabled").checked = Boolean(cfg.schedulerEnabled);

  const loadGuardBadge = document.getElementById("loadGuardBadge");
  if (loadGuardBadge) {
    const lm = latestLoadMonitor || {};
    if (cfg.smartLoadGuardEnabled === false) {
      loadGuardBadge.className = "badge warn";
      loadGuardBadge.textContent = "🛡️ 부하보호: OFF";
    } else {
      const lv = lm.loadLevel || "GREEN";
      loadGuardBadge.className = lv === "GREEN" ? "badge ok" : lv === "RED" ? "badge err" : "badge warn";
      loadGuardBadge.textContent = lm.loadBadgeText || `🛡️ 부하보호: ON (동시준비 ≤${cfg.maxPendingWorkers ?? 2}개)`;
    }
  }

  const jwtBadge = document.getElementById("jwtBadge");
  const card1Banner = document.getElementById("card1TokenStatusBanner");
  const monTokenBar = document.getElementById("monitorTokenAlertBar");
  const monTokenText = document.getElementById("monitorTokenAlertText");
  if (cfg.jwtInfo) {
    const rem = cfg.jwtInfo.remainingSec;
    const mins = rem !== null ? Math.floor(rem / 60) : null;
    const userLabel = cfg.userName || cfg.resolvedUserName || cfg.jwtInfo.sub || "User";
    if (rem !== null && rem > 0) {
      jwtBadge.className = "badge ok";
      jwtBadge.textContent = `🟢 [${siteLabel}] 인증됨: ${userLabel} (${mins}분 남음)`;
      if (monTokenBar) monTokenBar.style.display = "none";
      if (card1Banner) {
        card1Banner.style.background = "rgba(16, 185, 129, 0.14)";
        card1Banner.style.borderColor = "rgba(16, 185, 129, 0.45)";
        card1Banner.style.color = "#6ee7b7";
        card1Banner.innerHTML = `🟢 <b>[${escapeHtml(siteLabel)}] SPACE 토큰 정상 인증됨</b> — 계정: <code>${escapeHtml(userLabel)}</code> · 그룹: <code>${escapeHtml(cfg.groupId || "자동")}</code> · 남은 시간: <b>${mins}분</b> ${cfg.hasRefreshToken ? "(Refresh 자동 갱신 활성)" : ""}`;
      }
    } else {
      const expiredMins = mins !== null ? Math.abs(mins) : "?";
      jwtBadge.className = "badge err";
      jwtBadge.textContent = `🚨 [${siteLabel}] 토큰 만료됨 (${expiredMins}분 전 만료)`;
      if (monTokenBar && monTokenText) {
        monTokenBar.style.display = "flex";
        monTokenText.innerHTML = `🚨 <b>[${escapeHtml(siteLabel)}] 저장된 SPACE 인증 토큰이 만료되었습니다 (${expiredMins}분 전 만료)</b> — 우측 버튼을 눌러 <code>${escapeHtml(siteHost)}</code> 새 토큰을 붙여넣어 주세요.`;
      }
      if (card1Banner) {
        card1Banner.style.background = "rgba(239, 68, 68, 0.16)";
        card1Banner.style.borderColor = "rgba(239, 68, 68, 0.55)";
        card1Banner.style.color = "#fca5a5";
        card1Banner.innerHTML = `🚨 <b>[${escapeHtml(siteLabel)}] 저장된 SPACE 토큰이 만료되었습니다 (${expiredMins}분 전 만료)</b> — 먼저 <code>${escapeHtml(siteHost)}</code> 탭을 <b>새로고침(<code>F5</code>)하여 재로그인</b>한 뒤 아래에 새 토큰을 붙여넣어 주세요!`;
      }
    }
  } else if (cfg.hasAccessToken) {
    jwtBadge.className = "badge ok";
    jwtBadge.textContent = `[${siteLabel}] Access Token 설정됨`;
    if (monTokenBar) monTokenBar.style.display = "none";
  } else {
    jwtBadge.className = "badge warn";
    jwtBadge.textContent = `[${siteLabel}] 토큰 미설정`;
    if (monTokenBar && monTokenText) {
      monTokenBar.style.display = "flex";
      monTokenText.innerHTML = `⚠️ <b>[${escapeHtml(siteLabel)}] SPACE 토큰이 아직 설정되지 않았습니다.</b> 우측 버튼을 눌러 설정 화면에서 <code>${escapeHtml(siteHost)}</code> 토큰을 등록해 주세요.`;
    }
    if (card1Banner) {
      card1Banner.style.background = "rgba(245, 158, 11, 0.14)";
      card1Banner.style.borderColor = "rgba(245, 158, 11, 0.45)";
      card1Banner.style.color = "#fde68a";
      card1Banner.innerHTML = `⚠️ <b>[${escapeHtml(siteLabel)}] SPACE 토큰이 아직 설정되지 않았습니다.</b> <code>${escapeHtml(siteHost)}</code> 콘솔에서 토큰을 복사해 아래에 붙여넣어 주세요.`;
    }
  }

  document.getElementById("groupBadge").textContent = `${activeProf.id.toUpperCase()} Group ID: ${cfg.groupId || "미설정"}`;

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

async function saveConfig(overrideSiteId = "") {
  try {
    const targetSiteId = overrideSiteId || currentSiteId;
    const payload = {
      siteId: targetSiteId,
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
      smartLoadGuardEnabled: document.getElementById("cfgSmartLoadGuardEnabled")
        ? document.getElementById("cfgSmartLoadGuardEnabled").checked
        : true,
      maxPendingWorkers: Number(document.getElementById("cfgMaxPendingWorkers")?.value || 2),
      apiLatencyWarnMs: Number(document.getElementById("cfgApiLatencyWarnMs")?.value || 1800),
      apiLatencyCriticalMs: Number(document.getElementById("cfgApiLatencyCriticalMs")?.value || 3500),
      stepByStepRunningCheck: document.getElementById("cfgStepByStepRunningCheck")
        ? document.getElementById("cfgStepByStepRunningCheck").checked
        : true,
      watchdogEnabled: document.getElementById("cfgWatchdogEnabled")
        ? document.getElementById("cfgWatchdogEnabled").checked
        : true,
      maxPendingTimeoutMin: Number(document.getElementById("cfgMaxPendingTimeoutMin")?.value || 20),
      logErrorAutoRestart: document.getElementById("cfgLogErrorAutoRestart")
        ? document.getElementById("cfgLogErrorAutoRestart").checked
        : true,
      injectWorkerEnv: document.getElementById("cfgInjectWorkerEnv")
        ? document.getElementById("cfgInjectWorkerEnv").checked
        : false,
      hybridFallbackEnabled: document.getElementById("cfgHybridFallbackEnabled")
        ? document.getElementById("cfgHybridFallbackEnabled").checked
        : true,
      timeScaleEnabled: document.getElementById("cfgTimeScaleEnabled")
        ? document.getElementById("cfgTimeScaleEnabled").checked
        : false,
      dayTargetWorkers: Number(document.getElementById("cfgDayTargetWorkers")?.value || 20),
      nightTargetWorkers: Number(document.getElementById("cfgNightTargetWorkers")?.value || 48),
      weekendTargetWorkers: Number(document.getElementById("cfgWeekendTargetWorkers")?.value || 64),
      webhookUrl: document.getElementById("cfgWebhookUrl")?.value || "",
      browserNotifyEnabled: document.getElementById("cfgBrowserNotifyEnabled")
        ? document.getElementById("cfgBrowserNotifyEnabled").checked
        : true,
      badNodeGuardEnabled: document.getElementById("cfgBadNodeGuardEnabled")
        ? document.getElementById("cfgBadNodeGuardEnabled").checked
        : true,
      badNodeCooldownSec: Number(document.getElementById("cfgBadNodeCooldownSec")?.value || 25),
      syncEditedScriptsOnStart: document.getElementById("cfgSyncEditedScriptsOnStart")
        ? document.getElementById("cfgSyncEditedScriptsOnStart").checked
        : true,
      autoStopOnComplete: document.getElementById("cfgAutoStopOnComplete")
        ? document.getElementById("cfgAutoStopOnComplete").checked
        : true,
      autoStopOnCompleteKeyword: document.getElementById("cfgAutoStopOnCompleteKeyword")?.value || "",
      maxTotalSucceededRuns: Number(document.getElementById("cfgMaxTotalSucceededRuns")?.value || 0),
      nextStageCommand: document.getElementById("cfgNextStageCommand")?.value || "",
      schedulerEnabled: document.getElementById("cfgSchedulerEnabled").checked,
    };
    const resCfg = await api("/api/config", {
      method: "POST",
      headers: { "X-Site-Id": targetSiteId },
      body: JSON.stringify(payload),
    });
    if (resCfg.siteId && resCfg.siteId !== currentSiteId) {
      currentSiteId = resCfg.siteId;
      try {
        localStorage.setItem("space_active_site_id", currentSiteId);
      } catch {}
    }
    applyUiRefreshInterval(payload.uiRefreshIntervalSec);
    const savedProf = getActiveSiteProfile(currentSiteId);
    showToast(
      `✅ [${savedProf.id.toUpperCase()} · ${savedProf.gpuModel}] 설정 저장 완료! (GPU 체크: ${payload.checkIntervalSec}초 / 승인 감시: ${payload.approvalCheckIntervalSec}초)`
    );
    await loadServerState();
    if (payload.accessToken) {
      await discoverSpaceResources({ silent: true });
    }
  } catch (e) {
    alert("설정 저장 실패: " + e.message);
  }
}

async function quickUpdateAutomation(patch = {}) {
  try {
    const res = await api("/api/automation/quick-update", {
      method: "POST",
      body: JSON.stringify(patch),
    });
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet);
    }
    showToast("⚡ 스마트 자동화 설정이 즉시 반영되었습니다!");
    await loadServerState();
  } catch (e) {
    alert("스마트 자동화 설정 변경 실패: " + e.message);
  }
}

async function bulkControlWorkers(action, extra = {}) {
  try {
    if (action === "stop_all") {
      const ok = confirm("정말 현재 가동 중인 모든 워커를 일괄 종료하시겠습니까? (주기적 자동 생성도 함께 일시정지됩니다)");
      if (!ok) return;
    } else if (action === "stop_pending") {
      const ok = confirm("현재 Pending / 준비 대기 중인 워커들을 모두 취소하시겠습니까?");
      if (!ok) return;
    } else if (action === "trim_excess_pending") {
      showToast("✂️ 목표 워커 수를 초과한 Pending 대기 워커만 정리하여 목표 수량에 맞춥니다...");
    } else if (action === "rolling_restart") {
      showToast("🔄 가장 오래된 Running 워커 1개를 종료하고 최신 스크립트로 무중단 교체합니다...");
    } else if (action === "scan_logs") {
      showToast("🔍 가동 중인 모든 워커의 최신 로그(마지막 30줄) 및 에러 여부를 스캔합니다...");
    }

    const res = await api("/api/space/runs/bulk-action", {
      method: "POST",
      body: JSON.stringify({ action, ...extra }),
    });
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet);
    }
    if (action === "scan_logs") {
      showToast(`✅ 워커 ${res.scannedCount || 0}개의 실시간 로그 스캔 완료!`);
    } else if (action === "rolling_restart") {
      showToast(`🔄 롤링 재시작: 워커 ${res.terminatedCount || 0}개 종료 완료 → 곧 새 워커가 자동 생성됩니다.`);
    } else if (action === "trim_excess_pending") {
      showToast(`✂️ 초과 Pending 워커 ${res.terminatedCount || 0}개 정리 완료!`);
    } else if (action === "stop_pending") {
      showToast(`⏳ Pending 워커 ${res.terminatedCount || 0}개 일괄 취소 완료!`);
    } else if (action === "stop_all") {
      showToast(`🛑 전체 워커 ${res.terminatedCount || 0}개 일괄 종료 완료!`);
    }
    await loadServerState();
    await loadSpaceRuns();
  } catch (e) {
    alert("워커 일괄 제어 실패: " + e.message);
  }
}

async function testAlertNotification() {
  try {
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
      await Notification.requestPermission().catch(() => {});
    }
    const webhookUrl = document.getElementById("cfgWebhookUrl")?.value || "";
    const res = await api("/api/notifications/test", {
      method: "POST",
      body: JSON.stringify({ webhookUrl }),
    });
    if (res.alert) {
      lastSeenAlertId = null; // allow immediate browser notification
      maybeTriggerBrowserAlert([res.alert], serverState?.config || { browserNotifyEnabled: true });
    }
    showToast(`🔔 알림 테스트 발송 완료! ${webhookUrl ? "(Webhook + 브라우저 데스크톱 알림)" : "(브라우저 데스크톱 알림)"}`);
    await loadServerState();
  } catch (e) {
    alert("알림 테스트 실패: " + e.message);
  }
}

async function quickUpdateLoadGuard(patch = {}) {
  try {
    const res = await api("/api/load-guard", {
      method: "POST",
      body: JSON.stringify(patch),
    });
    if (res.loadMonitor) {
      latestLoadMonitor = res.loadMonitor;
    }
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
    }
    showToast(
      `🛡️ 스마트 부하 보호 설정 변경 완료! (${
        res.config?.smartLoadGuardEnabled !== false
          ? `ON · 최대 동시 준비 워커 ${res.config?.maxPendingWorkers || 2}개`
          : "OFF"
      })`
    );
    await loadServerState();
  } catch (e) {
    alert("스마트 부하 보호 설정 변경 실패: " + e.message);
  }
}

function copyDevtoolsExtractor() {
  const snippet = `copy(JSON.stringify({accessToken:sessionStorage.access_token||localStorage.access_token,refreshToken:sessionStorage.refresh_token||localStorage.refresh_token,groupId:localStorage.group_id||sessionStorage.group_id}))`;
  const inputEl = document.getElementById("devtoolsSnippetInput");
  if (inputEl) {
    inputEl.value = snippet;
    inputEl.focus();
    inputEl.select();
  }
  const siteHost = getActiveSiteHost(currentSiteId);
  const onCopied = () => {
    showToast(`📋 토큰 추출 코드가 복사되었습니다! ${siteHost} 콘솔(F12)에 붙여넣고 Enter를 누른 뒤, 아래 칸에 Ctrl+V 하세요.`);
  };
  // Always try synchronous execCommand('copy') first so HTTP LAN IP (10.113.125.253:4300) never loses user-gesture activation!
  const syncOk = fallbackCopyText(snippet);
  if (syncOk) {
    onCopied();
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(snippet)
      .then(onCopied)
      .catch(() => {
        showToast("💡 화면의 파란색 추출 코드가 전체 선택되었습니다. Ctrl+C를 눌러 복사하세요!");
      });
  } else {
    showToast("💡 화면의 파란색 추출 코드가 전체 선택되었습니다. Ctrl+C를 눌러 복사하세요!");
  }
}

function onAccessTokenInput(val) {
  if (val && (val.trim().startsWith("{") || val.includes("access_token"))) {
    applyQuickPasteJson(val, false);
  }
}

function fallbackCopyText(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}

function decodeBrowserJwt(token) {
  try {
    const parts = String(token || "").trim().split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function detectSiteIdFromBrowserToken(accPayload, refPayload, rawText = "") {
  const combined = `${accPayload?.iss || ""} ${refPayload?.iss || ""} ${rawText}`.toLowerCase();
  const m = combined.match(/\b(n\d+)(?:-local)?\.sr-cloud\.com/i);
  if (m && m[1]) {
    return m[1].toLowerCase();
  }
  if (combined.includes("space.n6") || combined.includes("mlp.n6") || combined.includes("keycloak.n6")) {
    return "n6";
  }
  if (combined.includes("space.n9") || combined.includes("mlp.n9") || combined.includes("keycloak.n9")) {
    return "n9";
  }
  return null;
}

function showTokenPasteResult(type, htmlMsg) {
  const box = document.getElementById("tokenPasteResultBox");
  if (!box) return;
  box.style.display = "block";
  if (type === "ok") {
    box.style.background = "rgba(16, 185, 129, 0.16)";
    box.style.border = "1px solid rgba(16, 185, 129, 0.5)";
    box.style.color = "#6ee7b7";
  } else if (type === "warn") {
    box.style.background = "rgba(245, 158, 11, 0.16)";
    box.style.border = "1px solid rgba(245, 158, 11, 0.5)";
    box.style.color = "#fde68a";
  } else {
    box.style.background = "rgba(239, 68, 68, 0.18)";
    box.style.border = "1px solid rgba(239, 68, 68, 0.55)";
    box.style.color = "#fca5a5";
  }
  box.innerHTML = htmlMsg;
}

async function applyQuickPasteJson(raw, isManualButton = false) {
  if (!raw || !raw.trim()) {
    if (isManualButton) {
      showTokenPasteResult("err", "⚠️ 붙여넣은 내용이 비어 있습니다. 먼저 SPACE 콘솔 또는 Session Storage에서 토큰을 복사해 붙여넣어 주세요.");
    }
    return;
  }
  const trimmed = raw.trim();

  let extractedAccess = "";
  let extractedRefresh = "";
  let extractedGroup = "";
  let extractedUser = "";

  // 1. Try JSON parsing (supports copy(sessionStorage) multi-line JSON, copy(JSON.stringify(...)), or nested objects)
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      const merged = {
        ...(obj.s && typeof obj.s === "object" ? obj.s : {}),
        ...(obj.l && typeof obj.l === "object" ? obj.l : {}),
        ...obj,
      };
      extractedAccess = String(merged.accessToken || merged.access_token || "").replace(/^['"]|['"]$/g, "").trim();
      extractedRefresh = String(merged.refreshToken || merged.refresh_token || "").replace(/^['"]|['"]$/g, "").trim();
      extractedGroup = String(merged.groupId || merged.group_id || "").replace(/^['"]|['"]$/g, "").trim();
      extractedUser = String(merged.userName || merged.user_name || merged.username || "").replace(/^['"]|['"]$/g, "").trim();
    } catch {
      // If multi-line JSON is partially pasted or malformed, fall through to universal JWT regex scanner below
    }
  }

  // 2. Universal JWT Scanner: Finds all eyJ...xxx.yyy.zzz tokens anywhere in the text (cURL, Headers, Application table row, or JSON)
  const jwtMatches = trimmed.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || [];
  for (const jwt of jwtMatches) {
    const payload = decodeBrowserJwt(jwt);
    if (!payload) continue;
    if (payload.typ === "Refresh") {
      if (!extractedRefresh) extractedRefresh = jwt;
    } else {
      if (!extractedAccess) extractedAccess = jwt;
      if (payload.preferred_username && !extractedUser) {
        extractedUser = String(payload.preferred_username);
      }
    }
  }

  const curHost = getActiveSiteHost(currentSiteId);
  if (!extractedAccess && !extractedRefresh) {
    // Only show error if user clicked button or finished pasting a JSON object `{...}`
    if (isManualButton || (trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed.length > 30) {
      showTokenPasteResult(
        "err",
        `🚨 붙여넣은 내용에서 유효한 SPACE 토큰(<code>eyJ...</code>)을 찾지 못했습니다!<br/>👉 <code>${escapeHtml(curHost)}</code>에 로그인된 탭의 콘솔에서 실행했는지 확인하거나, <code>F12 → Application → Session Storage</code>에서 <code>access_token</code> 값을 복사해 붙여넣어 주세요.`
      );
    }
    return;
  }

  // 3. Check JWT Expiration and Auto-Detect Target Site (e.g. N6 vs N9) from JWT Issuer (`keycloak.n6-local.sr-cloud.com` vs `keycloak.n9-local.sr-cloud.com`)
  const nowSec = Math.floor(Date.now() / 1000);
  const accPayload = extractedAccess ? decodeBrowserJwt(extractedAccess) : null;
  const refPayload = extractedRefresh ? decodeBrowserJwt(extractedRefresh) : null;
  const accRemSec = accPayload?.exp ? accPayload.exp - nowSec : null;
  const refRemSec = refPayload?.exp ? refPayload.exp - nowSec : null;

  const detectedSiteId = detectSiteIdFromBrowserToken(accPayload, refPayload, trimmed) || currentSiteId;
  if (detectedSiteId !== currentSiteId) {
    currentSiteId = detectedSiteId;
    try {
      localStorage.setItem("space_active_site_id", currentSiteId);
    } catch {}
  }
  const targetProf = getActiveSiteProfile(detectedSiteId);
  const targetHost = getActiveSiteHost(detectedSiteId);
  document.getElementById("cfgBaseUrl").value = targetProf.baseUrl || `https://mlp.${detectedSiteId}.sr-cloud.com`;
  document.getElementById("cfgSfmUrl").value = targetProf.sfmUrl || `https://sfsm.${detectedSiteId}.sr-cloud.com`;

  if (extractedAccess) document.getElementById("cfgAccessToken").value = extractedAccess;
  if (extractedRefresh) {
    document.getElementById("cfgRefreshToken").value = extractedRefresh;
  } else if (accRemSec !== null && accRemSec > 0) {
    // Clear old expired refresh token if user pasted only a fresh access_token
    const oldRef = document.getElementById("cfgRefreshToken").value;
    const oldRefPayload = oldRef ? decodeBrowserJwt(oldRef) : null;
    if (oldRefPayload?.exp && oldRefPayload.exp < nowSec) {
      document.getElementById("cfgRefreshToken").value = "";
    }
  }
  if (extractedGroup && extractedGroup !== "undefined" && extractedGroup !== "null") {
    document.getElementById("cfgGroupId").value = extractedGroup;
  }
  if (extractedUser && extractedUser !== "undefined" && extractedUser !== "null") {
    document.getElementById("cfgUserName").value = extractedUser;
  }

  document.getElementById("quickPasteJson").value = "";

  // Case A: Both Access Token and Refresh Token in the SPACE tab are ALREADY expired!
  if ((accRemSec !== null && accRemSec <= 0) && (refRemSec === null || refRemSec <= 0)) {
    const expiredMins = Math.abs(Math.floor(accRemSec / 60));
    showTokenPasteResult(
      "err",
      `🚨 <b>[${escapeHtml(targetProf.id.toUpperCase())} · ${escapeHtml(targetProf.gpuModel)}] 주의: 방금 복사해 오신 토큰은 ${expiredMins}분 전에 이미 만료된 토큰입니다!</b><br/>` +
        `원인: 열려 있는 <code>${escapeHtml(targetHost)}</code> 탭이 오래전에 로그인되어 세션이 만료된 상태입니다.<br/>` +
        `👉 <b>해결법:</b> <code>${escapeHtml(targetHost)}</code> 탭에서 <b>새로고침(<code>F5</code>)하여 다시 로그인</b>한 뒤, 똑같이 복사해 붙여넣어 주세요!`
    );
    showToast(`🚨 복사하신 ${targetHost} 탭의 토큰이 이미 만료(${expiredMins}분 전)되어 있습니다! F5 새로고침 후 다시 복사하세요.`);
    await saveConfig(detectedSiteId);
    return;
  }

  // Case B: Access Token is valid (or Refresh Token is valid and server will auto-refresh)
  const validMins = accRemSec !== null && accRemSec > 0 ? Math.floor(accRemSec / 60) : Math.floor((refRemSec || 0) / 60);
  showTokenPasteResult(
    "ok",
    `✅ <b>[${escapeHtml(targetProf.id.toUpperCase())} · ${escapeHtml(targetProf.gpuModel)}] 새 토큰 독립 저장 완료!</b> (계정: <code>${escapeHtml(extractedUser || accPayload?.preferred_username || "감지됨")}</code> · 유효시간: <b>${validMins}분 남음</b>${extractedRefresh ? " · Refresh 토큰 포함" : ""}) — ${escapeHtml(targetProf.name)} 그룹 및 ${escapeHtml(targetProf.gpuModel)} GPU 풀을 자동 동기화합니다.`
  );
  showToast(`✅ [${targetProf.id.toUpperCase()} · ${targetProf.gpuModel}] 새 SPACE 토큰 적용 완료! (${validMins}분 남음)`);
  await saveConfig(detectedSiteId);
  await discoverSpaceResources();
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
  const gpuModel = getActiveGpuModel(currentSiteId);
  if (hint) {
    if (isSpot) {
      hint.style.color = "#fbbf24";
      hint.innerHTML =
        `🟧 <b>Spot Instance 모드 (` +
        `<code>allowSpot: true</code>)</b>: Group Pool 및 Priority 없이 클러스터 전체 Spot GPU(<code>${escapeHtml(gpuModel)}</code>, <code>${escapeHtml(gpuModel)} fGPU</code> 등)를 직접 선택하여 실행합니다.`;
    } else {
      hint.style.color = "#93c5fd";
      hint.innerHTML =
        `🟦 <b>Standard 모드 (` +
        `<code>allowSpot: false</code>)</b>: 내 그룹의 Group Pool과 Priority(<code>P3</code>)를 사용하여 정규 GPU(<code>${escapeHtml(gpuModel)}</code> 등)를 할당합니다.`;
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
    // Prefer the active site's primary GPU core (e.g. A100 on N6, H100 on N9) over CPU by default
    const siteGpu = getActiveGpuModel(currentSiteId).toLowerCase();
    const preferredGpuCore =
      cores.find((c) => String(c.name ?? c.coreName ?? "").trim().toLowerCase() === siteGpu) ||
      cores.find((c) => String(c.name ?? c.coreName ?? "").toLowerCase().includes(siteGpu)) ||
      cores.find((c) => !/^cpu$/i.test(String(c.name ?? c.coreName ?? "").trim())) ||
      cores[0];
    const defaultCoreId = preferredGpuCore.id ?? preferredGpuCore.coreId;
    const coreInput = document.getElementById("jobCoreId");
    const matchesCurrent = cores.some((c) => String(c.id ?? c.coreId) === String(coreInput.value));
    if (!coreInput.value) {
      onSelectCoreIdChange(defaultCoreId);
    } else {
      if (!matchesCurrent) {
        const customOpt = document.createElement("option");
        customOpt.value = coreInput.value;
        customOpt.textContent = `${isSpot ? "[Spot] " : "[Standard] "}Core ID: ${coreInput.value}`;
        cSel.appendChild(customOpt);
      }
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
          openSfmScriptEditor(containerPath, { silent: true }).catch(() => {});
          showToast(`✨ 실행 명령어가 [${cmd}] 로 설정되고 웹 에디터에 로드되었습니다.`);
        }
      };
      box.appendChild(pill);
    });
  } catch (e) {
    box.innerHTML = `<span class="hint" style="color:#f87171;">볼륨 파일 조회 실패: ${e.message} (직접 /group-volume/... 또는 /user-volume/... 경로를 입력하셔도 됩니다)</span>`;
  }
}

let isNewJobMode = false;

function updateJobFormModeBanner(isNew, jobName = "") {
  isNewJobMode = Boolean(isNew);
  const banner = document.getElementById("jobFormModeBanner");
  const textEl = document.getElementById("jobFormModeText");
  const updateBtn = document.getElementById("btnUpdateExistingJob");
  const formBox = document.getElementById("jobRuleFormBox");
  if (!banner || !textEl) return;

  if (isNewJobMode) {
    banner.style.background = "rgba(16, 185, 129, 0.2)";
    banner.style.borderColor = "rgba(16, 185, 129, 0.65)";
    if (formBox) formBox.style.borderColor = "rgba(16, 185, 129, 0.7)";
    textEl.style.color = "#6ee7b7";
    textEl.innerHTML = `🆕 <b>[신규 규칙 추가 모드]</b> 새 규칙 이름을 짓고 아래 <b>[➕ 신규 규칙으로 추가 등록]</b> 버튼을 누르면 목록에 새 규칙이 추가됩니다!`;
    if (updateBtn) updateBtn.style.display = "none";
  } else {
    banner.style.background = "rgba(59, 130, 246, 0.16)";
    banner.style.borderColor = "rgba(59, 130, 246, 0.45)";
    if (formBox) formBox.style.borderColor = "rgba(59, 130, 246, 0.5)";
    textEl.style.color = "#93c5fd";
    textEl.innerHTML = `✏️ <b>[기존 규칙 수정 중: <code style="color:#fde68a;">${escapeHtml(jobName || "선택됨")}</code>]</b> — 새 규칙으로 추가하려면 우측 <b>[➕ 빈 신규 규칙 폼 열기]</b> 또는 하단 <b>[➕ 신규 규칙으로 추가 등록]</b>을 누르세요!`;
    if (updateBtn) {
      updateBtn.style.display = "inline-flex";
      updateBtn.textContent = `💾 [${jobName || "현재 규칙"}] 수정 저장`;
    }
  }
}

function selectAndEditJobRule(jobId, scrollToForm = true) {
  const jobObj = (serverState?.jobs || []).find((j) => String(j.id) === String(jobId));
  if (jobObj) {
    loadJobToForm(jobObj, scrollToForm, false);
  }
}

function renderJobsTable(jobs, fleet = latestWorkerFleet) {
  const tbody = document.getElementById("jobsTableBody");
  const monTbody = document.getElementById("monitorJobsTableBody");
  const navMonBadge = document.getElementById("navMonitorBadge");
  const navSetBadge = document.getElementById("navSetupBadge");

  if (navMonBadge && fleet) {
    const rCnt = fleet.totalRunningWorkers ?? 0;
    const pCnt = fleet.totalPendingWorkers ?? 0;
    const tCnt = fleet.totalTargetWorkers ?? 0;
    navMonBadge.textContent = `🟢 Running ${rCnt}/${tCnt}워커${pCnt > 0 ? ` (+대기 ${pCnt})` : ""}`;
  }
  if (navSetBadge) {
    navSetBadge.textContent = `규칙 ${jobs.length}개`;
  }

  if (!jobs.length) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="hint">등록된 자동 실행 규칙이 없습니다. 아래 폼에서 [➕ 신규 규칙으로 추가 등록]을 눌러 첫 규칙을 추가하세요.</td></tr>`;
    }
    if (monTbody) {
      monTbody.innerHTML = `<tr><td colspan="7" class="hint">등록된 규칙이 없습니다. 우측 상단 [➕ 신규 규칙 추가 작성]을 눌러 규칙을 등록하세요.</td></tr>`;
    }
    return;
  }
  const currentFormJobId = document.getElementById("jobId")?.value || "";
  const focusedId = focusedFleetJobId || currentFormJobId;
  const jobFleetMap = new Map();
  if (fleet && Array.isArray(fleet.jobs)) {
    fleet.jobs.forEach((jf) => jobFleetMap.set(jf.jobId, jf));
  }
  const jobsRenderSig =
    `${currentFormJobId}|${focusedId}|${isNewJobMode ? 1 : 0}|` +
    jobs
      .map((j) => {
        const jf = jobFleetMap.get(j.id);
        return `${j.id}:${j.name}:${j.enabled}:${j.minConcurrentRuns}:${j.targetPendingRuns ?? 0}:${j.allowSpot}:${j.coreId}:${j.coreCount}:${j.executionCommand}:${j.lastStatus}:${jf?.runningCount}:${jf?.pendingCount}`;
      })
      .join(";");

  if (tbody) {
    const setupRowsHtml = jobs
      .map((j) => {
        const isSelected = !isNewJobMode && String(j.id) === String(currentFormJobId);
        const jf = jobFleetMap.get(j.id);
        const runningCnt = jf ? jf.runningCount : "?";
        const pendingCnt = jf ? jf.pendingCount : 0;
        const activeCnt = jf ? jf.activeCount : "?";
        const targetCnt = j.minConcurrentRuns || 1;
        const targetPendingCnt = Math.max(0, Number(j.targetPendingRuns ?? jf?.targetPendingCount ?? 0));
        const remCnt = jf ? jf.remainingToCreate : Math.max(0, targetCnt);
        const excessCnt = jf ? jf.excessPendingCount || 0 : 0;
        const fleetBadges = jf
          ? `<div style="margin-top:4px; display:flex; gap:5px; flex-wrap:wrap;">
              <span class="badge ok" style="background:rgba(16,185,129,0.2); color:#6ee7b7;">🟢 Running: ${runningCnt} / 목표: ${targetCnt}개</span>
              ${
                targetPendingCnt > 0
                  ? `<span class="badge warn" style="border:1px solid #fbbf24;">🎯 목표Pending: ${pendingCnt}/${targetPendingCnt}개</span>`
                  : pendingCnt > 0
                  ? `<span class="badge warn">⏳ Pending 대기: ${pendingCnt}개 (활성 ${activeCnt}개${excessCnt > 0 ? ` · 초과+${excessCnt}` : ""})</span>`
                  : ""
              }
              ${
                remCnt > 0
                  ? `<span class="badge warn">🔄 +${remCnt}개 추가생성 예정</span>`
                  : targetPendingCnt > 0 && pendingCnt >= targetPendingCnt
                  ? `<span class="badge ok">✅ 목표Pending ${targetPendingCnt}개 유지중</span>`
                  : runningCnt >= targetCnt
                  ? `<span class="badge ok">✅ 전원 Running</span>`
                  : ""
              }
            </div>`
          : `<div class="mono" style="font-size:12px;">목표: <b>${targetCnt}개</b>${
              targetPendingCnt > 0 ? ` · 목표Pending: <b>${targetPendingCnt}개</b>` : ""
            }</div>`;
        const badge = j.enabled
          ? `<button class="success sm" style="padding:4px 9px; font-size:11.5px; font-weight:700;" onclick="toggleJobEnabled('${escapeHtml(j.id)}', false)" title="클릭하면 자동 추가 생성을 일시정지합니다">🟢 ON (가동중)</button>`
          : `<button class="secondary sm" style="padding:4px 9px; font-size:11.5px; border-color:rgba(248,113,113,0.5); color:#fca5a5;" onclick="toggleJobEnabled('${escapeHtml(j.id)}', true)" title="클릭하면 주기적 자동 생성을 켭니다">⚪ OFF (켜기)</button>`;
        const runTypeBadge = j.allowSpot
          ? `<span class="badge warn" style="margin-right:4px;">🟧 Spot</span>`
          : `<span class="badge ok" style="margin-right:4px; background:rgba(59,130,246,0.2); color:#93c5fd;">🟦 Std</span>`;
        return `
          <tr style="${isSelected ? "background:rgba(59,130,246,0.14); outline:1px solid rgba(59,130,246,0.45);" : ""}">
            <td>${badge}</td>
            <td class="mono" style="cursor:pointer;" onclick="selectAndEditJobRule('${escapeHtml(j.id)}', false)" title="클릭하면 이 규칙을 선택합니다">
              <b>${escapeHtml(j.name)}</b>
              ${isSelected ? `<div style="font-size:10px; color:#60a5fa; font-weight:700;">✏️ 현재 선택/편집 중</div>` : ""}
            </td>
            <td>${fleetBadges}</td>
            <td class="mono" style="font-size:11.5px;">${runTypeBadge}Core:${escapeHtml(String(j.coreId || "자동"))} × ${j.coreCount || 1}GPU</td>
            <td class="mono" style="color:#93c5fd; font-size:12px; cursor:pointer;" onclick="selectAndEditJobRule('${escapeHtml(j.id)}', false)">${escapeHtml(j.executionCommand)}</td>
            <td style="font-size:11.5px;">${escapeHtml(j.lastStatus || "대기 중")}</td>
            <td>
              <div class="btn-row" style="gap:4px;">
                <button class="success sm" style="padding:4px 8px;" onclick="triggerJobNow('${escapeHtml(j.id)}')" title="이 규칙으로 워커 1개를 즉시 할당 및 승인합니다">▶ +1 실행</button>
                <button class="secondary sm" style="padding:4px 8px;" onclick="selectAndEditJobRule('${escapeHtml(j.id)}', true)">✏️ 수정</button>
                <button class="secondary sm" style="padding:4px 8px; border-color:rgba(16,185,129,0.5); color:#6ee7b7;" onclick="duplicateJobRule('${escapeHtml(j.id)}')" title="이 규칙을 복제하여 새 규칙으로 바로 추가합니다">📋 복제추가</button>
                <button class="danger sm" style="padding:4px 8px;" onclick="deleteJob('${escapeHtml(j.id)}')">삭제</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
    updateHtmlIfSigChanged(tbody, jobsRenderSig, setupRowsHtml);
  }

  if (monTbody) {
    const monRowsHtml = jobs
      .map((j) => {
        const isFocused = String(j.id) === String(focusedId);
        const jf = jobFleetMap.get(j.id);
        const runningCnt = jf ? jf.runningCount : "?";
        const pendingCnt = jf ? jf.pendingCount : 0;
        const activeCnt = jf ? jf.activeCount : "?";
        const targetCnt = j.minConcurrentRuns || 1;
        const targetPendingCnt = Math.max(0, Number(j.targetPendingRuns ?? jf?.targetPendingCount ?? 0));
        const remCnt = jf ? jf.remainingToCreate : Math.max(0, targetCnt);
        const excessCnt = jf ? jf.excessPendingCount || 0 : 0;
        const fleetBadges = jf
          ? `<div style="display:flex; gap:5px; flex-wrap:wrap; align-items:center;">
              <span class="badge ok" style="background:rgba(16,185,129,0.2); color:#6ee7b7;">🟢 Running: ${runningCnt} / 목표: ${targetCnt}개</span>
              ${
                targetPendingCnt > 0
                  ? `<span class="badge warn" style="border:1px solid #fbbf24;">🎯 목표Pending: ${pendingCnt}/${targetPendingCnt}개</span>`
                  : pendingCnt > 0
                  ? `<span class="badge warn">⏳ Pending 대기: ${pendingCnt}개 (활성 ${activeCnt}개${excessCnt > 0 ? ` · 초과+${excessCnt}` : ""})</span>`
                  : ""
              }
              ${
                remCnt > 0
                  ? `<span class="badge warn">🔄 +${remCnt}개 추가생성 예정</span>`
                  : targetPendingCnt > 0 && pendingCnt >= targetPendingCnt
                  ? `<span class="badge ok">✅ 목표Pending ${targetPendingCnt}개 유지중</span>`
                  : runningCnt >= targetCnt
                  ? `<span class="badge ok">✅ 전원 Running</span>`
                  : ""
              }
            </div>`
          : `<div class="mono" style="font-size:12px;">목표: <b>${targetCnt}개</b>${
              targetPendingCnt > 0 ? ` · 목표Pending: <b>${targetPendingCnt}개</b>` : ""
            }</div>`;
        const badge = j.enabled
          ? `<button class="success sm" style="padding:4px 9px; font-size:11.5px; font-weight:700;" onclick="toggleJobEnabled('${escapeHtml(j.id)}', false)">🟢 ON (가동중)</button>`
          : `<button class="secondary sm" style="padding:4px 9px; font-size:11.5px; border-color:rgba(248,113,113,0.5); color:#fca5a5;" onclick="toggleJobEnabled('${escapeHtml(j.id)}', true)">⚪ OFF (켜기)</button>`;
        const runTypeBadge = j.allowSpot
          ? `<span class="badge warn" style="margin-right:4px;">🟧 Spot</span>`
          : `<span class="badge ok" style="margin-right:4px; background:rgba(59,130,246,0.2); color:#93c5fd;">🟦 Std</span>`;
        return `
          <tr style="${isFocused ? "background:rgba(59,130,246,0.12);" : ""}">
            <td>${badge}</td>
            <td class="mono" style="cursor:pointer;" onclick="selectFleetJobTab('${escapeHtml(j.id)}')" title="클릭하면 위 모니터링 보드에서 이 규칙 현황을 봅니다">
              <b>${escapeHtml(j.name)}</b>
            </td>
            <td>${fleetBadges}</td>
            <td class="mono" style="font-size:11.5px;">${runTypeBadge}Core:${escapeHtml(String(j.coreId || "자동"))} × ${j.coreCount || 1}GPU</td>
            <td class="mono" style="color:#93c5fd; font-size:12px;">${escapeHtml(j.executionCommand)}</td>
            <td style="font-size:11.5px;">${escapeHtml(j.lastStatus || "대기 중")}</td>
            <td>
              <div class="btn-row" style="gap:4px;">
                <button class="success sm" style="padding:4px 8px;" onclick="triggerJobNow('${escapeHtml(j.id)}')" title="워커 1개 즉시 실행">▶ +1 즉시실행</button>
                <button class="secondary sm" style="padding:4px 8px;" onclick="editJobRuleInSetup('${escapeHtml(j.id)}')" title="설정 화면에서 이 규칙을 수정합니다">⚙️ 설정 수정</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
    updateHtmlIfSigChanged(monTbody, jobsRenderSig, monRowsHtml);
  }

  if (!window.__initialJobLoaded && jobs[0]) {
    window.__initialJobLoaded = true;
    const initialJob = jobs.find((j) => j.enabled) || jobs[0];
    loadJobToForm(initialJob, false, false);
  }
}

async function toggleJobEnabled(jobId, enabled) {
  try {
    if (enabled) {
      focusedFleetJobId = String(jobId);
    }
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

function loadJobToForm(j, scrollToForm = false, asNewMode = false) {
  if (!j) return;
  if (!asNewMode && j.id) {
    focusedFleetJobId = String(j.id);
  }
  document.getElementById("jobId").value = j.id;
  document.getElementById("jobName").value = j.name || "group-vol-worker";
  document.getElementById("jobMode").value = j.mode || "ensure_running";
  document.getElementById("jobUseSpecId").value = j.useSpecId || "";
  document.getElementById("jobMinConcurrent").value = j.minConcurrentRuns || 1;
  const targetPendingEl = document.getElementById("jobTargetPending");
  if (targetPendingEl) targetPendingEl.value = Math.max(0, Number(j.targetPendingRuns ?? 0));
  document.getElementById("jobGroupPoolId").value = j.groupPoolId || "";
  document.getElementById("jobCoreId").value = j.coreId || "";
  document.getElementById("jobCoreCount").value = j.coreCount || 1;
  document.getElementById("jobQuotaId").value = j.quotaId || "";
  document.getElementById("jobContainerImage").value = j.containerImage || "";
  const imgSel = document.getElementById("selectImage");
  if (imgSel && j.containerImage) imgSel.value = j.containerImage;
  document.getElementById("jobExperimentId").value = j.experimentId || "";
  document.getElementById("jobExpectedRunTime").value = j.expectedRunTime || "8h";
  document.getElementById("jobCooldownSec").value = j.cooldownSec || 15;
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
  updateJobFormModeBanner(asNewMode, j.name);
  if (serverState?.jobs) {
    renderJobsTable(serverState.jobs, latestWorkerFleet);
  }
  if (!asNewMode && latestWorkerFleet) {
    renderWorkerFleetBoard(latestWorkerFleet);
    renderTopAutoStatusBanner();
  }
  if (scrollToForm) {
    const formBox = document.getElementById("jobRuleFormBox");
    if (formBox) formBox.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function startNewJobRule() {
  const nextIdx = (serverState?.jobs?.length || 0) + 1;
  // 기존에 이미 매핑되어 있는 Pool, Core, Image, Quota는 그대로 유지하여 재선택하는 번거로움을 없앰!
  const currentPoolId = document.getElementById("jobGroupPoolId")?.value || "";
  const currentCoreId = document.getElementById("jobCoreId")?.value || "";
  const currentQuotaId = document.getElementById("jobQuotaId")?.value || "";
  const currentImage = document.getElementById("jobContainerImage")?.value || "";
  const currentExpId = document.getElementById("jobExperimentId")?.value || "";
  const currentIsSpot = Boolean(document.getElementById("jobAllowSpot")?.checked);

  loadJobToForm(
    {
      id: "job-" + Date.now(),
      name: `worker-rule-${nextIdx}`,
      mode: "ensure_running",
      minConcurrentRuns: 1,
      targetPendingRuns: 0,
      groupPoolId: currentPoolId,
      coreId: currentCoreId,
      coreCount: 1,
      quotaId: currentQuotaId,
      containerImage: currentImage,
      experimentId: currentExpId,
      expectedRunTime: "8h",
      cooldownSec: 15,
      executionCommand: "bash /group-volume/run.sh",
      enabled: true,
      autoApprove: true,
      restartOnSuccess: true,
      restartOnFail: true,
      allowSpot: currentIsSpot,
      enableWebConsole: true,
    },
    true,
    true
  );
  const nameInput = document.getElementById("jobName");
  if (nameInput) {
    nameInput.focus();
    nameInput.select();
  }
  showToast("🆕 신규 규칙 추가 모드로 전환되었습니다! 규칙 이름과 명령어를 입력 후 [➕ 신규 규칙으로 추가 등록]을 누르세요.");
}

function resetJobForm() {
  startNewJobRule();
}

function collectJobFormPayload() {
  const isSpot =
    document.getElementById("jobRunType")?.value === "spot" ||
    document.getElementById("jobAllowSpot")?.checked;
  return {
    id: document.getElementById("jobId").value || "job-" + Date.now(),
    name: (document.getElementById("jobName").value || "group-vol-worker").trim(),
    mode: document.getElementById("jobMode").value,
    useSpecId: document.getElementById("jobUseSpecId").value,
    minConcurrentRuns: Number(document.getElementById("jobMinConcurrent").value || 1),
    targetPendingRuns: Math.max(0, Number(document.getElementById("jobTargetPending")?.value || 0)),
    groupPoolId: document.getElementById("jobGroupPoolId").value,
    coreId: document.getElementById("jobCoreId").value,
    coreCount: Number(document.getElementById("jobCoreCount").value || 1),
    quotaId: document.getElementById("jobQuotaId").value,
    containerImage: document.getElementById("jobContainerImage").value,
    experimentId: document.getElementById("jobExperimentId").value,
    expectedRunTime: document.getElementById("jobExpectedRunTime").value,
    cooldownSec: Number(document.getElementById("jobCooldownSec").value || 15),
    executionCommand: document.getElementById("jobExecutionCommand").value,
    enabled: document.getElementById("jobEnabled").checked,
    autoApprove: document.getElementById("jobAutoApprove").checked,
    restartOnSuccess: document.getElementById("jobRestartOnSuccess").checked,
    restartOnFail: document.getElementById("jobRestartOnFail").checked,
    allowSpot: Boolean(isSpot),
    enableWebConsole: document.getElementById("jobEnableWebConsole").checked,
  };
}

async function saveAsNewJobRule() {
  try {
    const payload = collectJobFormPayload();
    const existingJobs = Array.isArray(serverState?.jobs) ? serverState.jobs : [];
    // 항상 새로운 고유 ID를 부여하여 기존 규칙 덮어쓰기 없이 새 규칙으로 추가!
    payload.id = "job-" + Date.now();
    if (existingJobs.some((j) => j.name === payload.name)) {
      payload.name = `${payload.name}-${existingJobs.length + 1}`;
      document.getElementById("jobName").value = payload.name;
    }
    document.getElementById("jobId").value = payload.id;
    focusedFleetJobId = payload.id;
    await api("/api/jobs", { method: "POST", body: JSON.stringify(payload) });
    updateJobFormModeBanner(false, payload.name);
    showToast(`➕ 신규 규칙 [${payload.name}]이(가) 규칙 목록에 추가되었습니다!`);
    await loadServerState();
  } catch (e) {
    alert("신규 규칙 추가 실패: " + e.message);
  }
}

async function duplicateJobRule(jobId) {
  try {
    const existingJobs = Array.isArray(serverState?.jobs) ? serverState.jobs : [];
    const target = existingJobs.find((j) => String(j.id) === String(jobId));
    if (!target) return;
    const cloned = {
      ...target,
      id: "job-" + Date.now(),
      name: `${target.name}-${existingJobs.length + 1}`,
      lastStatus: "신규 복제됨 (대기 중)",
    };
    focusedFleetJobId = cloned.id;
    await api("/api/jobs", { method: "POST", body: JSON.stringify(cloned) });
    await loadServerState();
    loadJobToForm(cloned, true, false);
    showToast(`📋 [${target.name}] 규칙을 복제하여 새 규칙 [${cloned.name}]을(를) 추가했습니다!`);
  } catch (e) {
    alert("규칙 복제 실패: " + e.message);
  }
}

async function saveJobRule() {
  try {
    const payload = collectJobFormPayload();
    focusedFleetJobId = payload.id;
    await api("/api/jobs", { method: "POST", body: JSON.stringify(payload) });
    updateJobFormModeBanner(false, payload.name);
    showToast(`✅ [${payload.name}] 규칙이 저장되었습니다! (cmd: ${payload.executionCommand})`);
    await loadServerState();
  } catch (e) {
    alert("규칙 저장 실패: " + e.message);
  }
}

async function deleteJob(id) {
  if (!confirm("이 자동 실행 규칙을 삭제하시겠습니까?")) return;
  await api(`/api/jobs/${id}`, { method: "DELETE" });
  if (focusedFleetJobId === id) focusedFleetJobId = "";
  await loadServerState();
  if (serverState?.jobs?.[0]) {
    loadJobToForm(serverState.jobs[0], false, false);
  }
}

async function triggerJobNow(jobId) {
  try {
    const formPayload = collectJobFormPayload();
    const targetJobId = jobId || formPayload.id;
    // Always sync the form's latest executionCommand/image/runType if this job is currently open in the form!
    const includeFormData = !jobId || formPayload.id === jobId;
    if (includeFormData) {
      focusedFleetJobId = targetJobId;
      updateJobFormModeBanner(false, formPayload.name);
    }
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
        resourceText: `${getActiveGpuModel(currentSiteId)} GPU×${tl.coreCount || 4}`,
        requestTimeText: reqIso ? `⚡ ${formatPreciseTime(reqIso, true)} (${formatRelativeAgo(reqIso)})` : "-",
        stageLabel: "✅ APPROVED",
        isPending: false,
        approvedInfo: `✅ ${formatPreciseTime(doneIso, true)} (${tl.approvalElapsedSec ?? 1.4}초 만에 무클릭 승인 완료)`,
      });
    });

    if (!rows.length) {
      updateHtmlIfSigChanged(
        tbody,
        "empty-approvals",
        `<tr><td colspan="6" class="hint">현재 승인 대기 중(PENDING)이거나 최근 승인 내역이 없습니다.</td></tr>`
      );
      return;
    }

    const appRowsSig = rows
      .slice(0, 25)
      .map((r) => `${r.source}:${r.approvalId}:${r.runId}:${r.stageLabel}:${r.isPending}`)
      .join("|");
    const appRowsHtml = rows
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
    updateHtmlIfSigChanged(tbody, appRowsSig, appRowsHtml);
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

let latestRawSpaceRuns = [];
let currentSpaceRunsFilter = "active"; // "active" | "running" | "pending" | "mine" | "all"
const selectedWorkerRunIds = new Set();
let instantKillWithoutConfirm = true; // default true so 1-click Kill/Delete works immediately
let slotSpecDraftText = "";

function toggleInstantKillMode(checked) {
  instantKillWithoutConfirm = Boolean(checked);
  renderWorkerFleetBoard(latestWorkerFleet, { force: true });
  renderSpaceRunsTable(latestRawSpaceRuns, latestWorkerFleet, { force: true });
}

function toggleSelectWorkerRun(runId, forceVal) {
  const idStr = String(runId ?? "").trim();
  if (!idStr) return;
  if (typeof forceVal === "boolean") {
    if (forceVal) selectedWorkerRunIds.add(idStr);
    else selectedWorkerRunIds.delete(idStr);
  } else {
    if (selectedWorkerRunIds.has(idStr)) selectedWorkerRunIds.delete(idStr);
    else selectedWorkerRunIds.add(idStr);
  }
  renderWorkerFleetBoard(latestWorkerFleet, { force: true });
  renderSpaceRunsTable(latestRawSpaceRuns, latestWorkerFleet, { force: true });
}

function selectWorkerGroup(mode, jobId) {
  const jf = getFocusedJobFleet(latestWorkerFleet);
  const workers = jf?.activeWorkers || [];
  if (mode === "none") {
    selectedWorkerRunIds.clear();
    showToast("✖ 모든 슬롯 선택이 해제되었습니다.");
  } else if (mode === "all") {
    selectedWorkerRunIds.clear();
    for (const w of workers) {
      if (w.id !== undefined && w.id !== null) selectedWorkerRunIds.add(String(w.id));
    }
    showToast(`☑️ 전체 가동 슬롯 ${selectedWorkerRunIds.size}개가 선택되었습니다.`);
  } else if (mode === "running") {
    selectedWorkerRunIds.clear();
    for (const w of workers) {
      if (String(w.status || "").toUpperCase().includes("RUN")) {
        selectedWorkerRunIds.add(String(w.id));
      }
    }
    showToast(`🟢 Running 슬롯 ${selectedWorkerRunIds.size}개가 선택되었습니다.`);
  } else if (mode === "pending") {
    selectedWorkerRunIds.clear();
    for (const w of workers) {
      if (!String(w.status || "").toUpperCase().includes("RUN")) {
        selectedWorkerRunIds.add(String(w.id));
      }
    }
    showToast(`⏳ Pending 대기 슬롯 ${selectedWorkerRunIds.size}개가 선택되었습니다.`);
  } else if (mode === "excess") {
    selectedWorkerRunIds.clear();
    for (const w of workers) {
      if (w.isExcessPending) {
        selectedWorkerRunIds.add(String(w.id));
      }
    }
    if (selectedWorkerRunIds.size === 0) {
      for (const w of workers) {
        if (!String(w.status || "").toUpperCase().includes("RUN")) {
          selectedWorkerRunIds.add(String(w.id));
        }
      }
    }
    showToast(`⚠️ 초과 Pending 슬롯 ${selectedWorkerRunIds.size}개가 선택되었습니다.`);
  } else if (mode === "problem") {
    selectedWorkerRunIds.clear();
    for (const w of workers) {
      if (w.hasLogError || w.progress?.isStraggler) {
        selectedWorkerRunIds.add(String(w.id));
      }
    }
    showToast(
      selectedWorkerRunIds.size > 0
        ? `🚨 에러/느린 슬롯 ${selectedWorkerRunIds.size}개가 선택되었습니다.`
        : "🟢 현재 에러나 속도 저하가 감지된 슬롯이 없습니다."
    );
  }
  renderWorkerFleetBoard(latestWorkerFleet, { force: true });
  renderSpaceRunsTable(latestRawSpaceRuns, latestWorkerFleet, { force: true });
}

function parseSlotSpecToRunIds(specStr, jf = getFocusedJobFleet(latestWorkerFleet)) {
  const raw = String(specStr || "").trim();
  const matchedRunIds = [];
  const matchedLabels = [];
  if (!raw) return { matchedRunIds, matchedLabels };

  const workers = jf?.activeWorkers || [];
  const slotNumSet = new Set();
  const explicitRunIdSet = new Set();

  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (part.startsWith("#")) {
      const rid = part.slice(1).trim();
      if (rid) explicitRunIdSet.add(rid);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let k = lo; k <= hi && k - lo <= 512; k++) {
        slotNumSet.add(k);
      }
      continue;
    }
    const num = Number(part);
    if (Number.isFinite(num) && num > 0) {
      if (num > 5000) {
        explicitRunIdSet.add(String(num));
      } else {
        slotNumSet.add(num);
      }
    }
  }

  const seen = new Set();
  workers.forEach((w, idx) => {
    const seqNum = idx + 1;
    const slotIdx = Number(w.slotIndex || seqNum);
    const wId = String(w.id);
    if (slotNumSet.has(seqNum) || slotNumSet.has(slotIdx) || explicitRunIdSet.has(wId)) {
      if (!seen.has(wId)) {
        seen.add(wId);
        matchedRunIds.push(wId);
        matchedLabels.push(`슬롯#${seqNum}(#${wId})`);
      }
    }
  });

  // Also check unmatched active runs or raw active runs for explicit #runId
  for (const r of latestRawSpaceRuns || []) {
    const rId = String(r.id ?? r.runId ?? "");
    if (explicitRunIdSet.has(rId) && !seen.has(rId)) {
      seen.add(rId);
      matchedRunIds.push(rId);
      matchedLabels.push(`Run #${rId}`);
    }
  }

  return { matchedRunIds, matchedLabels };
}

function applySlotSpecSelection(jobId) {
  const inputEl = document.getElementById("slotRangeKillInput");
  const spec = inputEl ? inputEl.value : slotSpecDraftText;
  slotSpecDraftText = spec || "";
  const jf = getFocusedJobFleet(latestWorkerFleet);
  const { matchedRunIds, matchedLabels } = parseSlotSpecToRunIds(spec, jf);
  if (matchedRunIds.length === 0) {
    showToast(`⚠️ 입력한 번호("${spec}")에 해당하는 활성 워커 슬롯을 찾지 못했습니다. (예: 1, 5, 58-62 또는 #353028)`);
    return;
  }
  for (const idStr of matchedRunIds) {
    selectedWorkerRunIds.add(String(idStr));
  }
  showToast(`🎯 ${matchedRunIds.length}개 슬롯 선택 추가됨: ${matchedLabels.slice(0, 6).join(", ")}${matchedLabels.length > 6 ? " 외" : ""}`);
  if (inputEl) inputEl.blur();
  renderWorkerFleetBoard(latestWorkerFleet, { force: true });
  renderSpaceRunsTable(latestRawSpaceRuns, latestWorkerFleet, { force: true });
}

async function killSingleWorkerSlot(runId, runName = "", slotLabel = "", reduceTarget = false, jobId = "") {
  const idStr = String(runId ?? "").trim();
  if (!idStr) return;
  const label = slotLabel || `Run #${idStr}`;

  if (!instantKillWithoutConfirm) {
    const msg = reduceTarget
      ? `🗑️ [${label} (${runName || `#${idStr}`})] 슬롯을 영구 삭제(강제 종료 + 목표 워커 수 -1 차감)하시겠습니까?`
      : `🛑 [${label} (${runName || `#${idStr}`})] 슬롯을 즉시 강제 중지(Kill)하시겠습니까?`;
    if (!confirm(msg)) return;
  }

  try {
    showToast(
      reduceTarget
        ? `🗑️ [${label}] 즉시 Kill + 목표 워커 수 -1 영구 차감 처리 중...`
        : `🛑 [${label}] 즉시 강제 종료(Kill) 요청 중...`
    );
    const res = await api(`/api/space/runs/${encodeURIComponent(idStr)}/stop`, {
      method: "POST",
      body: JSON.stringify({
        reduceTarget: Boolean(reduceTarget),
        jobId: jobId || undefined,
      }),
    });
    selectedWorkerRunIds.delete(idStr);
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet, { force: true });
    }
    if (res.targetAdjustment) {
      const adj = res.targetAdjustment;
      const minInput = document.getElementById("jobMinConcurrent");
      if (minInput && String(document.getElementById("jobId")?.value) === String(adj.jobId)) {
        minInput.value = adj.newTarget;
      }
      showToast(
        `🗑️ [${label}] 강제 종료 + 규칙 [${adj.jobName}] 목표 워커 수 ${adj.previousTarget}개 → ${adj.newTarget}개로 영구 차감 완료!`
      );
    } else {
      showToast(`🛑 [${label} (#${idStr})] 즉시 강제 종료(Kill) 완료!`);
    }
    await loadSpaceRuns({ force: true });
    await loadServerState();
  } catch (e) {
    alert(`슬롯 종료 실패 (#${idStr}): ` + e.message);
  }
}

async function executeSelectedWorkersKill(reduceTarget = false, jobId = "") {
  const jf = getFocusedJobFleet(latestWorkerFleet);
  const inputEl = document.getElementById("slotRangeKillInput");
  const specText = (inputEl ? inputEl.value : slotSpecDraftText).trim();

  // If user typed slot numbers in input box, include them automatically
  if (specText) {
    const { matchedRunIds } = parseSlotSpecToRunIds(specText, jf);
    for (const idStr of matchedRunIds) {
      selectedWorkerRunIds.add(String(idStr));
    }
  }

  const targetIds = Array.from(selectedWorkerRunIds);
  if (targetIds.length === 0) {
    showToast("⚠️ 먼저 아래 슬롯 박스의 체크박스를 클릭하거나 슬롯 번호(예: 1, 5, 58-62)를 입력해 주세요!");
    return;
  }

  if (!instantKillWithoutConfirm) {
    const msg = reduceTarget
      ? `🗑️ 선택한 ${targetIds.length}개 워커 슬롯을 즉시 종료(Kill)하고 목표 워커 수도 -${targetIds.length}개 영구 차감하시겠습니까?\n(대상 Run ID: #${targetIds.slice(0, 10).join(", #")}${targetIds.length > 10 ? " 외" : ""})`
      : `🛑 선택한 ${targetIds.length}개 워커 슬롯을 즉시 강제 종료(Stop/Kill)하시겠습니까? (목표 워커 수는 그대로 유지됩니다)\n(대상 Run ID: #${targetIds.slice(0, 10).join(", #")}${targetIds.length > 10 ? " 외" : ""})`;
    if (!confirm(msg)) return;
  }

  try {
    showToast(
      reduceTarget
        ? `🗑️ 선택 슬롯 ${targetIds.length}개 즉시 Kill + 목표 워커 수 -${targetIds.length} 영구 삭제 실행 중...`
        : `🛑 선택 슬롯 ${targetIds.length}개 즉시 일괄 Kill(Stop) 실행 중...`
    );
    const res = await api("/api/space/runs/bulk-action", {
      method: "POST",
      body: JSON.stringify({
        action: reduceTarget ? "delete_selected" : "stop_selected",
        runIds: targetIds,
        reduceTarget: Boolean(reduceTarget),
        jobId: jobId || jf?.jobId || undefined,
      }),
    });

    for (const tid of targetIds) {
      selectedWorkerRunIds.delete(String(tid));
    }
    slotSpecDraftText = "";
    if (inputEl) inputEl.value = "";

    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet, { force: true });
    }

    if (res.targetAdjustment) {
      const adj = res.targetAdjustment;
      const minInput = document.getElementById("jobMinConcurrent");
      if (minInput && String(document.getElementById("jobId")?.value) === String(adj.jobId)) {
        minInput.value = adj.newTarget;
      }
      showToast(
        `🗑️ 선택 슬롯 ${res.terminatedCount || targetIds.length}개 영구 삭제 완료! (규칙 [${adj.jobName}] 목표 워커 ${adj.previousTarget}개 → ${adj.newTarget}개로 차감)`
      );
    } else {
      showToast(`🛑 선택 슬롯 ${res.terminatedCount || targetIds.length}개 즉시 강제 종료(Stop/Kill) 완료!`);
    }
    await loadSpaceRuns({ force: true });
    await loadServerState();
  } catch (e) {
    alert("선택 슬롯 일괄 종료 실패: " + e.message);
  }
}

function setSpaceRunsFilter(filterMode) {
  currentSpaceRunsFilter = filterMode || "active";
  renderSpaceRunsTable(latestRawSpaceRuns, latestWorkerFleet, { force: true });
}

function classifyUiRunStatus(status) {
  const s = String(status || "").toUpperCase();
  if (["RUNNING", "PENDING", "CREATING", "STAGING", "INITIALIZING", "QUEUED", "STARTING", "APPROVED", "ADMITTED", "SCHEDULED", "WAITING"].some((k) => s.includes(k))) {
    return "ACTIVE";
  }
  if (["SUCCEEDED", "COMPLETED", "FINISHED", "DONE"].some((k) => s.includes(k))) {
    return "SUCCEEDED";
  }
  return "FAILED";
}

function renderSpaceRunsTable(runs = latestRawSpaceRuns, fleet = latestWorkerFleet, options = {}) {
  const tbody = document.getElementById("runsTableBody");
  const filterBar = document.getElementById("runsFilterSummaryBar");
  if (!tbody) return;
  if (!tbody.getAttribute("data-hover-bound")) {
    tbody.setAttribute("data-hover-bound", "1");
    tbody.addEventListener("mouseenter", () => {
      isMouseOverRunsTable = true;
    });
    tbody.addEventListener("mouseleave", () => {
      isMouseOverRunsTable = false;
    });
  }

  const allRuns = Array.isArray(runs) ? runs : [];
  const recon = fleet?.spaceReconciliation || {};
  const myUser = String(recon.currentUserName || serverState?.config?.userName || serverState?.config?.resolvedUserName || "").trim();

  // Map runId -> matched rule name & jobId
  const runToJobName = new Map();
  const runToJobId = new Map();
  if (fleet && Array.isArray(fleet.jobs)) {
    for (const jf of fleet.jobs) {
      for (const w of jf.activeWorkers || []) {
        if (w.id !== undefined && w.id !== null) {
          runToJobName.set(String(w.id), jf.jobName || jf.name || "규칙");
          runToJobId.set(String(w.id), jf.jobId || "");
        }
      }
    }
  }

  const activeRunsRaw = allRuns
    .filter((r) => classifyUiRunStatus(r.status ?? r.state ?? r.phase) === "ACTIVE")
    .sort((a, b) => Number(a.id ?? a.runId ?? 0) - Number(b.id ?? b.runId ?? 0));
  const runningRuns = activeRunsRaw.filter((r) =>
    String(r.status ?? r.state ?? r.phase ?? "").toUpperCase().includes("RUNNING")
  );
  const pendingRuns = activeRunsRaw.filter(
    (r) => !String(r.status ?? r.state ?? r.phase ?? "").toUpperCase().includes("RUNNING")
  );
  // Active runs ordered: all Running first (#1..#runningCount), then Pending (#runningCount+1..#activeCount)
  const orderedActiveRuns = [...runningRuns, ...pendingRuns];
  const isMyRun = (r) => {
    const u = String(r.userId || r.userName || r.user || "").trim();
    if (!myUser || myUser === "admin" || !u) return true;
    return u.toLowerCase() === myUser.toLowerCase();
  };
  const myActiveRuns = orderedActiveRuns.filter(isMyRun);
  const terminatedRuns = allRuns.filter((r) => classifyUiRunStatus(r.status ?? r.state ?? r.phase) !== "ACTIVE");

  if (filterBar) {
    const mkBtn = (mode, label, color = "#e2e8f0") => {
      const isSel = currentSpaceRunsFilter === mode;
      return `<button type="button" class="${isSel ? "" : "secondary"} sm" onclick="setSpaceRunsFilter('${mode}')" style="padding:3px 9px; font-size:11.5px; font-weight:700; ${
        isSel ? "background:#2563eb; border:1px solid #60a5fa; color:#fff;" : `color:${color};`
      }">${label}</button>`;
    };
    const filterBarSig = `${currentSpaceRunsFilter}|${orderedActiveRuns.length}|${runningRuns.length}|${pendingRuns.length}|${myActiveRuns.length}|${allRuns.length}|${selectedWorkerRunIds.size}`;
    const filterBarHtml = `
      <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
        <span style="font-weight:800; color:#93c5fd; margin-right:2px;">🔍 표시 필터:</span>
        ${mkBtn("active", `전체 활성 (${orderedActiveRuns.length}개)`)}
        ${mkBtn("running", `🟢 Running (${runningRuns.length}개)`, "#6ee7b7")}
        ${mkBtn("pending", `⏳ Pending 대기 (${pendingRuns.length}개)`, "#fde68a")}
        ${mkBtn("mine", `👤 내 계정 활성 (${myActiveRuns.length}개)`, "#93c5fd")}
        ${mkBtn("all", `📜 종료 포함 (${allRuns.length}개)`, "#cbd5e1")}
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        ${
          selectedWorkerRunIds.size > 0
            ? `<button type="button" class="danger sm" style="padding:3px 9px; font-size:11px; font-weight:800;" onclick="executeSelectedWorkersKill(false, '')">🛑 선택(${selectedWorkerRunIds.size}개) 즉시 Kill</button>
               <button type="button" class="secondary sm" style="padding:3px 9px; font-size:11px; font-weight:800; background:rgba(159,18,57,0.55); border-color:#f43f5e; color:#ffe4e6;" onclick="executeSelectedWorkersKill(true, '')">🗑️ 선택(${selectedWorkerRunIds.size}개) 영구 삭제(-${selectedWorkerRunIds.size})</button>`
            : ""
        }
        <div class="mono" style="font-size:11.5px; color:#cbd5e1;">
          🟢 가동: <b style="color:#34d399;">${runningRuns.length}개</b> &nbsp;|&nbsp; ⏳ 대기: <b style="color:#fde68a;">${pendingRuns.length}개</b> &nbsp;|&nbsp; 전체 활성: <b>${orderedActiveRuns.length}개</b>
        </div>
      </div>
    `;
    updateHtmlIfSigChanged(filterBar, filterBarSig, filterBarHtml);
  }

  let displayList = [];
  if (currentSpaceRunsFilter === "running") {
    displayList = runningRuns;
  } else if (currentSpaceRunsFilter === "pending") {
    displayList = pendingRuns;
  } else if (currentSpaceRunsFilter === "mine") {
    displayList = myActiveRuns;
  } else if (currentSpaceRunsFilter === "all") {
    displayList = [...orderedActiveRuns, ...terminatedRuns.slice(0, 80)];
  } else {
    displayList = orderedActiveRuns;
  }

  if (!options.force && isMouseOverRunsTable) {
    return;
  }

  if (!displayList.length) {
    updateHtmlIfSigChanged(
      tbody,
      `empty:${currentSpaceRunsFilter}`,
      `<tr><td colspan="7" class="hint">선택한 필터(${currentSpaceRunsFilter})에 해당하는 워크로드가 없습니다.</td></tr>`
    );
    return;
  }

  const tableSig =
    currentSpaceRunsFilter +
    "::" +
    displayList
      .map((r) => {
        const idStr = String(r.id ?? r.runId ?? "");
        const st = String(r.status ?? r.state ?? r.phase ?? "");
        const appSt = String(r.approvalStatus ?? "");
        const rsn = String(r.reason ?? "");
        const sel = selectedWorkerRunIds.has(idStr) ? 1 : 0;
        const mj = runToJobName.get(idStr) || "";
        return `${idStr}:${st}:${appSt}:${rsn}:${sel}:${mj}`;
      })
      .join("|");

  if (tbody.getAttribute("data-render-sig") === tableSig) {
    return;
  }
  tbody.setAttribute("data-render-sig", tableSig);

  let runSeq = 0;
  let pendSeq = 0;
  tbody.innerHTML = displayList
    .map((r, idx) => {
      const id = r.id ?? r.runId;
      const idStr = String(id ?? "");
      const isSelected = selectedWorkerRunIds.has(idStr);
      const name = r.containerName ?? r.name ?? `run-${id}`;
      const userName = r.userId || r.userName || r.user || "-";
      const mine = isMyRun(r);
      const matchedJob = runToJobName.get(idStr) || null;
      const matchedJobId = runToJobId.get(idStr) || "";
      const st = String(r.status ?? r.state ?? r.phase ?? "UNKNOWN");
      const stUpper = st.toUpperCase();
      const isRun = stUpper.includes("RUNNING");
      const isAct = classifyUiRunStatus(st) === "ACTIVE";
      if (isRun) runSeq += 1;
      else if (isAct) pendSeq += 1;

      const seqLabelText = isRun ? `워커 #${runSeq}` : isAct ? `Pending대기 #${pendSeq}` : `종료 #${idx + 1}`;
      const seqBadge = isRun
        ? `<label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; margin:0;"><input type="checkbox" ${isSelected ? "checked" : ""} onchange="toggleSelectWorkerRun('${escapeHtml(idStr)}', this.checked)" style="width:13px; height:13px; margin:0; accent-color:#38bdf8;" /><span class="mono" style="color:#34d399; font-weight:800;">🟢 #${runSeq}</span></label>`
        : isAct
        ? `<label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; margin:0;"><input type="checkbox" ${isSelected ? "checked" : ""} onchange="toggleSelectWorkerRun('${escapeHtml(idStr)}', this.checked)" style="width:13px; height:13px; margin:0; accent-color:#38bdf8;" /><span class="mono" style="color:#fde68a; font-weight:800;">⏳ 대기#${pendSeq}</span></label><div class="mono" style="font-size:10px; color:#94a3b8; padding-left:18px;">(활성#${idx + 1})</div>`
        : `<span class="mono" style="color:#94a3b8;">종료 #${idx + 1}</span>`;

      const isAlreadyApproved = String(r.approvalStatus || "").toLowerCase() === "approved";
      let cls = "badge";
      if (isRun) cls = "badge ok";
      else if (isAct) cls = "badge warn";
      else if (["SUCCEEDED", "COMPLETED"].some((k) => stUpper.includes(k))) cls = "badge ok";
      else cls = "badge err";

      const displayStatus = isRun
        ? "🟢 Running (실제 가동 중)"
        : stUpper.includes("PENDING") && isAlreadyApproved
        ? `⏳ Pending (✅ 승인완료 · 클러스터 노드 대기)`
        : isAct
        ? `⏳ ${st}`
        : st;
      const gpuInfo = `${r.coreName || r.gpuName || r.coreId || "-"} ×${r.coreCount ?? r.coreNum ?? 1}`;
      const cmd = r.executionCommand || r.execCommand || r.containerImage || "-";
      const reasonText = r.reason ? `<div class="hint" style="margin-top:2px; font-size:11px; color:${cls.includes("err") ? "#f87171" : "var(--muted)"};">${escapeHtml(r.reason)}</div>` : "";
      const ruleTagHtml = matchedJob
        ? `<span style="background:rgba(16,185,129,0.18); border:1px solid rgba(16,185,129,0.45); color:#6ee7b7; padding:1px 5px; border-radius:4px; font-size:10px; margin-left:4px;">규칙:${escapeHtml(matchedJob)}</span>`
        : isAct
        ? `<span style="background:rgba(56,189,248,0.18); border:1px solid rgba(56,189,248,0.45); color:#7dd3fc; padding:1px 5px; border-radius:4px; font-size:10px; margin-left:4px;">📌 규칙외</span>`
        : "";
      const approveBtn =
        stUpper.includes("PENDING") && !isAlreadyApproved
          ? `<button class="success sm" onclick="approveSingleItem('', '${escapeHtml(idStr)}')">✅ Admin 승인</button>`
          : "";
      return `
        <tr style="${isSelected ? "background:rgba(56,189,248,0.16);" : !mine && isAct ? "background:rgba(168,85,247,0.08);" : ""}">
          <td>${seqBadge}</td>
          <td class="mono">
            <b>#${escapeHtml(idStr)}</b>
            <div style="font-size:10.5px; color:${mine ? "#93c5fd" : "#d8b4fe"};">${escapeHtml(userName)}${!mine ? " (타유저)" : ""}</div>
          </td>
          <td class="mono">
            <b>${escapeHtml(name)}</b>${ruleTagHtml}
          </td>
          <td><span class="${cls}">${escapeHtml(displayStatus)}</span>${reasonText}</td>
          <td class="mono">${escapeHtml(gpuInfo)}</td>
          <td class="mono" style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(cmd)}">${escapeHtml(cmd)}</td>
          <td>
            <div class="btn-row">
              ${approveBtn}
              <button class="secondary sm" onclick="viewRunLog('${escapeHtml(idStr)}', '${escapeHtml(name)}')">📜 로그</button>
              ${
                isAct
                  ? `<button class="danger sm" onclick="killSingleWorkerSlot('${escapeHtml(idStr)}', '${escapeHtml(name)}', '${escapeHtml(seqLabelText)}', false, '${escapeHtml(matchedJobId)}')" title="이 슬롯(#${escapeHtml(idStr)})만 즉시 강제 종료(Stop/Kill)합니다 (자동충원 유지)">🛑 Kill</button>
                     <button class="secondary sm" style="background:rgba(159,18,57,0.5); border-color:#f43f5e; color:#ffe4e6;" onclick="killSingleWorkerSlot('${escapeHtml(idStr)}', '${escapeHtml(name)}', '${escapeHtml(seqLabelText)}', true, '${escapeHtml(matchedJobId)}')" title="이 슬롯(#${escapeHtml(idStr)})을 강제 종료(Kill)하고 목표 워커 수를 -1 차감하여 다시 생성되지 않게 영구 삭제합니다">🗑️ 삭제(-1)</button>`
                  : ""
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function loadSpaceRuns(options = {}) {
  if (!sessionPassword) return;
  const tbody = document.getElementById("runsTableBody");
  try {
    const data = await api("/api/space/runs");
    if (data.workerFleet) {
      latestWorkerFleet = data.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet, options);
      if (serverState?.jobs) {
        renderJobsTable(serverState.jobs, latestWorkerFleet);
      }
    }
    latestRawSpaceRuns = data.runs || [];
    renderSpaceRunsTable(latestRawSpaceRuns, latestWorkerFleet, options);
  } catch (e) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="hint" style="color:#f87171;">런 목록 조회 오류: ${escapeHtml(e.message)}</td></tr>`;
    }
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

async function stopRun(runId, reduceTarget = false, jobId = "") {
  return killSingleWorkerSlot(runId, "", `Run #${runId}`, reduceTarget, jobId);
}

function renderHistoryTable(history) {
  const tbody = document.getElementById("historyTableBody");
  if (!tbody) return;
  if (!history.length) {
    updateHtmlIfSigChanged(
      tbody,
      "empty-history",
      `<tr><td colspan="3" class="hint">아직 기록된 스케줄러 이벤트가 없습니다.</td></tr>`
    );
    return;
  }
  const histSig = `${history.length}:${history[0]?.time || ""}:${history[0]?.message || ""}`;
  const histHtml = history
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
  updateHtmlIfSigChanged(tbody, histSig, histHtml);
}

// =========================================================================
// Batch 2 - Feature 1: In-Dashboard `/group-volume` Script Web Editor & Rolling Deploy
// =========================================================================
async function openSfmScriptEditor(optPath, opts = {}) {
  const pathInput = document.getElementById("sfmEditorFilePath");
  const ta = document.getElementById("sfmEditorTextarea");
  const badge = document.getElementById("sfmEditorStatusBadge");
  if (!pathInput || !ta) return;

  const targetPath = (optPath || pathInput.value || "/group-volume/run.sh").trim();
  pathInput.value = targetPath;
  if (badge) {
    badge.className = "badge info";
    badge.textContent = "불러오는 중...";
  }
  try {
    const res = await api(`/api/space/sfm-file?path=${encodeURIComponent(targetPath)}`);
    ta.value = res.content ?? "";
    if (badge) {
      badge.className = res.autoInject ? "badge ok" : "badge info";
      badge.textContent = res.autoInject
        ? `동기화 활성 (${res.source || "saved"})`
        : `로드됨 (${res.source || "template"})`;
    }
    if (!opts.silent) {
      showToast(`📂 [${res.path || targetPath}] 스크립트를 웹 에디터에 불러왔습니다.`);
    }
  } catch (e) {
    if (badge) {
      badge.className = "badge warn";
      badge.textContent = "새 스크립트 작성 모드";
    }
    if (!opts.silent) {
      showToast(`📝 [${targetPath}] 새 스크립트 편집 모드로 열렸습니다.`);
    }
  }
}

async function saveSfmScriptFile(rollingRestart = false) {
  const pathInput = document.getElementById("sfmEditorFilePath");
  const ta = document.getElementById("sfmEditorTextarea");
  const badge = document.getElementById("sfmEditorStatusBadge");
  if (!pathInput || !ta) return;

  const filePath = (pathInput.value || "/group-volume/run.sh").trim();
  const content = ta.value || "";

  if (rollingRestart) {
    const ok = confirm(
      `[${filePath}] 스크립트를 저장하고 현재 가동 중인 워커를 무중단 롤링 재시작하여 새 스크립트를 즉시 반영할까요?`
    );
    if (!ok) return;
  }

  try {
    const res = await api("/api/space/sfm-file", {
      method: "POST",
      body: JSON.stringify({
        path: filePath,
        content,
        rollingRestart: Boolean(rollingRestart),
        batchSize: 2,
      }),
    });
    if (badge) {
      badge.className = "badge ok";
      badge.textContent = `저장됨 · 컨테이너 시작 시 100% 자동 동기화`;
    }
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet);
    }
    if (rollingRestart) {
      showToast(
        `🚀 [${res.path}] 저장 + 가동 워커 ${res.rollingResult?.terminatedCount || 0}개 무중단 롤링 교체 시작!`
      );
    } else {
      showToast(`💾 [${res.path}] 스크립트 저장 완료! (컨테이너 시작 시 자동 동기화 반영)`);
    }
    await loadServerState();
  } catch (e) {
    alert("스크립트 저장 실패: " + e.message);
  }
}

// =========================================================================
// Batch 2 - Feature 4: Experiment Presets Bookmark Bar & 1-Click Switcher
// =========================================================================
function renderPresetsBar(presets = []) {
  const panel = document.getElementById("presetsBarPanel");
  if (!panel) return;
  const list = Array.isArray(presets) ? presets : [];
  if (list.length === 0) {
    panel.innerHTML = `<div style="font-size:12px; color:#fcd34d;">⚡ 등록된 실험 프리셋이 없습니다. 우측 상단 [⭐ 현재 설정을 프리셋으로 저장] 버튼을 눌러 추가하세요.</div>`;
    return;
  }
  const pillsHtml = list
    .map(
      (p) => `
      <div style="display:inline-flex; align-items:center; gap:4px; background:rgba(15,23,42,0.82); border:1px solid rgba(245,158,11,0.45); border-radius:6px; padding:4px 8px;">
        <button type="button" class="secondary sm" style="padding:2px 7px; font-size:11.5px; border:none; background:transparent; color:#fde68a; font-weight:700;"
          onclick="applyJobPreset('${escapeHtml(p.id)}', false, false)"
          title="클릭 시 현재 선택된 규칙에 [${escapeHtml(p.name)}] 설정 적용 (명령어: ${escapeHtml(p.executionCommand || "")} · 목표 ${p.minConcurrentRuns}워커)">
          ${escapeHtml(p.name)} <span class="mono" style="font-size:10.5px; color:#93c5fd;">[${escapeHtml(p.badge || `${p.minConcurrentRuns}W`)}]</span>
        </button>
        <button type="button" class="secondary sm" style="padding:2px 6px; font-size:10.5px; border-color:rgba(16,185,129,0.5); color:#6ee7b7;"
          onclick="applyJobPreset('${escapeHtml(p.id)}', false, true)"
          title="이 프리셋으로 새 규칙을 목록에 바로 추가합니다">➕새규칙</button>
        <button type="button" class="success sm" style="padding:2px 6px; font-size:10.5px;"
          onclick="applyJobPreset('${escapeHtml(p.id)}', true, false)"
          title="프리셋 적용과 동시에 즉시 할당 트리거">🚀적용+실행</button>
        <button type="button" class="secondary sm" style="padding:1px 5px; font-size:10px; color:#94a3b8;"
          onclick="deleteJobPreset('${escapeHtml(p.id)}')"
          title="이 프리셋 삭제">✕</button>
      </div>
    `
    )
    .join("");

  panel.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; width:100%;">
      <span style="font-size:12px; font-weight:700; color:#fcd34d; flex-shrink:0;">⚡ 4. 실험 프리셋 원클릭 전환:</span>
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; flex:1;">
        ${pillsHtml}
      </div>
    </div>
  `;
}

async function applyJobPreset(presetId, triggerImmediately = false, createAsNew = false) {
  try {
    const currentJobId = document.getElementById("jobId")?.value || "";
    const shouldCreateNew = Boolean(createAsNew || isNewJobMode);
    const res = await api("/api/presets/apply", {
      method: "POST",
      body: JSON.stringify({
        presetId,
        jobId: currentJobId,
        createAsNew: shouldCreateNew,
        triggerImmediately,
      }),
    });
    const targetJob = res.appliedJob || (res.jobs && res.jobs[0]);
    if (targetJob) {
      focusedFleetJobId = targetJob.id;
      loadJobToForm(targetJob, false, false);
    }
    if (res.workerFleet) {
      latestWorkerFleet = res.workerFleet;
      renderWorkerFleetBoard(latestWorkerFleet);
    }
    showToast(
      `⚡ 프리셋 [${res.preset?.name || presetId}] ${shouldCreateNew ? "신규 규칙으로 추가" : `[${targetJob?.name || "현재 규칙"}]에 적용`} 완료! (목표 ${res.preset?.minConcurrentRuns}워커 · ${
        res.preset?.allowSpot ? "Spot" : "Standard"
      })${triggerImmediately ? " + 즉시 실행 요청됨!" : ""}`
    );
    await loadServerState();
  } catch (e) {
    alert("프리셋 적용 실패: " + e.message);
  }
}

async function saveCurrentJobAsPreset() {
  const defaultName = `${document.getElementById("jobName")?.value || "실험"} (${document.getElementById("jobMinConcurrent")?.value || 1}워커)`;
  const name = prompt("저장할 실험 프리셋(북마크) 이름을 입력하세요:", defaultName);
  if (!name || !name.trim()) return;
  const minConcurrentRuns = Math.max(1, Number(document.getElementById("jobMinConcurrent")?.value || 1));
  const allowSpot = document.getElementById("jobAllowSpot")?.checked || false;
  const executionCommand = document.getElementById("jobExecutionCommand")?.value || "bash /group-volume/run.sh";
  const coreCount = Math.max(1, Number(document.getElementById("jobCoreCount")?.value || 1));
  const expectedRunTime = document.getElementById("jobExpectedRunTime")?.value || "8h";

  try {
    const res = await api("/api/presets", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        badge: `${minConcurrentRuns}W · ${allowSpot ? "Spot" : "Std"}`,
        executionCommand,
        minConcurrentRuns,
        coreCount,
        allowSpot,
        expectedRunTime,
      }),
    });
    renderPresetsBar(res.presets || []);
    showToast(`⭐ [${name.trim()}] 프리셋이 북마크 바에 저장되었습니다!`);
  } catch (e) {
    alert("프리셋 저장 실패: " + e.message);
  }
}

async function deleteJobPreset(presetId) {
  try {
    const res = await api(`/api/presets/${encodeURIComponent(presetId)}`, { method: "DELETE" });
    renderPresetsBar(res.presets || []);
    showToast("🗑️ 프리셋이 삭제되었습니다.");
  } catch (e) {
    alert("프리셋 삭제 실패: " + e.message);
  }
}

// =========================================================================
// Batch 2 - Feature 5: Export GPU Telemetry Report (CSV / JSON)
// =========================================================================
function exportTelemetryReport(format = "csv") {
  const pw = encodeURIComponent(sessionPassword || "");
  const url = `/api/telemetry/export?format=${encodeURIComponent(format)}&pw=${pw}`;
  window.open(url, "_blank");
  showToast(`📥 누적 GPU-Hours 리포트(${format.toUpperCase()}) 다운로드를 시작합니다.`);
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
