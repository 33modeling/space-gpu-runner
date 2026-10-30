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

async function loadServerState() {
  if (!sessionPassword) return;
  try {
    const data = await api("/api/state");
    serverState = data;
    renderConfig(data.config);
    renderJobsTable(data.jobs || []);
    renderHistoryTable(data.history || []);
    applyUiRefreshInterval(data.config?.uiRefreshIntervalSec || 5);
  } catch (e) {
    console.error(e);
  }
}

function renderConfig(cfg) {
  const activeId = document.activeElement?.id || "";
  if (activeId !== "cfgBaseUrl") document.getElementById("cfgBaseUrl").value = cfg.baseUrl || "https://mlp.n9.sr-cloud.com";
  if (activeId !== "cfgSfmUrl") document.getElementById("cfgSfmUrl").value = cfg.sfmUrl || "https://sfsm.n9.sr-cloud.com";
  if (activeId !== "cfgAccessToken") document.getElementById("cfgAccessToken").value = cfg.accessToken || "";
  if (activeId !== "cfgRefreshToken") document.getElementById("cfgRefreshToken").value = cfg.refreshToken || "";
  if (activeId !== "cfgGroupId") document.getElementById("cfgGroupId").value = cfg.groupId || "";
  if (activeId !== "cfgUserName") document.getElementById("cfgUserName").value = cfg.userName || cfg.resolvedUserName || "";
  if (activeId !== "cfgAutoApprovalScope") document.getElementById("cfgAutoApprovalScope").value = cfg.autoApprovalScope || "all_group";
  if (activeId !== "cfgIntervalSec") document.getElementById("cfgIntervalSec").value = cfg.checkIntervalSec ?? 15;
  if (activeId !== "cfgApprovalIntervalSec") document.getElementById("cfgApprovalIntervalSec").value = cfg.approvalCheckIntervalSec ?? 5;
  if (activeId !== "cfgUiRefreshSec") document.getElementById("cfgUiRefreshSec").value = cfg.uiRefreshIntervalSec ?? 5;
  if (activeId !== "cfgPostCreateDelaySec") document.getElementById("cfgPostCreateDelaySec").value = cfg.postCreateApproveDelaySec ?? 2;
  if (activeId !== "cfgPostCreateRetries") document.getElementById("cfgPostCreateRetries").value = cfg.postCreateApproveRetries ?? 8;
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
    if (cfg.schedulerEnabled && cfg.autoApprovalScope !== "off") {
      approvalBadge.className = "badge ok";
      approvalBadge.textContent = `Admin 승인감시: ${cfg.approvalCheckIntervalSec || 5}초 주기 (${cfg.autoApprovalScope || "all_group"})`;
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
  const snippet = `copy(JSON.stringify({accessToken:localStorage.getItem("access_token")||sessionStorage.getItem("access_token"),refreshToken:localStorage.getItem("refresh_token")||sessionStorage.getItem("refresh_token"),groupId:localStorage.getItem("group_id")||sessionStorage.getItem("group_id"),userName:localStorage.getItem("userName")||sessionStorage.getItem("userName")}))`;
  const onCopied = () => {
    showToast("📋 추출 코드가 복사되었습니다! space.n9.sr-cloud.com 개발자도구(F12) 콘솔에 붙여넣고 Enter를 누른 뒤, 아래 칸에 붙여넣으세요.");
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(snippet).then(onCopied).catch(() => fallbackCopyText(snippet, onCopied));
  } else {
    fallbackCopyText(snippet, onCopied);
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
  if (!raw || !raw.trim().startsWith("{")) return;
  try {
    const obj = JSON.parse(raw.trim());
    if (obj.accessToken) document.getElementById("cfgAccessToken").value = String(obj.accessToken).replace(/^"|"$/g, "");
    if (obj.refreshToken) document.getElementById("cfgRefreshToken").value = String(obj.refreshToken).replace(/^"|"$/g, "");
    if (obj.groupId) document.getElementById("cfgGroupId").value = String(obj.groupId).replace(/^"|"$/g, "");
    if (obj.userName) document.getElementById("cfgUserName").value = String(obj.userName).replace(/^"|"$/g, "");
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

    if (data.selectedGroupId) {
      document.getElementById("cfgGroupId").value = data.selectedGroupId;
      document.getElementById("groupBadge").textContent = `Group ID: ${data.selectedGroupId}`;
    }

    // 1. Populate Groups
    const groups = Array.isArray(data.groups) ? data.groups : data.groups?.items || [];
    const gSel = document.getElementById("discoveredGroupsSelect");
    gSel.innerHTML = `<option value="">-- 그룹 선택 (${groups.length}개) --</option>`;
    groups.forEach((g) => {
      const id = g.id ?? g.groupId;
      const name = g.name ?? g.groupName ?? `Group #${id}`;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `${name} (ID: ${id})`;
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
        pill.innerHTML = `<b>${pName}</b> (groupPoolId: ${pId})`;
        pill.onclick = () => {
          document.getElementById("jobGroupPoolId").value = pId;
          poolSel.value = pId;
          populateCoresForPool(pId);
          showToast(`Pool [${pName}] (#${pId}) 선택됨`);
        };
        poolsBox.appendChild(pill);
      } else {
        cores.forEach((c) => {
          const cId = c.id ?? c.coreId;
          const cName = c.name ?? c.coreName ?? c.gpuType ?? `Core #${cId}`;
          const pill = document.createElement("div");
          pill.className = "pill";
          pill.innerHTML = `🎯 <b>${pName}</b> (Pool ID: ${pId}) · <span style="color:#60a5fa; font-weight:700;">${cName}</span> (Core ID: ${cId})`;
          pill.onclick = () => {
            document.getElementById("jobGroupPoolId").value = pId;
            poolSel.value = pId;
            populateCoresForPool(pId);
            document.getElementById("jobCoreId").value = cId;
            document.getElementById("selectCoreId").value = cId;
            showToast(`✅ [${pName} / ${cName}] 자동 입력 완료! (Pool ID: ${pId}, Core ID: ${cId})`);
          };
          poolsBox.appendChild(pill);
        });
      }
    });

    if (pools.length > 0) {
      const firstPoolId = pools[0].id ?? pools[0].groupPoolId ?? pools[0].poolId;
      const currentPoolInput = document.getElementById("jobGroupPoolId");
      if (!currentPoolInput.value && firstPoolId !== undefined) {
        currentPoolInput.value = firstPoolId;
      }
      poolSel.value = currentPoolInput.value || firstPoolId;
      populateCoresForPool(currentPoolInput.value || firstPoolId);
    }

    // 3. Priorities / Quotas (auto-select first if empty)
    const priorities = Array.isArray(data.priorities) ? data.priorities : data.priorities?.items || [];
    const qSel = document.getElementById("selectQuotaId");
    qSel.innerHTML = `<option value="">-- Priority 선택 (${priorities.length}개) --</option>`;
    priorities.forEach((q) => {
      const qId = q.quotaId ?? q.id;
      const qName = q.priorityName ?? q.name ?? `Quota #${qId}`;
      const opt = document.createElement("option");
      opt.value = qId;
      opt.textContent = `${qName} (Quota ID: ${qId})`;
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

    // 5. Images (auto-select first if empty)
    const imgs = Array.isArray(data.images) ? data.images : data.images?.items || [];
    const imgSel = document.getElementById("selectImage");
    imgSel.innerHTML = `<option value="">이미지 선택 (${imgs.length})</option>`;
    imgs.forEach((im) => {
      const url = im.imageUrl || im.url || im.fullPath || im.name;
      if (!url) return;
      const opt = document.createElement("option");
      opt.value = url;
      opt.textContent = im.name ? `${im.name} (${url})` : url;
      imgSel.appendChild(opt);
    });
    if (imgs.length > 0) {
      const firstUrl = imgs[0].imageUrl || imgs[0].url || imgs[0].fullPath || imgs[0].name;
      const imgInput = document.getElementById("jobContainerImage");
      if (!imgInput.value && firstUrl) {
        imgInput.value = firstUrl;
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

function populateCoresForPool(poolId) {
  const pools = Array.isArray(discovered.groupPools) ? discovered.groupPools : [];
  const pool = pools.find((p) => String(p.id ?? p.groupPoolId ?? p.poolId) === String(poolId)) || pools[0];
  const cSel = document.getElementById("selectCoreId");
  cSel.innerHTML = `<option value="">-- Core 선택 --</option>`;
  const cores = pool?.cores || pool?.coreList || discovered.spotCores || [];
  cores.forEach((c) => {
    const cId = c.id ?? c.coreId;
    const cName = c.name ?? c.coreName ?? c.gpuType ?? `Core #${cId}`;
    const opt = document.createElement("option");
    opt.value = cId;
    opt.textContent = `${cName} (Core ID: ${cId})`;
    cSel.appendChild(opt);
  });
  if (cores.length > 0) {
    const firstCoreId = cores[0].id ?? cores[0].coreId;
    const coreInput = document.getElementById("jobCoreId");
    const matchesCurrent = cores.some((c) => String(c.id ?? c.coreId) === String(coreInput.value));
    if (!coreInput.value || !matchesCurrent) {
      coreInput.value = firstCoreId;
    }
    cSel.value = coreInput.value || firstCoreId;
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
    document.getElementById("jobAllowSpot").checked = Boolean(spec.isSpot || spec.allowSpot);
    showToast(`✨ Specification #${specId} 설정값을 모두 불러왔습니다!`);
  } catch (e) {
    alert("Specification 상세 조회 실패: " + e.message);
  }
}

async function browseSfmFiles() {
  const dirPath = document.getElementById("sfmBrowsePath").value || "/";
  const box = document.getElementById("sfmFilesList");
  box.innerHTML = `<span class="hint">조회 중...</span>`;
  try {
    const res = await api(`/api/space/sfm-files?path=${encodeURIComponent(dirPath)}`);
    const list = Array.isArray(res) ? res : res?.data || res?.files || res?.items || [];
    box.innerHTML = "";
    if (list.length === 0) {
      box.innerHTML = `<span class="hint">파일이 없거나 경로가 비어 있습니다.</span>`;
      return;
    }
    list.forEach((f) => {
      const name = f.name || f.fileName || f.path || String(f);
      const isDir = Boolean(f.isDir || f.directory || f.type === "directory" || f.type === "dir");
      const fullRel = (dirPath.replace(/\/$/, "") + "/" + name.replace(/^\//, "")).replace(/\/+/g, "/");
      const pill = document.createElement("div");
      pill.className = "pill mono";
      pill.textContent = isDir ? `📁 ${name}` : `📄 ${name}`;
      pill.onclick = () => {
        if (isDir) {
          document.getElementById("sfmBrowsePath").value = fullRel;
          browseSfmFiles();
        } else {
          const containerPath = `/group-volume${fullRel.startsWith("/") ? fullRel : "/" + fullRel}`;
          const cmd = name.endsWith(".py") ? `python3 ${containerPath}` : `bash ${containerPath}`;
          document.getElementById("jobExecutionCommand").value = cmd;
          showToast(`실행 명령어가 [${cmd}] 로 설정되었습니다.`);
        }
      };
      box.appendChild(pill);
    });
  } catch (e) {
    box.innerHTML = `<span class="hint" style="color:#f87171;">SFM 조회 실패: ${e.message} (직접 /group-volume/... 경로를 입력하셔도 됩니다)</span>`;
  }
}

function renderJobsTable(jobs) {
  const tbody = document.getElementById("jobsTableBody");
  if (!jobs.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="hint">등록된 자동 실행 규칙이 없습니다.</td></tr>`;
    return;
  }
  tbody.innerHTML = jobs
    .map((j) => {
      const badge = j.enabled
        ? `<span class="badge ok">ON</span>`
        : `<span class="badge err">OFF</span>`;
      const modeLabel =
        j.mode === "ensure_running"
          ? "항상 실행 유지"
          : j.mode === "when_gpu_free"
          ? "유휴 GPU 감시"
          : "성공 시까지";
      const approvalBadge =
        j.autoApprove !== false
          ? `<span class="badge ok" style="margin-left:4px;">Admin자동승인</span>`
          : `<span class="badge warn" style="margin-left:4px;">수동승인</span>`;
      return `
        <tr>
          <td>${badge}</td>
          <td class="mono"><b>${escapeHtml(j.name)}</b></td>
          <td>${modeLabel} (x${j.minConcurrentRuns || 1}) ${approvalBadge}</td>
          <td class="mono">Pool:${j.groupPoolId || "-"} / Core:${j.coreId || "-"} / x${j.coreCount || 1}</td>
          <td class="mono" style="color:#93c5fd;">${escapeHtml(j.executionCommand)}</td>
          <td style="font-size:12px;">${escapeHtml(j.lastStatus || "대기 중")}</td>
          <td>
            <div class="btn-row">
              <button class="success sm" onclick="triggerJobNow('${j.id}')">▶ 즉시 할당+승인</button>
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
  document.getElementById("jobExperimentId").value = j.experimentId || "";
  document.getElementById("jobExpectedRunTime").value = j.expectedRunTime || "8h";
  document.getElementById("jobCooldownSec").value = j.cooldownSec || 10;
  document.getElementById("jobExecutionCommand").value = j.executionCommand || "bash /group-volume/run.sh";
  document.getElementById("jobEnabled").checked = Boolean(j.enabled);
  document.getElementById("jobAutoApprove").checked = j.autoApprove !== false;
  document.getElementById("jobRestartOnSuccess").checked = j.restartOnSuccess !== false;
  document.getElementById("jobRestartOnFail").checked = j.restartOnFail !== false;
  document.getElementById("jobAllowSpot").checked = Boolean(j.allowSpot);
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

async function saveJobRule() {
  try {
    const payload = {
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
      allowSpot: document.getElementById("jobAllowSpot").checked,
      enableWebConsole: document.getElementById("jobEnableWebConsole").checked,
    };
    await api("/api/jobs", { method: "POST", body: JSON.stringify(payload) });
    showToast("✅ 자동 실행 규칙(Admin Run-Approval 자동 승인 포함)이 저장되었습니다.");
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
    showToast("🚀 SPACE WLM에 GPU 할당 요청 및 Admin Run-Approval 즉시 추적 승인 중...");
    const res = await api("/api/jobs/trigger", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    });
    const appCnt = res.result?.approvalResult?.approvedCount || 0;
    showToast(
      `✅ 실행 제출 완료: ${res.result?.payload?.containerName || ""}${
        appCnt > 0 ? ` (Admin Run-Approval ${appCnt}건 즉시 승인됨!)` : " (백그라운드 승인 감시 중)"
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
    const approvals = data.approvals || [];
    const orbitRuns = data.taskOrbitRuns || [];

    const rows = [];

    // 1. Items from `/taskorbit/api/v1/approvals` (SPACE `/run-approval` page)
    const seenRunIds = new Set();
    approvals.forEach((item) => {
      if (item.runId) seenRunIds.add(String(item.runId));
      const resInfo = item.resources || {};
      const resStr = `GPU: ${resInfo.gpu ?? 0} | CPU: ${resInfo.cpu ?? "-"} | MEM: ${resInfo.memory ?? "-"}`;
      rows.push({
        source: "Approvals (/run-approval)",
        approvalId: item.id,
        runId: item.runId || "-",
        runName: item.runName || item.runId || "-",
        user: `${item.userId || "-"} / ${item.namespace || "-"}`,
        resourceText: resStr,
        stageLabel: `PENDING (Awaiting Admin Approval · ${item.status || "pending"})`,
        isPending: !item.status || String(item.status).toLowerCase() === "pending",
      });
    });

    // 2. Items from `/taskorbit/api/v1/runs` (TaskOrbit Queue)
    orbitRuns.forEach((r) => {
      const rId = String(r.runId || r.id || "");
      if (seenRunIds.has(rId) && r.status === "PENDING") return;
      const stageMap = {
        approval: "PENDING (Awaiting Admin Approval)",
        limit: "APPROVED (Limit Reached)",
        queue: "ADMITTED (Queued)",
        scheduled: r.status || "SCHEDULED",
      };
      rows.push({
        source: "TaskOrbit Queue",
        approvalId: null,
        runId: rId,
        runName: r.runName || r.name || rId,
        user: `${r.userId || "-"} / ${r.groupId || "-"}`,
        resourceText: r.resourceProfile || r.coreName || `Priority: ${r.priorityValue ?? "Spot/Express"}`,
        stageLabel: stageMap[r.stage] || r.status,
        isPending: r.status === "PENDING",
      });
    });

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="hint">현재 승인 대기 중(PENDING)이거나 TaskOrbit 큐에 대기 중인 워크로드가 없습니다.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map((row) => {
        const badgeCls = row.isPending ? "badge warn" : "badge ok";
        const actionBtns = row.isPending
          ? `<div class="btn-row">
              <button class="success sm" onclick="approveSingleItem('${row.approvalId || ""}', '${escapeHtml(row.runId)}')">✅ Admin 승인(Approve)</button>
              <button class="danger sm" onclick="rejectSingleItem('${row.approvalId || ""}', '${escapeHtml(row.runId)}')">❌ 반려(Reject)</button>
            </div>`
          : `<span class="hint">승인 통과됨</span>`;
        return `
          <tr>
            <td class="mono">${escapeHtml(row.source)}${row.approvalId ? ` (#${row.approvalId})` : ""}</td>
            <td class="mono"><b>${escapeHtml(row.runName)}</b><br/><span class="hint">${escapeHtml(row.runId)}</span></td>
            <td class="mono">${escapeHtml(row.user)}</td>
            <td class="mono">${escapeHtml(row.resourceText)}</td>
            <td><span class="${badgeCls}">${escapeHtml(row.stageLabel)}</span></td>
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
        let cls = "badge";
        if (stUpper.includes("PENDING")) cls = "badge warn";
        else if (["RUNNING", "CREATING", "STAGING", "APPROVED", "ADMITTED", "SCHEDULED"].some((k) => stUpper.includes(k))) cls = "badge ok";
        else if (["FAILED", "ERROR", "STOPPED", "KILLED", "REJECTED"].some((k) => stUpper.includes(k))) cls = "badge err";
        const gpuInfo = `${r.coreName || r.gpuName || r.coreId || "-"} x${r.coreCount ?? r.coreNum ?? 1}`;
        const cmd = r.executionCommand || r.execCommand || r.containerImage || "-";
        const approveBtn = stUpper.includes("PENDING")
          ? `<button class="success sm" onclick="approveSingleItem('', '${escapeHtml(String(id))}')">✅ Admin 승인</button>`
          : "";
        return `
          <tr>
            <td class="mono">#${id}</td>
            <td class="mono"><b>${escapeHtml(name)}</b></td>
            <td><span class="${cls}">${escapeHtml(st)}</span></td>
            <td class="mono">${escapeHtml(gpuInfo)}</td>
            <td class="mono" style="max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(cmd)}">${escapeHtml(cmd)}</td>
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
