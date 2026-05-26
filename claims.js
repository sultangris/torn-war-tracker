(function () {
  const CLAIM_TTL_MS = 15 * 60 * 1000;

  let app = null;
  let db = null;
  let roomRef = null;
  let unsub = null;
  let currentRoom = "";

  function init() {
    if (app) return true;
    if (typeof firebase === "undefined" || !window.firebaseConfig) return false;
    app = firebase.initializeApp(window.firebaseConfig);
    db = firebase.database();
    return true;
  }

  function join(roomCode, onUpdate) {
    if (!init()) throw new Error("Firebase not loaded");
    leave();
    currentRoom = roomCode;
    roomRef = db.ref(`rooms/${roomCode}/claims`);
    const handler = (snap) => {
      const raw = snap.val() || {};
      onUpdate(raw);
    };
    roomRef.on("value", handler);
    unsub = () => roomRef.off("value", handler);
  }

  function leave() {
    if (unsub) unsub();
    unsub = null;
    roomRef = null;
    currentRoom = "";
  }

  function writeMeta(factionId, factionName) {
    if (!db || !currentRoom) return;
    db.ref(`rooms/${currentRoom}/meta`).set({ factionId, factionName });
  }

  function readMeta() {
    if (!db || !currentRoom) return Promise.resolve(null);
    return db.ref(`rooms/${currentRoom}/meta`).get().then((snap) => snap.val());
  }

  function claim(targetId, claimer, opts = {}) {
    if (!roomRef) throw new Error("Not in a room");
    const now = Date.now();
    const record = {
      claimerId: claimer.id,
      claimerName: claimer.name,
      claimedAt: now,
    };
    if (opts.permanent) {
      record.permanent = true;
    } else {
      record.expiresAt = now + CLAIM_TTL_MS;
    }
    return roomRef.child(String(targetId)).set(record);
  }

  function unclaim(targetId) {
    if (!roomRef) throw new Error("Not in a room");
    return roomRef.child(String(targetId)).remove();
  }

  function pruneExpired(claims) {
    const now = Date.now();
    const out = {};
    const stale = [];
    for (const [id, c] of Object.entries(claims)) {
      if (!c) continue;
      if (c.permanent) {
        out[id] = c;
        continue;
      }
      if (typeof c.expiresAt === "number" && c.expiresAt > now) {
        out[id] = c;
      } else {
        stale.push(id);
      }
    }
    if (stale.length && roomRef) {
      const updates = {};
      for (const id of stale) updates[id] = null;
      roomRef.update(updates).catch(() => {});
    }
    return out;
  }

  window.Claims = {
    init,
    join,
    leave,
    writeMeta,
    readMeta,
    claim,
    unclaim,
    pruneExpired,
    get room() {
      return currentRoom;
    },
    TTL_MS: CLAIM_TTL_MS,
  };
})();
