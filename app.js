const API_BASE = "https://api.torn.com/v2";
const MEMBERS_POLL_MS = 15_000;
const WAR_POLL_MS = 60_000;
const TICK_MS = 1_000;
const RECENT_WINDOW_S = 5 * 60;
const INACTIVE_S = 24 * 60 * 60;
const HOSPITAL_ALERT_S = 120;

const LS_KEY = "fwt.apiKey";
const LS_ENEMY = "fwt.manualEnemyId";
const LS_OWN = "fwt.ownFactionId";
const LS_MIN_LVL = "fwt.minLvl";
const LS_MAX_LVL = "fwt.maxLvl";
const LS_ROOM = "fwt.roomCode";
const LS_ME = "fwt.me";
const LS_FFKEY = "fwt.ffKey";
const LS_MANUAL_TOTAL = "fwt.manualTotal";
const LS_SORT_STATS = "fwt.sortByStats";
const LS_HIDE_OVER = "fwt.hideOverMe";

const state = {
  apiKey: localStorage.getItem(LS_KEY) || "",
  manualEnemyId: Number(localStorage.getItem(LS_ENEMY)) || 0,
  ownFactionId: Number(localStorage.getItem(LS_OWN)) || 0,
  enemyFactionId: 0,
  enemyFactionName: "",
  members: [],
  alertedHospital: new Set(),
  filterMinLvl: Number(localStorage.getItem(LS_MIN_LVL)) || 0,
  filterMaxLvl: Number(localStorage.getItem(LS_MAX_LVL)) || 0,
  membersTimer: null,
  warTimer: null,
  tickTimer: null,
  lastUpdated: 0,
  serverOffsetMs: 0,
  offsetSamples: [], // { offsetMs, rttMs, takenAt } — NTP-style best-RTT pool
  roomCode: localStorage.getItem(LS_ROOM) || "",
  me: JSON.parse(localStorage.getItem(LS_ME) || "null"),
  claims: {},
  ffKey: localStorage.getItem(LS_FFKEY) || "",
  manualTotal: Number(localStorage.getItem(LS_MANUAL_TOTAL)) || 0,
  sortByStats: localStorage.getItem(LS_SORT_STATS) === "1",
  hideOverMe: localStorage.getItem(LS_HIDE_OVER) === "1",
};

// Torn error codes and HTTP statuses that are transient (server-side blip,
// rate limit) — suppress the banner and wait for the next poll.
const TRANSIENT_CODES = new Set([5, 17]);
const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504]);

function isTransient(err) {
  if (err instanceof TypeError) return true; // network/CORS failure (often a 504 with no CORS header)
  if (err.httpStatus && TRANSIENT_HTTP.has(err.httpStatus)) return true;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  return false;
}

async function apiGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API_BASE}${path}${sep}key=${encodeURIComponent(state.apiKey)}`;
  const t0 = performance.now();
  const wall0 = Date.now();
  let res;
  try {
    res = await fetch(url);
  } catch (networkErr) {
    throw networkErr; // TypeError — caller sees isTransient = true
  }
  // Sample the clock offset as close to header receipt as possible — before
  // res.json() drains the body, which can add hundreds of ms on slow links.
  const t1 = performance.now();
  const rttMs = t1 - t0;
  const dateHeader = res.headers.get("date");
  if (dateHeader) {
    const serverMs = Date.parse(dateHeader);
    if (Number.isFinite(serverMs)) {
      // Date header is whole-second precision and stamped mid-response;
      // add 500ms to centre it in its second, then assume symmetric latency
      // so the true server moment was rttMs/2 after we fired the request.
      const localAtServerStamp = wall0 + rttMs / 2;
      const offsetMs = serverMs + 500 - localAtServerStamp;
      recordOffsetSample(offsetMs, rttMs);
    }
  }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.httpStatus = res.status;
    throw e;
  }
  const data = await res.json();
  if (data && data.error) {
    const e = new Error(data.error.error || "API error");
    e.code = data.error.code;
    throw e;
  }
  return data;
}

async function fetchMe() {
  if (state.me && state.me.id && state.me.name) return state.me;
  const url = `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(state.apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error) {
    const e = new Error(data.error.error || "API error");
    e.code = data.error.code;
    throw e;
  }
  const id = data?.player_id ?? data?.basic?.player_id ?? data?.basic?.id ?? data?.id;
  const name = data?.name ?? data?.basic?.name;
  if (!id || !name) {
    console.error("fetchMe unexpected response:", data);
    throw new Error("Could not read own identity (see console)");
  }
  state.me = { id, name };
  localStorage.setItem(LS_ME, JSON.stringify(state.me));
  return state.me;
}

