// v1.5.5 验证：复刻 GLaDOS PoW 挑战的签到流程
// 用 vm 加载真实 background.js，mock fetch/crypto.subtle/chrome，校验 challenge→proof→POST 链路。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const crypto = require("crypto");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

function makeChrome(store) {
  const get = (keys, cb) => {
    let out = {};
    if (Array.isArray(keys)) keys.forEach((k) => { if (k in store) out[k] = store[k]; });
    else if (typeof keys === "string") { if (keys in store) out[keys] = store[k]; }
    else if (keys && typeof keys === "object") {
      for (const k of Object.keys(keys)) out[k] = (k in store) ? store[k] : keys[k];
    } else out = Object.assign({}, store);
    if (cb) { cb(out); return undefined; }
    return Promise.resolve(out);
  };
  const set = (obj, cb) => { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); };
  const noop = () => {};
  const listeners = {};
  return {
    _store: store,
    storage: { local: { get, set } },
    alarms: { create: noop, clear: noop, onAlarm: { addListener: noop } },
    runtime: {
      onInstalled: { addListener: noop }, onStartup: { addListener: noop },
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      openOptionsPage: noop, sendMessage: async () => ({})
    },
    tabs: { query: async () => [], reload: async () => {}, create: async () => {} },
    notifications: { create: noop },
    declarativeNetRequest: { updateDynamicRules: noop },
    action: { onClicked: { addListener: noop } },
    _listeners: listeners
  };
}

function makeFetch(recorder) {
  return async (url, opts) => {
    if (url.includes("/checkin/challenge")) {
      return { ok: true, json: async () => ({ code: 0, nonce: "test-nonce-123" }) };
    }
    // checkin POST
    const body = JSON.parse(opts.body);
    recorder.push({ url, body });
    return { ok: true, json: async () => recorder.response || { code: 0, message: "ok +1" } };
  };
}

function loadBg({ store = {}, fetchRecorder = [], challengeResponse = { code: 0, nonce: "test-nonce-123" }, checkinResponse = { code: 0, message: "ok +1" } }) {
  const chrome = makeChrome(store);
  fetchRecorder.response = checkinResponse;
  const fetch = async (url, opts) => {
    if (url.includes("/checkin/challenge")) {
      return { ok: true, json: async () => challengeResponse };
    }
    const body = JSON.parse(opts.body);
    fetchRecorder.push({ url, body });
    return { ok: true, json: async () => checkinResponse };
  };
  const ctx = {
    chrome, fetch, console,
    crypto: require("crypto").webcrypto,
    TextEncoder, Date, Promise, setTimeout, clearTimeout
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), ctx);
  return { chrome, ctx, listeners: chrome._listeners };
}

(async () => {
  const expectedProof = crypto.createHash("sha256").update("test-nonce-123.glados-observer-v1").digest("hex");

  // --- S1: 完整链路 —— doCheckin(force) 触发 challenge→proof→POST，且写入签到日期 ---
  console.log("S1 完整签到链路（带 PoW 挑战）");
  {
    const store = {};
    const rec = [];
    const { listeners } = loadBg({ store, fetchRecorder: rec });
    const handler = listeners.message;
    await handler({ action: "doCheckin", source: "force" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 30)); // 等异步链落定
    ok(rec.length === 1, "发了 1 次签到 POST");
    const post = rec[0];
    ok(post.body.nonce === "test-nonce-123", "POST body 带 nonce", JSON.stringify(post && post.body));
    ok(post.body.proof === expectedProof, "POST proof == SHA256(nonce+salt)", post && post.body && post.body.proof);
    ok(post.body.token && typeof post.body.token === "string", "POST body 带 token(域名)");
    ok(store.lastCheckInDate === new Date().toISOString().slice(0, 10) ||
        /^\d{4}-\d{2}-\d{2}$/.test(store.lastCheckInDate), "code:0 → 写入 lastCheckInDate", store.lastCheckInDate);
  }

  // --- S2: challenge 缺失 nonce → 仍 POST 但 proof 为空串（不崩）---
  console.log("S2 challenge 异常容错");
  {
    const store = {};
    const rec = [];
    const { listeners } = loadBg({ store, fetchRecorder: rec, challengeResponse: { code: -1 } });
    const handler = listeners.message;
    await handler({ action: "doCheckin", source: "poor" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 30));
    ok(rec.length === 1, "仍发出签到 POST（不崩）");
    ok(rec[0].body.nonce === "" && rec[0].body.proof === "", "无 nonce 时 nonce/proof 为空串", JSON.stringify(rec[0].body));
  }

  // --- S3: device-mismatch 不应误标已签到 ---
  console.log("S3 device-mismatch 不误标");
  {
    const store = {};
    const rec = [];
    const { listeners } = loadBg({ store, fetchRecorder: rec, checkinResponse: { code: 4, reason: "device-mismatch", message: "请重新登录" } });
    const handler = listeners.message;
    await handler({ action: "doCheckin", source: "force" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 30));
    ok(!store.lastCheckInDate, "mismatch 时不写 lastCheckInDate", store.lastCheckInDate);
    ok(store.lastDeviceMismatch === new Date().toISOString().slice(0, 10), "记录 lastDeviceMismatch");
  }

  // --- S4: 今日已签 → doCheckin 不重复发请求 ---
  console.log("S4 幂等：今日已签不重复");
  {
    const today = new Date().toISOString().slice(0, 10);
    const store = { lastCheckInDate: today };
    const rec = [];
    const { listeners } = loadBg({ store, fetchRecorder: rec });
    const handler = listeners.message;
    await handler({ action: "doCheckin", source: "force" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    ok(rec.length === 0, "今日已签 → 不发 POST", "rec=" + rec.length);
  }

  // --- S5: 21:00 兜底（forceCheckInIfNeeded 经 iqiSampleAlarm 触发）经 doCheckin 等价路径 ---
  // doCheckin(source:force) 已是统一入口，S1 已覆盖；此处仅校验 poor 源也能成功写日期
  console.log("S5 poor 源签到写日期");
  {
    const store = {};
    const rec = [];
    const { listeners } = loadBg({ store, fetchRecorder: rec });
    const handler = listeners.message;
    await handler({ action: "doCheckin", source: "poor" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 30));
    ok(store.lastCheckInDate, "poor 源签到成功写日期");
    ok(rec[0].body.nonce && rec[0].body.proof, "poor 源也带 challenge 凭证");
  }

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})();
