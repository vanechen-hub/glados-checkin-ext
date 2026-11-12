// 验证 v1.5.3：兜底窗口由 23:55–23:59（5分钟）扩大为 21:00–23:59（3小时）
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

function makeHarness({ iqiLevel = "good", lastCheckInDate = "", fixedDate }) {
  const store = { lastCheckInDate, iqiSamples: [], activeDomain: "glados-facility.com", lastDomainScan: 0 };
  const checkinCalls = [];
  const captured = {};

  const get = (keys, cb) => {
    let out = {};
    if (Array.isArray(keys)) keys.forEach((k) => { if (k in store) out[k] = store[k]; });
    else if (typeof keys === "string") { if (keys in store) out[keys] = store[keys]; }
    else if (keys && typeof keys === "object") {
      for (const k of Object.keys(keys)) out[k] = (k in store) ? store[k] : keys[k];
    } else out = Object.assign({}, store);
    if (cb) { cb(out); return undefined; }
    return Promise.resolve(out);
  };
  const set = (obj, cb) => { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); };

  const fetchMock = async (url, opts) => {
    if (typeof url === "string" && url.includes("/api/user/iqi")) {
      // v1.5.6 起 score<85 会触发加成档签到；这里模拟「网络良好」必须用高分，否则 S14 会被新逻辑正确地签到。
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { quality: { level: iqiLevel, score: 97 } } }) };
    }
    if (typeof url === "string" && url.includes("/api/user/checkin")) {
      checkinCalls.push({ url, method: (opts && opts.method) || "POST" });
      return { ok: true, status: 200, json: async () => ({ code: 0, message: "checkin ok" }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const chrome = {
    _store: store,
    storage: { local: { get, set } },
    alarms: {
      create: (name, spec) => { captured["alarm:" + name] = spec; },
      clear: () => {},
      onAlarm: { addListener: (fn) => { captured.onAlarm = fn; } }
    },
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      openOptionsPage: () => {},
      sendMessage: async () => ({})
    },
    tabs: { query: async () => [], reload: async () => {}, create: async () => {} },
    notifications: { create: () => {} },
    declarativeNetRequest: { updateDynamicRules: () => {} },
    action: { onClicked: { addListener: () => {} } }
  };

  class FixedDate extends Date {
    constructor(...a) { if (a.length) { super(...a); } else { super(fixedDate.getTime()); } }
    static now() { return fixedDate.getTime(); }
  }

  const sandbox = {
    chrome, fetch: fetchMock, console,
    Date: FixedDate, setTimeout: () => {}, setInterval: () => {},
    Math, JSON, Promise, Object, Array, String, Number
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  return {
    store, checkinCalls, captured, sandbox,
    fireAlarm: (name) => captured.onAlarm({ name })
  };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

// 用真实源码里的 isPastForceTime 做边界断言
function pastForceAt(h, m) {
  const h2 = makeHarness({ fixedDate: new Date(2026, 7, 30, h, m, 0) });
  return h2.sandbox.isPastForceTime();
}

(async () => {
  console.log("=== S11: 兜底窗口边界（真实 isPastForceTime）===");
  ok(pastForceAt(20, 59) === false, "20:59 → 未进窗口，不签");
  ok(pastForceAt(21, 0) === true,  "21:00 → 进入窗口");
  ok(pastForceAt(22, 0) === true,  "22:00 → 在窗口内");
  ok(pastForceAt(23, 58) === true, "23:58 → 在窗口内");
  ok(pastForceAt(23, 59) === true, "23:59 → 仍在窗口内");
  ok(pastForceAt(0, 5) === false,  "00:05 → 已跨午夜，当天窗口结束（第二天重新开始）");

  console.log("=== S12: 窗口内采样闹钟 → 强制签到 ===");
  {
    const h = makeHarness({ lastCheckInDate: "", fixedDate: new Date(2026, 7, 30, 21, 30, 0) });
    await h.fireAlarm("iqiSampleAlarm");
    await settle();
    ok(h.checkinCalls.length >= 1, "21:30 采样闹钟触发强制签到 POST", "calls=" + h.checkinCalls.length);
    ok(h.store.lastCheckInDate === "2026-08-30", "写入 lastCheckInDate", String(h.store.lastCheckInDate));
    ok(h.store.lastForceAttemptDate === "2026-08-30", "记录 lastForceAttemptDate（可区分「没跑」vs「跑了失败」）",
      String(h.store.lastForceAttemptDate));
  }

  console.log("=== S13: 22:00 / 23:58 同样命中（旧版只有 23:55–23:59）===");
  for (const [hh, mm] of [[22, 0], [23, 58]]) {
    const h = makeHarness({ lastCheckInDate: "", fixedDate: new Date(2026, 7, 30, hh, mm, 0) });
    await h.fireAlarm("iqiSampleAlarm");
    await settle();
    ok(h.checkinCalls.length >= 1, `${hh}:${String(mm).padStart(2, "0")} 触发强制签到`, "calls=" + h.checkinCalls.length);
  }

  console.log("=== S14: 窗口外不误签 ===");
  {
    const h = makeHarness({ lastCheckInDate: "", fixedDate: new Date(2026, 7, 30, 20, 30, 0) });
    await h.fireAlarm("iqiSampleAlarm");
    await settle();
    ok(h.checkinCalls.length === 0, "20:30 网络良好 → 不签到", "calls=" + h.checkinCalls.length);
  }
  {
    const h = makeHarness({ lastCheckInDate: "", fixedDate: new Date(2026, 7, 30, 0, 5, 0) });
    await h.fireAlarm("iqiSampleAlarm");
    await settle();
    ok(h.checkinCalls.length === 0, "00:05 → 不签到（当天已过，等第二天窗口）", "calls=" + h.checkinCalls.length);
  }

  console.log("=== S15: 幂等（窗口内多次触发只签一次）===");
  {
    const h = makeHarness({ lastCheckInDate: "2026-08-30", fixedDate: new Date(2026, 7, 30, 22, 0, 0) });
    await h.fireAlarm("iqiSampleAlarm");
    await settle();
    ok(h.checkinCalls.length === 0, "今日已签 → 不再重复 POST", "calls=" + h.checkinCalls.length);
  }

  console.log("=== S16: forceCheckInAlarm 专闹钟仍生效（双保险）===");
  {
    const h = makeHarness({ lastCheckInDate: "", fixedDate: new Date(2026, 7, 30, 21, 0, 0) });
    await h.fireAlarm("forceCheckInAlarm");
    await settle();
    ok(h.checkinCalls.length >= 1, "forceCheckInAlarm 触发签到", "calls=" + h.checkinCalls.length);
    ok(h.captured["alarm:forceCheckInAlarm"] && h.captured["alarm:forceCheckInAlarm"].periodInMinutes === 1440,
      "触发后按天重设闹钟");
  }

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})();