async function fetchOwnFactionId() {
  const data = await apiGet("/faction/basic");
  const id = data?.basic?.id ?? data?.id;
  if (!id) throw new Error("Could not read own faction id");
  state.ownFactionId = id;
  localStorage.setItem(LS_OWN, String(id));
  return id;
}

async function fetchWar() {
  const data = await apiGet("/faction/wars");
  const ranked = data?.wars?.ranked;
  if (!ranked || !Array.isArray(ranked.factions)) return null;
  const own = state.ownFactionId;
  const enemy = ranked.factions.find((f) => f.id !== own);
  if (!enemy) return null;
  return { id: enemy.id, name: enemy.name || `Faction ${enemy.id}` };
}

async function fetchMembers(factionId) {
  const data = await apiGet(`/faction/${factionId}/members`);
  const list = data?.members;
  if (!Array.isArray(list)) throw new Error("members payload missing");
  return list;
}

// ---------- Polling ----------

async function refreshWar() {
  if (state.manualEnemyId) {
    if (state.enemyFactionId !== state.manualEnemyId) {
      state.enemyFactionId = state.manualEnemyId;
      state.enemyFactionName = `Faction ${state.manualEnemyId}`;
      renderWarLabel();
      refreshMembers();
    }
    return;
  }
  try {
    if (!state.ownFactionId) await fetchOwnFactionId();
    const enemy = await fetchWar();
    if (!enemy) {
      state.enemyFactionId = 0;
      state.enemyFactionName = "";
      renderWarLabel();
      return;
    }
    if (enemy.id !== state.enemyFactionId) {
      state.enemyFactionId = enemy.id;
      state.enemyFactionName = enemy.name;
      renderWarLabel();
      syncRoomMeta();
      refreshMembers();
    }
  } catch (err) {
    if (!isTransient(err)) showBanner(`War lookup: ${err.message}`);
  }
}

async function refreshMembers() {
  if (!state.enemyFactionId) return;
  try {
    state.members = await fetchMembers(state.enemyFactionId);
    state.lastUpdated = Date.now();
    setPollStatus("ok");
    renderBoard();
    hideBanner();
    // Stat estimates: fire-and-forget; re-render once FFScouter rows arrive.
    // Errors are swallowed inside Stats — no banner, no broken UI.
    Stats.refreshTargets(state.members.map((m) => m.id))
      .then((r) => { if (r && r.fetched) renderBoard(); })
      .catch(() => {});
  } catch (err) {
    if (isTransient(err)) {
      setPollStatus("err");
      // Silently wait for next poll — 504/network blips on Torn's side are common
      // and self-resolve. Don't clobber the last good data or show a scary banner.
      return;
    }
    setPollStatus("err");
    showBanner(`Members fetch: ${err.message}${err.code ? ` (code ${err.code})` : ""}`);
  }
}

function startPolling() {
  stopPolling();
  refreshWar();
  refreshMembers();
  state.warTimer = setInterval(refreshWar, WAR_POLL_MS);
  state.membersTimer = setInterval(refreshMembers, MEMBERS_POLL_MS);
  state.tickTimer = setInterval(tick, TICK_MS);
}

function stopPolling() {
  if (state.membersTimer) clearInterval(state.membersTimer);
  if (state.warTimer) clearInterval(state.warTimer);
  if (state.tickTimer) clearInterval(state.tickTimer);
  state.membersTimer = state.warTimer = state.tickTimer = null;
}

// ---------- Derived buckets ----------

