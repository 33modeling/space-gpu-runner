#!/usr/bin/env node
/**
 * SPACE GPU Runner Terminal CLI (`gpu-ctl` / `npm run cli -- ...`)
 * Zero-dependency SSH terminal controller for `space-gpu-runner` (:4300).
 */

const BASE_URL = String(process.env.GPU_RUNNER_URL || "http://127.0.0.1:4300").replace(/\/$/, "");
const PASSWORD = String(process.env.RUNNER_PASSWORD || "cycy");

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

async function apiCall(pathname, { method = "GET", body = undefined, siteId = "" } = {}) {
  const headers = {
    "X-Admin-Password": PASSWORD,
    ...(siteId ? { "X-Site-Id": siteId } : {}),
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

function findJobByNameOrId(jobs = [], query = "") {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return jobs.find((j) => j.enabled) || jobs[0] || null;
  return (
    jobs.find((j) => String(j.id).toLowerCase() === q || String(j.name).toLowerCase() === q) ||
    jobs.find((j) => String(j.name).toLowerCase().includes(q)) ||
    null
  );
}

function fmtDur(sec) {
  if (sec === null || sec === undefined) return "-";
  const s = Math.max(0, Math.round(Number(sec || 0)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 > 0 ? ` ${m % 60}m` : ""}`;
}

function printHelp() {
  console.log(`
SPACE GPU Runner Terminal CLI (gpu-ctl)
Target Server: ${BASE_URL}

Usage:
  node bin/gpu-ctl.mjs status [--site n9|n6] [--json]
  node bin/gpu-ctl.mjs target <rule> <workers> [--pending <n>] [--site n9]
  node bin/gpu-ctl.mjs gpus   <rule> <totalGpus> [--site n9]
  node bin/gpu-ctl.mjs toggle <rule> <on|off>
  node bin/gpu-ctl.mjs spawn  <rule> [count]
  node bin/gpu-ctl.mjs drain  <rule> [--next <nextRule>] [--stop]
  node bin/gpu-ctl.mjs grep   <query> [--regex] [--tail 100] [--rule <name>]
  node bin/gpu-ctl.mjs log    <slotOrRunId> [--rule <name>] [--tail 80]
  node bin/gpu-ctl.mjs preflight <ruleOrCommand>
`);
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = (pos[0] || "status").toLowerCase();
  const siteId = typeof flags.site === "string" ? flags.site : "";

  if (cmd === "help" || cmd === "-h" || flags.help) {
    printHelp();
    return;
  }

  if (cmd === "status" || cmd === "st") {
    const st = await apiCall("/api/state", { siteId });
    if (flags.json) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    const wf = st.workerFleet || {};
    const tel = wf.telemetry || {};
    const qv = wf.queueVelocity || {};
    console.log(`========================================================================`);
    console.log(
      `[SPACE GPU Runner] Site: ${(st.activeSiteId || "n9").toUpperCase()} (${wf.gpuModel || "GPU"}) | Auto-Scheduler: ${
        wf.schedulerEnabled ? "ON" : "PAUSED"
      }`
    );
    console.log(
      `Total Running: ${wf.totalRunningWorkers || 0}W (${wf.totalRunningGpus || 0}G) | Pending: ${
        wf.totalPendingWorkers || 0
      }W | Cumulative: ${tel.totalGpuHours || 0} GPU-h (Today +${tel.todayGpuHours || 0})`
    );
    console.log(
      `Queue Velocity (1h): ${qv.promotionsLast1h || 0} promotions | Median Wait: ${fmtDur(qv.medianWaitSec)}`
    );
    console.log(`------------------------------------------------------------------------`);
    for (const jf of wf.jobs || []) {
      const stateTag = jf.draining ? "DRAIN" : jf.enabled ? "ON   " : "OFF  ";
      const tqTag = jf.taskQueue?.enabled ? ` | Sweep ${jf.taskQueue.completedCount}/${jf.taskQueue.totalTasks}` : "";
      const ghTag = jf.gpuHoursTotal > 0 ? ` | ${jf.gpuHoursTotal} GPU-h` : "";
      console.log(
        `[${stateTag}] ${jf.jobName.padEnd(16)} Run ${String(jf.runningCount).padStart(2)}/${String(jf.targetCount).padEnd(
          3
        )} (${jf.runningGpuCount}/${jf.targetGpuCount}G) | Pend ${jf.pendingCount}/${jf.targetPendingCount || 0}${tqTag}${ghTag}`
      );
    }
    console.log(`========================================================================`);
    return;
  }

  const st = await apiCall("/api/state", { siteId });
  const jobs = st.jobs || [];

  if (cmd === "target") {
    const job = findJobByNameOrId(jobs, pos[1]);
    if (!job) throw new Error(`Rule not found: ${pos[1] || ""}`);
    const workers = Number(pos[2]);
    if (!Number.isFinite(workers) || workers < 1) throw new Error("Specify valid worker count (>= 1)");
    const body = {
      jobId: job.id,
      minConcurrentRuns: Math.round(workers),
      ...(flags.pending !== undefined ? { targetPendingRuns: Math.max(0, Number(flags.pending)) } : {}),
    };
    const res = await apiCall("/api/jobs/target", { method: "POST", body, siteId });
    console.log(
      `[OK] [${res.job.name}] Target updated -> ${res.job.minConcurrentRuns} workers (${
        res.job.minConcurrentRuns * (res.job.coreCount || 1)
      } GPUs), Pending=${res.job.targetPendingRuns || 0}`
    );
    return;
  }

  if (cmd === "gpus") {
    const job = findJobByNameOrId(jobs, pos[1]);
    if (!job) throw new Error(`Rule not found: ${pos[1] || ""}`);
    const totalGpus = Number(pos[2]);
    if (!Number.isFinite(totalGpus) || totalGpus < 1) throw new Error("Specify valid GPU count (>= 1)");
    const res = await apiCall("/api/jobs/target", {
      method: "POST",
      body: { jobId: job.id, targetGpus: Math.round(totalGpus) },
      siteId,
    });
    console.log(
      `[OK] [${res.job.name}] Target GPUs updated -> ${res.job.minConcurrentRuns} workers × ${res.job.coreCount || 1}G = ${
        res.job.minConcurrentRuns * (res.job.coreCount || 1)
      } GPUs`
    );
    return;
  }

  if (cmd === "toggle") {
    const job = findJobByNameOrId(jobs, pos[1]);
    if (!job) throw new Error(`Rule not found: ${pos[1] || ""}`);
    const mode = String(pos[2] || "").toLowerCase();
    const enabled = mode === "on" || mode === "true" || mode === "1" ? true : mode === "off" || mode === "false" || mode === "0" ? false : !job.enabled;
    await apiCall("/api/jobs/toggle", { method: "POST", body: { jobId: job.id, enabled }, siteId });
    console.log(`[OK] [${job.name}] Auto-generation -> ${enabled ? "ON" : "PAUSED"}`);
    return;
  }

  if (cmd === "spawn") {
    const job = findJobByNameOrId(jobs, pos[1]);
    if (!job) throw new Error(`Rule not found: ${pos[1] || ""}`);
    const count = Math.max(1, Number(pos[2] || 1));
    const res = await apiCall("/api/space/runs/spawn-extra", {
      method: "POST",
      body: { jobId: job.id, count },
      siteId,
    });
    console.log(`[OK] [${job.name}] Spawned ${res.spawnedCount || count} worker(s).`);
    return;
  }

  if (cmd === "drain") {
    const job = findJobByNameOrId(jobs, pos[1]);
    if (!job) throw new Error(`Rule not found: ${pos[1] || ""}`);
    if (flags.stop) {
      await apiCall("/api/jobs/drain", { method: "POST", body: { jobId: job.id, draining: false }, siteId });
      console.log(`[OK] [${job.name}] Graceful drain stopped.`);
      return;
    }
    const nextJob = flags.next ? findJobByNameOrId(jobs, String(flags.next)) : null;
    await apiCall("/api/jobs/drain", {
      method: "POST",
      body: { jobId: job.id, draining: true, nextJobId: nextJob?.id || "", cancelPending: true },
      siteId,
    });
    console.log(`[OK] [${job.name}] Graceful drain started${nextJob ? ` -> handover to [${nextJob.name}]` : ""}.`);
    return;
  }

  if (cmd === "grep") {
    const query = pos[1];
    if (!query) throw new Error("Provide search query: gpu-ctl grep <query>");
    const job = flags.rule ? findJobByNameOrId(jobs, String(flags.rule)) : null;
    const res = await apiCall("/api/space/runs/log-grep", {
      method: "POST",
      body: {
        query,
        jobId: job?.id || "",
        isRegex: Boolean(flags.regex),
        tailLines: Number(flags.tail || 100),
      },
      siteId,
    });
    console.log(
      `Scanned ${res.scannedWorkers}/${res.totalRunningCandidates} Running workers in ${res.elapsedMs}ms -> ${res.totalMatches} match(es) across ${res.matchedWorkers} worker(s)`
    );
    for (const item of res.results || []) {
      console.log(`\n--- ${item.runName} (#${item.runId}${item.nodeName ? ` @ ${item.nodeName}` : ""}) ---`);
      for (const m of item.matches || []) {
        console.log(`  L${m.lineNumber}: ${m.line}`);
      }
    }
    return;
  }

  if (cmd === "log") {
    const targetSpec = String(pos[1] || "").trim();
    if (!targetSpec) throw new Error("Provide slot number or #runId: gpu-ctl log <slotOrRunId>");
    const wfJobs = st.workerFleet?.jobs || [];
    const jf = flags.rule
      ? wfJobs.find((x) => x.jobName.toLowerCase().includes(String(flags.rule).toLowerCase()))
      : wfJobs.find((x) => x.enabled && x.activeCount > 0) || wfJobs[0];
    let runId = targetSpec.startsWith("#") ? targetSpec.slice(1) : "";
    let runLabel = `#${runId}`;
    if (!runId && jf) {
      const num = Number(targetSpec);
      const bySlot = (jf.activeWorkers || []).find(
        (w) => Number(w.assignedSlot) === num || Number(w.slotIndex) === num || String(w.id) === targetSpec
      );
      if (bySlot) {
        runId = String(bySlot.id);
        runLabel = `${bySlot.name} (#${runId})`;
      } else if (num > 1000) {
        runId = String(num);
      }
    }
    if (!runId) throw new Error(`Could not resolve active worker for '${targetSpec}'`);
    const tail = Math.max(10, Number(flags.tail || 80));
    const logRes = await apiCall(`/api/space/runs/${encodeURIComponent(runId)}/log?tailLines=${tail}`, { siteId });
    console.log(`=== Log: ${runLabel} ===\n${typeof logRes.log === "string" ? logRes.log : JSON.stringify(logRes.log, null, 2)}`);
    return;
  }

  if (cmd === "preflight") {
    const rawTarget = pos.slice(1).join(" ").trim();
    const matchedRule = findJobByNameOrId(jobs, rawTarget);
    const executionCommand = matchedRule ? matchedRule.executionCommand : rawTarget;
    const res = await apiCall("/api/jobs/preflight", {
      method: "POST",
      body: { executionCommand },
      siteId,
    });
    console.log(`Pre-Flight Check (${res.ok ? "PASS" : "ERRORS FOUND"}):`);
    for (const c of res.checks || []) {
      const icon = c.severity === "error" ? "[ERR] " : c.severity === "warn" ? "[WARN]" : "[OK]  ";
      console.log(`  ${icon} ${c.title}: ${c.detail}`);
    }
    if (!res.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command '${cmd}'. Run 'gpu-ctl help' for usage.`);
}

main().catch((err) => {
  console.error(`[gpu-ctl Error] ${err.message}`);
  process.exit(1);
});
