// 验证 v1.5.4：handleCheckinResult 的成功判定修复 + device-mismatch 处理
// 用 vm 加载真实 background.js，mock chrome / fetch / Date。
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = path.join(__dirname, "..", "background.js");
const code = fs.readFileSync(SRC, "utf8");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  [" + extra + "]" : "")); }
}

function makeHarness() {
  const store = { lastCheckInDate: "", iqiSamples: [], activeDomain: "glados-facility.com" };
  const captured = { notifications: [], messages: [] };

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

  const chrome = {
    _store: store,
    storage: { local: { get, set } },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
    runtime: {
      onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} }, openOptionsPage: () => {},
      sendMessage: async (m) => { captured.messages.push(m); return {}; }
    },
    tabs: { query: async () => [], reload: async () => {}, create: async () => {} },
    notifications: { create: (n) => { captured.notifications.push(n); } },
    declarativeNetRequest: { updateDynamicRules: () => {} },
    action: { onClicked: { addListener: () => {} } }
  };

  const sandbox = {
    chrome, fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    console, Date, setTimeout: () => {}, setInterval: () => {},
    Math, JSON, Promise, Object, Array, String, Number
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  return { store, captured, sandbox };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const TODAY = "2026-11-03";

(async () => {
  console.log("=== S21: 成功（code=0）→ 写日期 + 清 mismatch ===");
  {
    const h = makeHarness();
    h.sandbox.handleCheckinResult(TODAY, "checkin ok +1 day", "force", { code: 0, message: "checkin ok" });
    await settle();
    ok(h.store.lastCheckInDate === TODAY, "lastCheckInDate 写入", String(h.store.lastCheckInDate));
    ok(h.store.lastDeviceMismatch === "", "lastDeviceMismatch 清空");
  }

  console.log("=== S22: 关键回归——含 'get' 的错误提示不再误判成功 ===");
  {
    // 旧版 msgLower.includes('get') 会把这条误当成功 → 当天静默断签
    const h = makeHarness();
    h.sandbox.handleCheckinResult(TODAY, "network error, please get a new token", "force",
      { code: -1, message: "network error, please get a new token" });
    await settle();
    ok(h.store.lastCheckInDate !== TODAY, "含 get 的失败提示 → 不写 lastCheckInDate（保留重试机会）",
      String(h.store.lastCheckInDate));
  }

  console.log("=== S23: device-mismatch（code=4）→ 不写日期 + 记标记 + 通知徽标 ===");
  {
    const h = makeHarness();
    h.sandbox.handleCheckinResult(TODAY, "device mismatch detected", "force",
      { code: 4, reason: "device-mismatch", message: "device mismatch" });
    await settle();
    ok(h.store.lastCheckInDate !== TODAY, "mismatch → 不写 lastCheckInDate", String(h.store.lastCheckInDate));
    ok(h.store.lastDeviceMismatch === TODAY, "记录 lastDeviceMismatch", String(h.store.lastDeviceMismatch));
    ok(capturedHas(h, "deviceMismatch"), "向 content 发送 deviceMismatch 消息（徽标提示）");
  }

  console.log("=== S24: 已签到（非 0 码但明确告知）→ 视为完成，写日期停止重试 ===");
  {
    const h = makeHarness();
    h.sandbox.handleCheckinResult(TODAY, "今天已经签到过了", "force",
      { code: -1, message: "今天已经签到过了" });
    await settle();
    ok(h.store.lastCheckInDate === TODAY, "已签过 → 写日期，避免反复重试", String(h.store.lastCheckInDate));
  }

  console.log("=== S25: 纯网络失败（无 result）→ 不写日期、不误判 mismatch ===");
  {
    const h = makeHarness();
    h.sandbox.handleCheckinResult(TODAY, "网络连接失败", "force", null);
    await settle();
    ok(h.store.lastCheckInDate !== TODAY, "网络失败 → 不写日期", String(h.store.lastCheckInDate));
    ok(h.store.lastDeviceMismatch !== TODAY, "网络失败 → 不记 mismatch", String(h.store.lastDeviceMismatch));
  }

  console.log("=== S26: 手动测试 → 绝不写日期（不污染真实判定）===");
  {
    const h = makeHarness();
    h.sandbox.handleCheckinResult(TODAY, "ok", "manual", { code: 0, message: "ok" });
    await settle();
    ok(h.store.lastCheckInDate !== TODAY, "manual → 不写 lastCheckInDate", String(h.store.lastCheckInDate));
  }

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})();

function capturedHas(h, action) {
  return h.captured.messages.some((m) => m && m.action === action);
}