function bucket(member) {
  const la = member.last_action || {};
  const online = la.status === "Online";
  const ageS = la.timestamp ? Math.max(0, nowS() - la.timestamp) : Infinity;
  if (online) return "online";
  if (ageS <= RECENT_WINDOW_S) return "recent";
  if (ageS >= INACTIVE_S) return "inactive";
  const s = member.status?.state || "";
  if (s === "Hospital") return "hospital";
  if (s === "Traveling" || s === "Abroad" || s === "Jail" || s === "Federal") return "away";
  if (s === "Okay") return "hittable";
  return "away";
}

// Keep recent offset samples and use the one with the lowest RTT — same idea
// as NTP's best-sample selection. Filters out jitter from slow responses.
const OFFSET_SAMPLE_WINDOW_MS = 5 * 60 * 1000;
const OFFSET_SAMPLE_MAX = 16;

function recordOffsetSample(offsetMs, rttMs) {
  const now = Date.now();
  state.offsetSamples.push({ offsetMs, rttMs, takenAt: now });
  // Drop samples older than the window, and cap total size.
  state.offsetSamples = state.offsetSamples
    .filter((s) => now - s.takenAt <= OFFSET_SAMPLE_WINDOW_MS)
    .slice(-OFFSET_SAMPLE_MAX);
  let best = state.offsetSamples[0];
  for (const s of state.offsetSamples) if (s.rttMs < best.rttMs) best = s;
  state.serverOffsetMs = best.offsetMs;
}

function nowS() {
  return Math.floor((Date.now() + state.serverOffsetMs) / 1000);
}

function fmtRelative(secAgo) {
  if (secAgo < 60) return `${secAgo}s ago`;
  if (secAgo < 3600) return `${Math.floor(secAgo / 60)}m ago`;
  if (secAgo < 86400) return `${Math.floor(secAgo / 3600)}h ago`;
  return `${Math.floor(secAgo / 86400)}d ago`;
}

function fmtCountdown(secs) {
  if (secs <= 0) return "out!";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// ---------- Rendering ----------

const el = {
  warLabel: document.getElementById("war-label"),
  lastUpdated: document.getElementById("last-updated"),
  pollDot: document.getElementById("poll-dot"),
  board: document.getElementById("board"),
  setup: document.getElementById("setup"),
  setupErr: document.getElementById("setup-err"),
  banner: document.getElementById("banner"),
  notifyBtn: document.getElementById("notify-btn"),
  trackInput: document.getElementById("track-input"),
  trackBtn: document.getElementById("track-btn"),
  autoBtn: document.getElementById("auto-btn"),
  roomInput: document.getElementById("room-input"),
  joinBtn: document.getElementById("join-btn"),
  leaveBtn: document.getElementById("leave-btn"),
  roomLabel: document.getElementById("room-label"),
  sortStatsBtn: document.getElementById("sort-stats-btn"),
  hideOverBtn: document.getElementById("hide-over-btn"),
  ownStatsLabel: document.getElementById("own-stats-label"),
};

function fmtTotal(n) {
  if (!n) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, "") + "k";
  return String(n);
}

function renderOwnStatsLabel() {
  if (!el.ownStatsLabel) return;
  if (Stats.ownTotal > 0) {
    const src = Stats.ownSource === "manual" ? " (manual)" : "";
    el.ownStatsLabel.textContent = `my: ${fmtTotal(Stats.ownTotal)}${src}`;
    el.ownStatsLabel.title = `Your total battle stats: ${Stats.ownTotal.toLocaleString()}`;
  } else {
    el.ownStatsLabel.textContent = "my: —";
    el.ownStatsLabel.title = "Set your stats in Settings to enable comparison";
  }
}

function renderToggleStates() {
  el.sortStatsBtn?.classList.toggle("active", !!state.sortByStats);
  el.hideOverBtn?.classList.toggle("active", !!state.hideOverMe);
}

