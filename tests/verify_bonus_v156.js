// 验证 v1.5.6：触发阈值从「仅 Poor(+8)」放宽到「加成档 score<85(+5/+8)」
// 以及历史同时记录「触发 score」与「服务端实发 points」。
// 用 vm 加载真实 background.js / content.js，mock chrome / fetch / DOM。
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BG = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const CT = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  [" + extra + "]" : "")); }
}
const settle = () => new Promise((r) => setTimeout(r, 40));

function makeBg({ level = "fair", score = 88, points = 5, already = "" } = {}) {
  const store = {
    lastCheckInDate: already, iqiSamples: [], activeDomain: "glados-facility.com",
    history: [], lastDomainScan: Date.now()
  };
  const calls = { posts: [], iqi: 0, history: store.history };
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
      sendMessage: async () => ({})
    },
    tabs: { query: async () => [], reload: async () => {}, create: async () => {} },
    notifications: { create: () => {} },
    declarativeNetRequest: { updateDynamicRules: () => {} },
    action: { onClicked: { addListener: () => {} } }
  };
  const fetchMock = async (url, opt) => {
    if (url.includes("/api/user/iqi")) {
      calls.iqi++;
      return { ok: true, json: async () => ({ code: 0, data: { quality: { level, score } } }) };
    }
    if (url.includes("/checkin/challenge")) {
      return { ok: true, json: async () => ({ code: 0, nonce: "n1" }) };
    }
    if (url.includes("/api/user/checkin")) {
      calls.posts.push({ url, body: JSON.parse(opt.body) });
      return { ok: true, json: async () => ({ code: 0, message: "checkin ok", points }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const sandbox = {
    chrome, fetch: fetchMock, console, Date, Math, JSON, Promise, Object, Array, String, Number,
    setTimeout: () => {}, setInterval: () => {},
    TextEncoder,
    crypto: { subtle: { digest: async () => new ArrayBuffer(32) } }
  };
  vm.createContext(sandbox);
  vm.runInContext(BG, sandbox);
  return { store, calls, sandbox };
}

function makeContent() {
  const badge = { textContent: "", style: {}, id: "glados-helper-badge" };
  const document = {
    getElementById: (id) => (id === "glados-helper-badge" ? badge : null),
    createElement: () => ({ id: "", textContent: "", style: {} }),
    body: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
    querySelector: () => null
  };
  const sandbox = {
    chrome: {
      storage: { local: { get: async () => ({}), set: () => {} } },
      runtime: { sendMessage: async () => ({}), onMessage: { addListener: () => {} } }
    },
    fetch: async () => ({ ok: true, json: async () => ({ code: 0, data: { quality: { level: "good", score: 97 } } }) }),
    document, location: { hostname: "glados-facility.com" },
    console, Date, Math, JSON, Promise, Object, Array, String, Number,
    setTimeout: () => {}, setInterval: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(CT, sandbox);
  return sandbox;
}

(async () => {
  console.log("=== S1: background isBonusLevel 阈值边界 ===");
  {
    const s = makeBg().sandbox;
    const cases = [
      [{ level: "poor", score: null }, true, "level=poor（无 score）仍触发"],
      [{ level: "Poor", score: null }, true, "大写 Poor 仍触发（兼容 v1.5.1）"],
      [{ level: "fair", score: 79 }, true, "score=79（+8 档）"],
      [{ level: "fair", score: 82 }, true, "score=82（+5 档）← 今天这种情况"],
      [{ level: "fair", score: "82" }, true, "score 为字符串 '82' 也能触发"],
      [{ level: "fair", score: 84.9 }, true, "score=84.9 边界内"],
      [{ level: "fair", score: 85 }, false, "score=85 正好在档位外"],
      [{ level: "good", score: 88 }, false, "score=88（+3 档）不触发"],
      [{ level: "good", score: 97 }, false, "score=97（+1 档）不触发"],
      [{ level: "fair", score: null }, false, "score 缺失且非 poor 不误触发"],
      [{ level: null, score: 0 }, false, "score=0（异常值）不误触发"],
      [{ level: null, score: undefined }, false, "score 为 undefined 不误触发"]
    ];
    for (const [q, want, name] of cases) ok(s.isBonusLevel(q) === want, name);
  }

  console.log("=== S2: content.js 阈值与 background 一致 ===");
  {
    const s = makeContent();
    ok(s.isBonusLevel({ level: "fair", score: 82 }) === true, "页面侧 score=82 也判定为加成档");
    ok(s.isBonusLevel({ level: "good", score: 88 }) === false, "页面侧 score=88 不触发");
    ok(s.isBonusLevel({ level: "Poor", score: null }) === true, "页面侧大写 Poor 仍触发");
  }

  console.log("=== S3: 端到端——score=82 时自动签到（旧版会空转到 21:00）===");
  {
    const h = makeBg({ level: "fair", score: 82, points: 5 });
    await h.sandbox.sampleIQI("install");
    await settle();
    ok(h.calls.posts.length === 1, "触发 1 次签到 POST", "实际 " + h.calls.posts.length);
    ok(h.calls.posts[0] && h.calls.posts[0].body.nonce === "n1", "POST 仍带 PoW nonce（未破坏 v1.5.5）");
    ok(h.store.lastCheckInDate !== "", "成功后写入 lastCheckInDate");
    const hist = (h.store.history[0] || {}).result || "";
    ok(hist.includes("触发score=82"), "历史记录含触发 score", hist);
    ok(hist.includes("实发5分"), "历史记录含服务端实发 points", hist);
    ok(h.store.iqiSamples[0].s === 82, "采样落盘保留 score");
  }

  console.log("=== S4: score=88 不签到（避免好网络时白白签掉）===");
  {
    const h = makeBg({ level: "good", score: 88 });
    await h.sandbox.sampleIQI("install");
    await settle();
    ok(h.calls.posts.length === 0, "无签到 POST", "实际 " + h.calls.posts.length);
    ok(h.store.iqiSamples.length === 1, "采样仍然落盘（全天持续采样不受影响）");
  }

  console.log("=== S5: 幂等与兼容 ===");
  {
    const today = makeBg().sandbox.todayStr();
    const h = makeBg({ level: "fair", score: 82, already: today });
    await h.sandbox.sampleIQI("install");
    await settle();
    ok(h.calls.posts.length === 0, "今日已签 → 加成档不重复签");
  }
  {
    const h = makeBg({ level: "Poor", score: null });
    await h.sandbox.sampleIQI("install");
    await settle();
    ok(h.calls.posts.length === 1, "大写 Poor 且无 score → 仍能签到", "实际 " + h.calls.posts.length);
  }

  console.log("=== S6: 历史记录对无 points 的响应保持干净 ===");
  {
    const h = makeBg();
    h.sandbox.handleCheckinResult("2026-11-12", "ok", "force", { code: 0, message: "ok" });
    await settle();
    const hist = (h.store.history[0] || {}).result || "";
    ok(!hist.includes("实发") && !hist.includes("触发score"), "无 points/score 时不追加空标记", hist);
  }

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})();
