// GLaDOS 签到助手 - content script (v1.5.0)
// 作用域：全部 GLaDOS 域名的 /console/checkin（见 manifest.content_scripts.matches）
// 功能：
//   1) 每 5 分钟采样一次服务器网络质量(IQI)，交给 background 落盘，形成可分析的时间序列；
//   2) 采样到加成档（score < 85 / level=poor）且今日未签 → 交给 background 调 API 签到；
//   3) 兜底——当天 21:00 仍未签到，则无视网络等级强制点击；
//   4) 右下角徽标展示当前等级/分数、距上次变化时长、累计采样数。
// 说明：服务工作者(service worker)无法操作 DOM，因此由本脚本在页面内完成点击。
//
// v1.5.0 变更：轮询 10s → 5min；签到成功后**不再停止轮询**（全天持续采样，否则白天没有数据可分析）；
//              采样统一交由 background 单点写入，避免两边并发覆盖同一份数组。

const POLL_INTERVAL = 5 * 60 * 1000; // 每 5 分钟采样一次

// 兜底：当天到达该时刻仍未签到，则无视网络等级强制签到（与 background.js 保持一致）
const FORCE_HOUR = 21;
const FORCE_MINUTE = 0;

// 与 background.js 保持一致：加成档 score<85（+5/+8），而非只认 Poor(+8)。
// 页面 Cable +N 用的是打开页那一刻缓存的 iqi.score；这里每 5 分钟 no-store 重取，更贴近实时。
const BONUS_SCORE_MAX = 85;

function isBonusLevel(q) {
  if ((q.level || "").toLowerCase() === "poor") return true;
  const s = Number(q.score);
  return Number.isFinite(s) && s > 0 && s < BONUS_SCORE_MAX;
}

function isPastForceTime() {
  const n = new Date();
  return n.getHours() > FORCE_HOUR ||
         (n.getHours() === FORCE_HOUR && n.getMinutes() >= FORCE_MINUTE);
}

const QUALITY_COLORS = {
  excellent: "#21ba45",
  good:      "#2185d0",
  fair:      "#fbbd08",
  poor:      "#f2711c",
  critical:  "#db2828",
  unknown:   "#888888"
};

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function ago(ts) {
  if (!ts) return "—";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + "分钟";
  const h = Math.floor(m / 60);
  return h + "小时" + (m % 60) + "分";
}

// ---- 状态徽标 ----
function injectBadge() {
  if (document.getElementById("glados-helper-badge")) return;
  const badge = document.createElement("div");
  badge.id = "glados-helper-badge";
  badge.textContent = "GLaDOS 助手：启动中…";
  (document.body || document.documentElement).appendChild(badge);
}

function setBadge(text, color) {
  const badge = document.getElementById("glados-helper-badge");
  if (!badge) return;
  badge.textContent = text;
  if (color) badge.style.borderColor = color;
}

function renderBadge(q, info, done) {
  const parts = [];
  if (done) parts.push("今日已签 ✓");
  if (q.level) {
    const s = (q.score === null || q.score === undefined) ? "" : " " + q.score;
    parts.push(q.level + s);
    parts.push("变化于 " + ago(info && info.lastChange) + "前");
  } else {
    parts.push("读取失败（" + (q.reason || "未知") + "）");
  }
  parts.push("采样 " + ((info && info.total) || 0));

  const lvlKey = (q.level || "").toLowerCase();
  const color = done
    ? QUALITY_COLORS.excellent
    : (q.level ? (QUALITY_COLORS[lvlKey] || QUALITY_COLORS.unknown) : QUALITY_COLORS.critical);
  setBadge("GLaDOS " + parts.join(" · "), color);
}

// ---- 是否已今日签到 ----
async function alreadyCheckedInToday() {
  try {
    const data = await chrome.storage.local.get(["lastCheckInDate"]);
    if (data.lastCheckInDate === todayStr()) return true;
  } catch (e) { /* ignore */ }
  const btn = document.querySelector("button.checkin-cute-btn");
  if (btn && (btn.classList.contains("is-done") || btn.disabled)) return true;
  return false;
}