function renderWarLabel() {
  const manual = !!state.manualEnemyId;
  if (state.enemyFactionId) {
    const prefix = manual ? "Tracking" : "vs";
    el.warLabel.textContent = `${prefix} ${state.enemyFactionName} [${state.enemyFactionId}]`;
  } else {
    el.warLabel.textContent = "No war detected";
  }
  el.autoBtn.hidden = !manual;
  el.trackInput.value = manual ? String(state.manualEnemyId) : "";
}

function renderBoard() {
  const buckets = { online: [], recent: [], hospital: [], hittable: [], away: [], inactive: [] };
  for (const m of state.members) buckets[bucket(m)].push(m);

  buckets.online.sort(byLastActionDesc);
  buckets.recent.sort(byLastActionDesc);
  buckets.hospital.sort((a, b) => (a.status?.until || 0) - (b.status?.until || 0));
  buckets.hittable.sort((a, b) => (a.level || 0) - (b.level || 0));
  buckets.away.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  buckets.inactive.sort(byLastActionDesc);

  if (state.sortByStats) {
    [buckets.online, buckets.recent, buckets.hittable].forEach((b) => b.sort(byEstimateAsc));
  }

  const hideOver = state.hideOverMe && Stats.ownTotal > 0;
  const passes = (m) => !hideOver || Stats.getEstimate(m).rating !== "red";

  const hittableFiltered = buckets.hittable.filter((m) => {
    if (state.filterMinLvl && m.level < state.filterMinLvl) return false;
    if (state.filterMaxLvl && m.level > state.filterMaxLvl) return false;
    return passes(m);
  });
  const onlineFiltered = buckets.online.filter(passes);
  const recentFiltered = buckets.recent.filter(passes);

  renderList("online", onlineFiltered, renderOnline);
  renderList("recent", recentFiltered, renderRecent);
  renderList("hospital", buckets.hospital, renderHospital);
  renderList("hittable", hittableFiltered, renderHittable);
  renderList("away", buckets.away, renderAway);
  renderList("inactive", buckets.inactive, renderInactive);

  checkHospitalAlerts(buckets.hospital);
  renderLastUpdated();
}

function renderList(panel, items, rowFn) {
  const ul = document.getElementById(`list-${panel}`);
  const count = document.getElementById(`count-${panel}`);
  count.textContent = items.length;
  ul.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const m of items) frag.appendChild(rowFn(m));
  ul.appendChild(frag);
}

function byLastActionDesc(a, b) {
  return (b.last_action?.timestamp || 0) - (a.last_action?.timestamp || 0);
}

function byEstimateAsc(a, b) {
  // Unknown estimates go to the bottom so the sortable head is meaningful.
  const ea = Stats.getEstimate(a).bs;
  const eb = Stats.getEstimate(b).bs;
  if (ea == null && eb == null) return (a.level || 0) - (b.level || 0);
  if (ea == null) return 1;
  if (eb == null) return -1;
  return ea - eb;
}

function memberRow(m, infoLeft, infoRight, extraClass) {
  const li = document.createElement("li");
  li.className = "member" + (extraClass ? ` ${extraClass}` : "");
  li.dataset.id = m.id;

  const nameCell = document.createElement("div");
  nameCell.className = "name";
  const a = document.createElement("a");
  a.href = `https://www.torn.com/profiles.php?XID=${m.id}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = m.name || `#${m.id}`;
  nameCell.appendChild(a);

  const lvl = document.createElement("div");
  lvl.className = "lvl";
  lvl.textContent = `lvl ${m.level ?? "?"}`;

  const info = document.createElement("div");
  info.className = "info";
  const left = document.createElement("span");
  left.innerHTML = infoLeft || "";
  const right = document.createElement("span");
  if (typeof infoRight === "string") right.innerHTML = infoRight;
  else if (infoRight) right.appendChild(infoRight);
  info.appendChild(left);
  info.appendChild(right);

  li.appendChild(nameCell);
  li.appendChild(lvl);
  li.appendChild(statsCell(m));
  li.appendChild(info);
  const slot = claimSlot(m);
  if (slot) li.appendChild(slot);
  return li;
}

