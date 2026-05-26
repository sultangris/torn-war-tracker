// Battle-stat estimation: FFScouter API first, rank-band fallback.
// Exposed as window.Stats. Loaded before app.js.
(function () {
  const LS_OWN_STATS = "fwt.ownStats";

  const FF_ENDPOINT = "https://ffscouter.com/api/v1/get-stats";
  const FF_BATCH = 50;
  const FF_TTL_MS = 5 * 60 * 1000;
  const FF_OUTAGE_MS = 5 * 60 * 1000;
  const FF_TIMEOUT_MS = 10_000;

  // Torn rank-band minimums for total battle stats. Each entry's `min` is the
  // floor of that band; we look up the next band to derive an upper bound.
  // Ordered descending so the first match wins. Numbers are conservative and
  // commonly cited (Torn wiki / rank trigger threads); the bracketing matters
  // more than exact values.
  const RANK_BANDS = [
    { match: /absolute/i,       min: 5_000_000_000 },
    { match: /highly/i,         min: 2_500_000_000 },
    { match: /marked/i,         min: 1_000_000_000 },
    { match: /idolised|idolized/i, min: 500_000_000 },
    { match: /celebrated/i,     min: 250_000_000 },
    { match: /admired/i,        min: 100_000_000 },
    { match: /respected/i,      min: 50_000_000 },
    { match: /reputable/i,      min: 20_000_000 },
    { match: /distinguished/i,  min: 10_000_000 },
    { match: /established/i,    min: 5_000_000 },
    { match: /known/i,          min: 2_000_000 },
    { match: /average/i,        min: 1_000_000 },
    { match: /below average/i,  min: 500_000 },
    { match: /private/i,        min: 250_000 },
    { match: /beginner/i,       min: 0 },
  ];

  function bandFor(rankStr) {
    if (!rankStr) return null;
    for (let i = 0; i < RANK_BANDS.length; i++) {
      if (RANK_BANDS[i].match.test(rankStr)) {
        const lo = RANK_BANDS[i].min;
        const hi = i === 0 ? null : RANK_BANDS[i - 1].min;
        return { lo, hi, name: rankStr };
      }
    }
    return null;
  }

  function humanise(n) {
    if (n == null) return "?";
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "b";
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "m";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, "") + "k";
    return String(n);
  }

  function ratingFor(bs, own) {
    if (!own || bs == null) return "gray";
    const r = bs / own;
    if (r <= 0.85) return "green";
    if (r <= 1.15) return "yellow";
    return "red";
  }

  function ffRatingFor(ff) {
    if (ff == null) return "unknown";
    if (ff >= 3) return "easy";
    if (ff >= 1) return "even";
    return "hard";
  }

  function sameDay(tsA, tsB) {
    const a = new Date(tsA);
    const b = new Date(tsB);
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
  }

  const Stats = {
    apiKey: "",
    ffKey: "",
    ownTotal: 0,
    ownSource: null, // "api" | "manual" | null
    ownFetchedAt: 0,
    targetCache: new Map(),
    ffOutageUntil: 0,
    isTransient: () => false,

    init({ apiKey = "", ffKey = "", manualTotal = 0, isTransient } = {}) {
      Stats.apiKey = apiKey;
      Stats.ffKey = ffKey;
      if (typeof isTransient === "function") Stats.isTransient = isTransient;
      const saved = JSON.parse(localStorage.getItem(LS_OWN_STATS) || "null");
      if (saved && saved.total) {
        Stats.ownTotal = saved.total;
        Stats.ownSource = saved.source;
        Stats.ownFetchedAt = saved.fetchedAt;
      }
      if (manualTotal && manualTotal !== Stats.ownTotal) {
        Stats._writeOwn(manualTotal, "manual");
      }
    },

    setApiKey(k) {
      Stats.apiKey = k || "";
      if (Stats.ownSource === "api") {
        Stats.ownTotal = 0;
        Stats.ownSource = null;
        localStorage.removeItem(LS_OWN_STATS);
      }
    },

    setFfKey(k) {
      const next = k || "";
      if (next === Stats.ffKey) return;
      Stats.ffKey = next;
      Stats.targetCache.clear();
      Stats.ffOutageUntil = 0;
    },

    setManualTotal(n) {
      const v = Number(n) || 0;
      if (!v) return;
      Stats._writeOwn(v, "manual");
    },

    _writeOwn(total, source) {
      Stats.ownTotal = total;
      Stats.ownSource = source;
      Stats.ownFetchedAt = Date.now();
      localStorage.setItem(LS_OWN_STATS, JSON.stringify({
        total, source, fetchedAt: Stats.ownFetchedAt,
      }));
    },

    async refreshOwn(force = false) {
      if (Stats.ownSource === "manual" && !force) {
        return { total: Stats.ownTotal, source: "manual" };
      }
      const fresh = Stats.ownTotal &&
        Stats.ownFetchedAt &&
        sameDay(Stats.ownFetchedAt, Date.now());
      if (fresh && !force) return { total: Stats.ownTotal, source: "cached" };
      if (!Stats.apiKey) return { total: Stats.ownTotal, error: "no-key" };
      try {
        const url = `https://api.torn.com/user/?selections=battlestats&key=${encodeURIComponent(Stats.apiKey)}`;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), FF_TIMEOUT_MS);
        const res = await fetch(url, { signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) return { total: Stats.ownTotal, error: `http-${res.status}` };
        const data = await res.json();
        if (data && data.error) {
          if (data.error.code === 16 || data.error.code === 2) {
            return { total: Stats.ownTotal, error: "needs-manual" };
          }
          return { total: Stats.ownTotal, error: `api-${data.error.code}` };
        }
        const total = Number(data?.total) ||
          (Number(data?.strength) + Number(data?.defense) + Number(data?.speed) + Number(data?.dexterity));
        if (!total || !Number.isFinite(total)) {
          return { total: Stats.ownTotal, error: "no-total" };
        }
        Stats._writeOwn(total, "api");
        return { total, source: "api" };
      } catch (err) {
        return { total: Stats.ownTotal, error: err.message || "fetch-failed" };
      }
    },

    async refreshTargets(ids) {
      if (!Stats.ffKey) return { ok: false, error: "no-key", fetched: 0, cached: 0 };
      if (!Array.isArray(ids) || ids.length === 0) return { ok: true, fetched: 0, cached: 0 };
      if (Date.now() < Stats.ffOutageUntil) {
        return { ok: false, error: "outage", fetched: 0, cached: Stats.targetCache.size };
      }
      const now = Date.now();
      const stale = [];
      let cached = 0;
      for (const id of ids) {
        const row = Stats.targetCache.get(Number(id));
        if (row && now - row.fetchedAt < FF_TTL_MS) cached++;
        else stale.push(Number(id));
      }
      if (stale.length === 0) return { ok: true, fetched: 0, cached };
      let fetched = 0;
      for (let i = 0; i < stale.length; i += FF_BATCH) {
        const batch = stale.slice(i, i + FF_BATCH);
        const ok = await Stats._fetchBatch(batch);
        if (!ok) {
          Stats.ffOutageUntil = Date.now() + FF_OUTAGE_MS;
          return { ok: false, error: "fetch-failed", fetched, cached };
        }
        fetched += batch.length;
      }
      return { ok: true, fetched, cached };
    },

    async _fetchBatch(batch) {
      const url = `${FF_ENDPOINT}?key=${encodeURIComponent(Stats.ffKey)}&targets=${batch.join(",")}`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FF_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, { signal: ctl.signal });
      } catch (err) {
        clearTimeout(timer);
        console.warn("[Stats] FFScouter fetch failed:", err.message);
        return false;
      }
      clearTimeout(timer);
      if (!res.ok) {
        console.warn("[Stats] FFScouter HTTP", res.status);
        return false;
      }
      let data;
      try {
        data = await res.json();
      } catch (err) {
        console.warn("[Stats] FFScouter JSON parse failed:", err.message);
        return false;
      }
      // Response is an array (or { data: [...] } in some shapes). Normalise.
      const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
      if (!rows) {
        if (data && data.error) {
          console.warn("[Stats] FFScouter error:", data.error);
          return false;
        }
        console.warn("[Stats] FFScouter unexpected response shape", data);
        return false;
      }
      const fetchedAt = Date.now();
      for (const row of rows) {
        const id = Number(row.player_id);
        if (!id) continue;
        Stats.targetCache.set(id, {
          bs: row.bs_estimate != null ? Number(row.bs_estimate) : null,
          bsHuman: row.bs_estimate_human || (row.bs_estimate != null ? humanise(Number(row.bs_estimate)) : null),
          ff: row.fair_fight != null ? Number(row.fair_fight) : null,
          lastUpdated: row.last_updated || 0,
          fetchedAt,
        });
      }
      // Also stamp ids we asked about but got no row for, so we don't re-fetch
      // them every poll. Empty rows fall back to rank.
      for (const id of batch) {
        if (!Stats.targetCache.has(id)) {
          Stats.targetCache.set(id, { bs: null, bsHuman: null, ff: null, lastUpdated: 0, fetchedAt });
        }
      }
      return true;
    },

    getEstimate(member) {
      const id = Number(member?.id);
      const cached = id ? Stats.targetCache.get(id) : null;
      if (cached && cached.bs != null) {
        return {
          bs: cached.bs,
          bsHuman: cached.bsHuman || humanise(cached.bs),
          ff: cached.ff,
          lastUpdated: cached.lastUpdated,
          source: "ffscouter",
          rating: ratingFor(cached.bs, Stats.ownTotal),
          ffRating: ffRatingFor(cached.ff),
        };
      }
      const band = bandFor(member?.rank);
      if (band) {
        const label = band.hi
          ? `${humanise(band.lo)}–${humanise(band.hi)}`
          : `≥${humanise(band.lo)}`;
        return {
          bs: band.lo,
          bsHuman: label,
          ff: null,
          lastUpdated: 0,
          source: "rank",
          // Rank fallback uses the band minimum, so we deliberately don't paint
          // green/yellow/red — too easy to mislead. Always gray.
          rating: "gray",
          ffRating: "unknown",
        };
      }
      return {
        bs: null, bsHuman: "?", ff: null, lastUpdated: 0,
        source: "unknown", rating: "gray", ffRating: "unknown",
      };
    },

    clearAll() {
      Stats.targetCache.clear();
      Stats.ffOutageUntil = 0;
      Stats.ownTotal = 0;
      Stats.ownSource = null;
      Stats.ownFetchedAt = 0;
      Stats.ffKey = "";
      localStorage.removeItem(LS_OWN_STATS);
    },
  };

  window.Stats = Stats;
})();