// ---- 获取 IQI 网络质量 ----
// 注意：页面 axios 实例设置了 baseURL="/api"，页面里写 get("/user/iqi") 实际请求 /api/user/iqi。
// 本脚本用原生 fetch，必须自己带上 /api 前缀，否则命中 404 HTML 页面导致 json() 抛异常。
const IQI_ENDPOINT = "/api/user/iqi";

async function getQuality() {
  try {
    // cache-busting + no-store：确保读到的是服务端当下的值，而不是任何一层缓存
    const resp = await fetch(`${IQI_ENDPOINT}?_=${Date.now()}`, {
      credentials: "include",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    if (!resp.ok) {
      console.warn("GLaDOS 助手：IQI HTTP 异常", resp.status);
      return { level: null, reason: "HTTP " + resp.status };
    }
    const json = await resp.json();
    // 响应体：{ code: 0, data: { quality: { level, score }, ... } }
    if (json && json.code === 0 && json.data && json.data.quality) {
      return { level: json.data.quality.level, score: json.data.quality.score };
    }
    // code === -2 表示未登录/没有权限
    if (json && json.code === -2) return { level: null, reason: "未登录" };
    return { level: null, reason: (json && json.message) || "响应格式异常" };
  } catch (e) {
    console.warn("GLaDOS 助手：获取 IQI 失败", e);
    return { level: null, reason: "请求失败" };
  }
}

// 交给 background 单点落盘；失败样本同样上报，保证时间序列里的空档可解释
async function reportSample(q) {
  try {
    return await chrome.runtime.sendMessage({
      action: "iqiSample",
      sample: {
        t: Date.now(),
        src: "page",
        host: location.hostname,
        l: q.level ? q.level.toLowerCase() : null,
        s: (q.score === undefined || q.score === null) ? null : q.score,
        e: q.level ? null : q.reason
      }
    });
  } catch (e) {
    console.warn("GLaDOS 助手：上报采样失败", e);
    return null;
  }
}

// ---- 触发签到（统一交给 background 调 API，带 PoW 挑战）----
// 不再直接点击页面按钮：GLaDOS 改版后按钮类名变为 .ckb 且签到需先解 PoW 挑战，
// 由 background 的 performFetch 直接复刻挑战流程最可靠，且不依赖签到页是否打开。
const SOURCE_LABEL = { poor: "Poor 网络", force: "21:00 强制" };

async function performCheckinClick(source) {
  const label = SOURCE_LABEL[source] || source;
  setBadge(`GLaDOS 助手：${label} → 后台 API 签到`, QUALITY_COLORS.poor);
  try {
    await chrome.runtime.sendMessage({ action: "doCheckin", source });
  } catch (e) { /* ignore */ }
  return false; // 下轮 loop 通过 alreadyCheckedInToday 确认结果
}

async function loop() {
  // 1) 先采样。无论今天签没签到都要采，否则白天没有数据可用于分析最佳时机。
  const q = await getQuality();
  const info = await reportSample(q);

  // 2) 再决定要不要签
  let done = await alreadyCheckedInToday();
  if (!done) {
    // 兜底刻意放在“读取失败”之前：即使 IQI 偶发读不到，到点也必须尝试签，不能被读取失败挡住
    if (isPastForceTime()) {
      setBadge("GLaDOS 助手：已过 21:00 未签 → 强制签到", QUALITY_COLORS.poor);
      done = await performCheckinClick("force");
    } else if (isBonusLevel(q)) {
      setBadge(`GLaDOS 助手：加成档 score=${q.score} → 后台 API 签到`, QUALITY_COLORS.poor);
      done = await performCheckinClick("poor");
    }
  }

  renderBadge(q, info, done);
  scheduleNext(); // 永不停止：签到只是副业，采样要跑满全天
}

function scheduleNext() {
  setTimeout(loop, POLL_INTERVAL);
}

// 后台告知：设备不匹配 / 会话失效 → 徽标明确提示人工重登（GLaDOS 新页面引入的拦截，自动化无法越过）
chrome.runtime.onMessage.addListener((request) => {
  if (request && request.action === "deviceMismatch") {
    setBadge("GLaDOS 助手：⚠ 设备不匹配/会话失效，请重新登录 GLaDOS", QUALITY_COLORS.critical);
  }
});

// ---- 启动 ----
injectBadge();
loop();