function statsCell(m) {
  const est = Stats.getEstimate(m);
  const cell = document.createElement("div");
  cell.className = `stats rating-${est.rating}`;
  if (est.source === "ffscouter") {
    const ageS = est.lastUpdated ? Math.max(0, nowS() - est.lastUpdated) : null;
    cell.title = ageS != null
      ? `FFScouter · updated ${fmtRelative(ageS)}`
      : "FFScouter";
  } else if (est.source === "rank") {
    cell.title = `Rank-based estimate (${m.rank || "?"})`;
  } else {
    cell.title = "No stat estimate available";
  }
  const bs = document.createElement("span");
  bs.className = "bs";
  bs.textContent = est.bsHuman || "?";
  cell.appendChild(bs);
  if (est.ff != null) {
    const ff = document.createElement("span");
    ff.className = `ff ff-${est.ffRating}`;
    ff.textContent = `FF ${est.ff.toFixed(1)}`;
    cell.appendChild(ff);
  }
  return cell;
}

function claimSlot(m) {
  if (!state.roomCode) return null;
  const claim = state.claims[String(m.id)];
  const row = document.createElement("div");
  row.className = "claim-slot";
  row.dataset.targetId = m.id;
  const actions = document.createElement("span");
  actions.className = "claim-actions";

  function addBtn(label, action, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `claim-btn ${cls || ""}`.trim();
    b.textContent = label;
    b.addEventListener("click", () => onClaimAction(m, action));
    actions.appendChild(b);
  }

  if (claim) {
    const mine = state.me && claim.claimerId === state.me.id;
    const perma = !!claim.permanent;
    const badge = document.createElement("span");
    badge.className = `claim-badge ${mine ? "mine" : "theirs"}${perma ? " perma" : ""}`;
    const tail = perma
      ? "<em>permaclaim</em>"
      : `<span data-claim-until="${claim.expiresAt}">${fmtCountdown(Math.max(0, Math.floor((claim.expiresAt - Date.now()) / 1000)))}</span>`;
    badge.innerHTML = `claimed by <strong>${escapeHtml(claim.claimerName || "?")}</strong> &middot; ${tail}`;
    row.appendChild(badge);

    if (mine) {
      addBtn("Unclaim", "unclaim");
      addBtn(perma ? "Unpin" : "Pin", perma ? "unpin" : "pin");
    } else {
      addBtn("Steal", "steal", "steal");
    }
  } else {
    addBtn("Claim", "claim");
    addBtn("Pin", "pin");
  }
  row.appendChild(actions);
  return row;
}

async function onClaimAction(m, action) {
  if (!state.roomCode) return;
  if (!state.me) {
    try {
      await fetchMe();
    } catch (err) {
      showBanner(`Identity lookup failed: ${err.message}`);
      return;
    }
  }
  try {
    if (action === "claim") {
      await Claims.claim(m.id, state.me);
    } else if (action === "pin") {
      await Claims.claim(m.id, state.me, { permanent: true });
    } else if (action === "unpin") {
      await Claims.claim(m.id, state.me);
    } else if (action === "steal") {
      const existing = state.claims[String(m.id)];
      const note = existing?.permanent ? " (permaclaim)" : "";
      if (existing && !confirm(`Steal ${m.name} from ${existing.claimerName}${note}?`)) return;
      await Claims.claim(m.id, state.me);
    } else if (action === "unclaim") {
      await Claims.unclaim(m.id);
    }
  } catch (err) {
    showBanner(`Claim error: ${err.message}`);
  }
}

function attackLink(id) {
  const a = document.createElement("a");
  a.className = "attack";
  a.href = `https://www.torn.com/page.php?sid=attack&user2ID=${id}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "attack";
  return a;
}

function renderOnline(m) {
  const ageS = m.last_action?.timestamp ? nowS() - m.last_action.timestamp : 0;
  return memberRow(m, `<span class="state-online">Online</span> · ${fmtRelative(ageS)}`, attackLink(m.id));
}

function renderRecent(m) {
  const ageS = m.last_action?.timestamp ? nowS() - m.last_action.timestamp : 0;
  const status = m.last_action?.status || "Idle";
  return memberRow(m, `${status} · ${fmtRelative(ageS)}`, attackLink(m.id));
}

function renderHospital(m) {
  const until = m.status?.until || 0;
  const remaining = until - nowS();
  const desc = m.status?.description || "Hospital";
  const urgent = remaining > 0 && remaining <= HOSPITAL_ALERT_S;
  const left = `<span class="state-hospital">${escapeHtml(desc)}</span>`;
  const right = `<span class="countdown" data-until="${until}">${fmtCountdown(remaining)}</span>`;
  return memberRow(m, left, right, urgent ? "urgent" : "");
}

function renderHittable(m) {
  const ageS = m.last_action?.timestamp ? nowS() - m.last_action.timestamp : 0;
  const status = m.last_action?.status || "Offline";
  return memberRow(m, `${status} · ${fmtRelative(ageS)}`, attackLink(m.id));
}

function renderInactive(m) {
  const ageS = m.last_action?.timestamp ? nowS() - m.last_action.timestamp : 0;
  const s = m.status?.state || "";
  const cls = `state-${s.toLowerCase()}`;
  const left = `<span class="${cls}">${escapeHtml(s || "Offline")}</span> · ${fmtRelative(ageS)}`;
  return memberRow(m, left, "");
}

function renderAway(m) {
  const s = m.status?.state || "";
  const desc = m.status?.description || s;
  const cls = `state-${s.toLowerCase()}`;
  const until = m.status?.until || 0;
  const right = until ? `<span data-until="${until}">${fmtCountdown(until - nowS())}</span>` : "";
  return memberRow(m, `<span class="${cls}">${escapeHtml(desc)}</span>`, right);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Tick (countdowns + alerts + last updated) ----------

function tick() {
  document.querySelectorAll("[data-until]").forEach((node) => {
    const until = Number(node.dataset.until);
    if (!until) return;
    const remaining = until - nowS();
    node.textContent = fmtCountdown(remaining);
    const li = node.closest(".member");
    if (li && li.dataset.id) {
      const isHospitalPanel = li.parentElement?.id === "list-hospital";
      if (isHospitalPanel) {
        li.classList.toggle("urgent", remaining > 0 && remaining <= HOSPITAL_ALERT_S);
      }
    }
  });

  document.querySelectorAll("[data-claim-until]").forEach((node) => {
    const exp = Number(node.dataset.claimUntil);
    const remaining = Math.max(0, Math.floor((exp - Date.now()) / 1000));
    node.textContent = fmtCountdown(remaining);
  });

  const inHospital = state.members.filter((m) => m.status?.state === "Hospital");
  checkHospitalAlerts(inHospital);

  renderLastUpdated();
}

function renderLastUpdated() {
  if (!state.lastUpdated) {
    el.lastUpdated.textContent = "—";
    return;
  }
  const ageS = Math.max(0, Math.floor((Date.now() - state.lastUpdated) / 1000));
  el.lastUpdated.textContent = `updated ${fmtRelative(ageS)}`;
}

function checkHospitalAlerts(hospitalMembers) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const stillIn = new Set();
  for (const m of hospitalMembers) {
    const until = m.status?.until || 0;
    const remaining = until - nowS();
    stillIn.add(m.id);
    if (remaining > 0 && remaining <= HOSPITAL_ALERT_S && !state.alertedHospital.has(m.id)) {
      state.alertedHospital.add(m.id);
      new Notification(`${m.name} out in ${fmtCountdown(remaining)}`, {
        body: `Level ${m.level} · ${state.enemyFactionName}`,
        tag: `hospital-${m.id}`,
      });
    }
  }
  for (const id of state.alertedHospital) {
    if (!stillIn.has(id)) state.alertedHospital.delete(id);
  }
}

function setPollStatus(status) {
  el.pollDot.classList.remove("ok", "err");
  el.pollDot.classList.add(status);
  el.pollDot.classList.remove("pulse");
  void el.pollDot.offsetWidth;
  el.pollDot.classList.add("pulse");
}

function showBanner(msg) {
  el.banner.textContent = msg;
  el.banner.hidden = false;
}
function hideBanner() {
  el.banner.hidden = true;
}

// ---------- Setup UI ----------

function openSetup() {
  document.getElementById("api-key").value = state.apiKey;
  document.getElementById("ff-key").value = state.ffKey;
  document.getElementById("manual-total").value = state.manualTotal || "";
  el.setup.classList.add("visible");
  el.setupErr.hidden = true;
}
function closeSetup() {
  el.setup.classList.remove("visible");
}

document.getElementById("settings-btn").addEventListener("click", openSetup);

document.getElementById("save-settings").addEventListener("click", () => {
  const key = document.getElementById("api-key").value.trim();
  if (!key) {
    el.setupErr.textContent = "API key required.";
    el.setupErr.hidden = false;
    return;
  }
  const ffKey = document.getElementById("ff-key").value.trim();
  const manualTotal = Number(document.getElementById("manual-total").value) || 0;

  const apiChanged = key !== state.apiKey;
  state.apiKey = key;
  localStorage.setItem(LS_KEY, key);
  if (apiChanged) {
    state.ownFactionId = 0;
    localStorage.removeItem(LS_OWN);
    state.enemyFactionId = 0;
    Stats.setApiKey(key);
  }

  state.ffKey = ffKey;
  if (ffKey) localStorage.setItem(LS_FFKEY, ffKey);
  else localStorage.removeItem(LS_FFKEY);
  Stats.setFfKey(ffKey);

  state.manualTotal = manualTotal;
  if (manualTotal) {
    localStorage.setItem(LS_MANUAL_TOTAL, String(manualTotal));
    Stats.setManualTotal(manualTotal);
  } else {
    localStorage.removeItem(LS_MANUAL_TOTAL);
  }

  closeSetup();
  el.board.hidden = false;
  startPolling();
  Stats.refreshOwn(true).then(() => {
    renderOwnStatsLabel();
    renderBoard();
  });
});

function setManualEnemy(id) {
  state.manualEnemyId = id;
  if (id) localStorage.setItem(LS_ENEMY, String(id));
  else localStorage.removeItem(LS_ENEMY);
  state.enemyFactionId = 0;
  state.enemyFactionName = "";
  state.members = [];
  state.alertedHospital.clear();
  refreshWar();
}

function syncRoomMeta() {
  if (state.roomCode && state.enemyFactionId) {
    Claims.writeMeta(state.enemyFactionId, state.enemyFactionName);
  }
}

el.trackBtn.addEventListener("click", () => {
  const raw = el.trackInput.value.trim();
  const id = Number(raw);
  if (!id || !Number.isInteger(id) || id < 1) {
    showBanner("Enter a numeric faction ID.");
    return;
  }
  if (!state.apiKey) {
    openSetup();
    return;
  }
  hideBanner();
  setManualEnemy(id);
});

el.trackInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.trackBtn.click();
});

el.autoBtn.addEventListener("click", () => {
  setManualEnemy(0);
});

async function joinRoom(code) {
  if (!code) return;
  if (!state.apiKey) {
    openSetup();
    return;
  }
  try {
    await fetchMe();
  } catch (err) {
    showBanner(`Identity lookup failed: ${err.message}`);
    return;
  }
  try {
    Claims.join(code, (raw) => {
      state.claims = Claims.pruneExpired(raw);
      renderBoard();
    });
  } catch (err) {
    showBanner(`Room join failed: ${err.message}`);
    return;
  }
  state.roomCode = code;
  localStorage.setItem(LS_ROOM, code);
  renderRoomLabel();

  if (state.enemyFactionId) {
    Claims.writeMeta(state.enemyFactionId, state.enemyFactionName);
  } else {
    try {
      const meta = await Claims.readMeta();
      if (meta && meta.factionId) {
        state.manualEnemyId = meta.factionId;
        localStorage.setItem(LS_ENEMY, String(meta.factionId));
        state.enemyFactionId = meta.factionId;
        state.enemyFactionName = meta.factionName || `Faction ${meta.factionId}`;
        renderWarLabel();
        refreshMembers();
      }
    } catch (_) {}
  }
}

function leaveRoom() {
  Claims.leave();
  state.roomCode = "";
  state.claims = {};
  localStorage.removeItem(LS_ROOM);
  renderRoomLabel();
  renderBoard();
}

function renderRoomLabel() {
  if (state.roomCode) {
    el.roomLabel.textContent = `room: ${state.roomCode}`;
    el.roomLabel.hidden = false;
    el.roomInput.value = state.roomCode;
    el.roomInput.hidden = true;
    el.joinBtn.hidden = true;
    el.leaveBtn.hidden = false;
  } else {
    el.roomLabel.textContent = "";
    el.roomLabel.hidden = true;
    el.roomInput.hidden = false;
    el.joinBtn.hidden = false;
    el.leaveBtn.hidden = true;
  }
}

el.joinBtn.addEventListener("click", () => {
  const code = el.roomInput.value.trim();
  if (!code) {
    showBanner("Enter a room code.");
    return;
  }
  hideBanner();
  joinRoom(code);
});

el.roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.joinBtn.click();
});

el.leaveBtn.addEventListener("click", leaveRoom);

document.getElementById("clear-settings").addEventListener("click", () => {
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ENEMY);
  localStorage.removeItem(LS_OWN);
  localStorage.removeItem(LS_ME);
  localStorage.removeItem(LS_FFKEY);
  localStorage.removeItem(LS_MANUAL_TOTAL);
  state.apiKey = "";
  state.ffKey = "";
  state.manualTotal = 0;
  state.me = null;
  Stats.clearAll();
  renderOwnStatsLabel();
  leaveRoom();
  stopPolling();
  el.board.hidden = true;
  openSetup();
});

el.sortStatsBtn.addEventListener("click", () => {
  state.sortByStats = !state.sortByStats;
  if (state.sortByStats) localStorage.setItem(LS_SORT_STATS, "1");
  else localStorage.removeItem(LS_SORT_STATS);
  renderToggleStates();
  renderBoard();
});

el.hideOverBtn.addEventListener("click", () => {
  state.hideOverMe = !state.hideOverMe;
  if (state.hideOverMe) localStorage.setItem(LS_HIDE_OVER, "1");
  else localStorage.removeItem(LS_HIDE_OVER);
  renderToggleStates();
  renderBoard();
});

el.notifyBtn.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    showBanner("This browser doesn't support notifications.");
    return;
  }
  const result = await Notification.requestPermission();
  if (result === "granted") {
    el.notifyBtn.textContent = "Alerts on";
    el.notifyBtn.disabled = true;
  } else {
    showBanner("Notification permission denied.");
  }
});

["filter-min-level", "filter-max-level"].forEach((id) => {
  const input = document.getElementById(id);
  const key = id === "filter-min-level" ? "filterMinLvl" : "filterMaxLvl";
  const lsKey = id === "filter-min-level" ? LS_MIN_LVL : LS_MAX_LVL;
  if (state[key]) input.value = state[key];
  input.addEventListener("input", () => {
    const v = Number(input.value) || 0;
    state[key] = v;
    if (v) localStorage.setItem(lsKey, String(v));
    else localStorage.removeItem(lsKey);
    renderBoard();
  });
});

// ---------- Boot ----------

function boot() {
  if ("Notification" in window && Notification.permission === "granted") {
    el.notifyBtn.textContent = "Alerts on";
    el.notifyBtn.disabled = true;
  }
  Stats.init({
    apiKey: state.apiKey,
    ffKey: state.ffKey,
    manualTotal: state.manualTotal,
    isTransient,
  });
  renderToggleStates();
  renderOwnStatsLabel();
  renderRoomLabel();
  if (!state.apiKey) {
    openSetup();
    return;
  }
  el.board.hidden = false;
  startPolling();
  Stats.refreshOwn().then((r) => {
    renderOwnStatsLabel();
    if (r && r.total) renderBoard();
  });
  if (state.roomCode) {
    const saved = state.roomCode;
    state.roomCode = "";
    joinRoom(saved);
  }
}

boot();
