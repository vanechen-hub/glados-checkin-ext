// GLaDOS 签到助手 - background service worker (v1.5.0)
// 职责：
//   1) 每 5 分钟采样一次网络质量(IQI)并落盘，形成可分析的时间序列（用于找“一天中的好时机”）；
//   2) 采样到加成档（score < 85 / level=poor）且今日未签 → 直接调 API 签到；
//   3) 每天 21:00 兜底：今日仍未签则刷新签到页 + 直接调 API，双保险防漏签；
//   4) 统一写入采样与签到历史（单点写者，避免与 content script 争抢同一份数组）。
//
// v1.5.0 变更：
//   - 取消每小时刷新签到页；全天只在 21:00 兜底时刷新一次。
//   - 采样改由 service worker 的闹钟驱动，不再依赖签到页标签存在（标签被关/被 Chrome 丢弃也照采）。
//   - 全部 GLaDOS 域名通配，并自动识别当前登录的是哪个域名。

// 实测存活的 GLaDOS 域名（/console/checkin 返回 200 且 /api/user/iqi 返回 JSON）
const DOMAINS = [
  "glados-facility.com",
  "glados.cloud",
  "glados.rocks",
  "glados.space",
  "glados.one",
  "glados.network"
];
const DEFAULT_DOMAIN = DOMAINS[0];

// 标签页匹配模式：通配子域名 + 通配 query string（?xxx 也能匹配到已有标签，避免重复开标签堆积）
const TAB_PATTERNS = DOMAINS.map((d) => `https://*.${d}/console/checkin*`);

const SAMPLE_PERIOD_MIN = 5;              // 采样周期：5 分钟
const PAGE_FRESH_MS = 4 * 60 * 1000;      // 4 分钟内已有样本 → 认为签到页正在采，后台让路
const RESCAN_MS = 30 * 60 * 1000;         // 换域名探测的节流间隔
const MAX_SAMPLES = 4032;                 // 5 分钟 × 4032 ≈ 14 天

// 签到触发阈值：服务端加成档按 quality.score 分档（与页面 Cable +N 同一张表）
//   score<80 → +8(Poor) / <85 → +5 / <90 → +3 / <=95 → +2 / >95 → +1
// 旧版只认 level === "poor"（仅 +8 档）。多数日子网络只在 80~85 徘徊，死等 Poor
// 的结果是整天空转，最后掉到 21:00 兜底拿 1 分。故放宽到 <85（+5 及以上）。
// 想只等 +8 档，把这里改成 80 即可。
const BONUS_SCORE_MAX = 85;

// 兜底：当天到达该时刻仍未签到，则无视网络等级强制签到（与 content.js 保持一致）
// v1.5.3：21:00 起（原 21:00）。判定窗口 = 21:00–23:59 共 3 小时，
//   5 分钟采样闹钟在此期间有约 36 次触发机会，任一次成功即可签上，
//   不再依赖单次闹钟准点命中（MV3 对不活跃扩展的闹钟有节流延迟，5 分钟窗口极易跨过午夜而作废）。
const FORCE_HOUR = 21;
const FORCE_MINUTE = 0;

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function isPastForceTime() {
  const n = new Date();
  return n.getHours() > FORCE_HOUR ||
         (n.getHours() === FORCE_HOUR && n.getMinutes() >= FORCE_MINUTE);
}

// 计算下一个 21:00 的时间戳（今天已过则顺延到明天）
function nextForceTimestamp() {
  const now = new Date();
  const t = new Date();
  t.setHours(FORCE_HOUR, FORCE_MINUTE, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

// 设置/重设每日强制签到闹钟。每次触发后重设，避免休眠导致的周期漂移。
function ensureForceAlarm() {
  const when = nextForceTimestamp();
  chrome.alarms.create("forceCheckInAlarm", { when: when, periodInMinutes: 1440 });
  console.log("强制签到闹钟已设置，下次触发:", new Date(when).toLocaleString());
}

function setupAlarms() {
  chrome.alarms.clear("checkInAlarm"); // v1.5.0 起取消每小时刷新页面的闹钟
  chrome.alarms.create("iqiSampleAlarm", { delayInMinutes: 1, periodInMinutes: SAMPLE_PERIOD_MIN });
  ensureForceAlarm();
}

// ---- 伪装请求头规则：每个域名一条，Origin/Referer 必须与目标域名一致 ----
function buildRules() {
  return DOMAINS.map((d, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: `https://${d}` },
        { header: "Referer", operation: "set", value: `https://${d}/console/checkin` }
      ]
    },
    condition: {
      urlFilter: `${d}/api/user/checkin`,
      resourceTypes: ["xmlhttprequest"]
    }
  }));
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("插件已安装/更新，配置伪装规则与闹钟...");
  chrome.declarativeNetRequest.updateDynamicRules({
    // 覆盖旧版本可能残留的规则 id
    removeRuleIds: [1, 2, 3, 4, 5, 6, 7, 8],
    addRules: buildRules()
  });
  setupAlarms();
  sampleIQI("install"); // 立刻采一次，安装后马上有数据可看
});

chrome.runtime.onStartup.addListener(() => {
  console.log("浏览器启动，重设闹钟并采样...");
  setupAlarms(); // 重设，纠正休眠/关机造成的漂移
  sampleIQI("startup");
  if (isPastForceTime()) forceCheckInIfNeeded();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "iqiSampleAlarm") {
    await sampleIQI("alarm");
    // 兜底借 5 分钟采样闹钟的唤醒机会：过了 21:00 且今日未签 → 强制签。
    // MV3 service worker 的“单次 21:00 闹钟”可能因唤醒不及时被吞掉，
    // 而采样闹钟每 5 分钟必然唤醒一次，借此兜底更可靠，且 forceCheckInIfNeeded 幂等。
    if (isPastForceTime()) await forceCheckInIfNeeded();
  }
  // 每日 21:00 兜底闹钟：双保险，即使签到页没开着，闹钟也会唤醒 service worker
  if (alarm.name === "forceCheckInAlarm") {
    console.log("21:00 兜底闹钟触发");
    await forceCheckInIfNeeded();
    ensureForceAlarm(); // 触发后按钟点重设，防止周期漂移
  }
});

// ---- IQI 采样 ----
// 注意：页面 axios 实例的 baseURL 是 "/api"，页面里写 get("/user/iqi") 实际打 /api/user/iqi。
// 这里是绝对 URL，必须自己带 /api 前缀，否则命中 404 HTML 导致 json() 抛异常。
async function fetchIQI(domain) {
  try {
    // cache-busting + no-store：确保拿到的是服务端当下的值，而不是任何一层缓存
    const resp = await fetch(`https://${domain}/api/user/iqi?_=${Date.now()}`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    if (!resp.ok) return { level: null, reason: "HTTP " + resp.status };
    const json = await resp.json();
    // 响应体：{ code: 0, data: { quality: { level, score }, comment, ... } }
    if (json && json.code === 0 && json.data && json.data.quality) {
      return {
        level: json.data.quality.level,
        score: json.data.quality.score
      };
    }
    if (json && json.code === -2) return { level: null, reason: "未登录" };
    return { level: null, reason: (json && json.message) || "响应格式异常" };
  } catch (e) {
    return { level: null, reason: "请求失败" };
  }
}

async function sampleIQI(trigger) {
  try {
    const st = await chrome.storage.local.get({
      iqiSamples: [],
      activeDomain: DEFAULT_DOMAIN,
      lastDomainScan: 0
    });

    // 仲裁：签到页开着时由 content script 采样（页面同源，最贴近真实）。
    // 4 分钟内已有样本说明页面在采，后台这一轮让路，避免重复请求与重复记录。
    const last = st.iqiSamples[0];
    if (trigger === "alarm" && last && Date.now() - last.t < PAGE_FRESH_MS) return null;

    let host = st.activeDomain;
    let r = await fetchIQI(host);

    // 当前域名拿不到数据 → 探测其它域名，自动识别用户实际登录的是哪个（节流，避免每轮扫 6 个域名）
    if (!r.level && Date.now() - st.lastDomainScan > RESCAN_MS) {
      await chrome.storage.local.set({ lastDomainScan: Date.now() });
      for (const d of DOMAINS) {
        if (d === st.activeDomain) continue;
        const alt = await fetchIQI(d);
        if (alt.level) {
          r = alt;
          host = d;
          await chrome.storage.local.set({ activeDomain: d });
          console.log("IQI 采样域名已切换到:", d);
          break;
        }
      }
    }

    const info = await recordSample({
      t: Date.now(),
      src: "bg",
      host: host,
      l: r.level ? r.level.toLowerCase() : null,
      s: (r.score === undefined || r.score === null) ? null : r.score,
      e: r.level ? null : r.reason
    });

    if (isBonusLevel(r)) await checkinOnBonus(host, r.score);
    return info;
  } catch (e) {
    console.error("IQI 采样失败:", e);
    return null;
  }
}

// 单点写者：采样只在这里落盘，content script 通过消息把样本交过来，避免两边并发覆盖同一数组
async function recordSample(sample) {
  const st = await chrome.storage.local.get({ iqiSamples: [], iqiLastChange: 0 });
  // 归一化等级为小写，避免服务端返回 "Poor"/"poor" 混用导致变化检测与聚合分裂
  const lvl = sample.l ? String(sample.l).toLowerCase() : null;
  const rec = Object.assign({}, sample, { l: lvl });
  // 只跟上一条“有效样本”比对：失败样本不应重置变化检测
  const prev = st.iqiSamples.find((x) => x && x.l);
  const changed = !!lvl && (!prev || prev.l !== lvl || prev.s !== rec.s);
  if (changed) rec.c = 1;

  const samples = [rec, ...st.iqiSamples].slice(0, MAX_SAMPLES);
  const patch = { iqiSamples: samples };
  if (changed) patch.iqiLastChange = rec.t;
  await chrome.storage.local.set(patch);

  return {
    ok: !!lvl,
    changed: changed,
    lastChange: changed ? rec.t : st.iqiLastChange,
    total: samples.length
  };
}

// 是否处于「有加成」的档位：服务端分档 +8/+5（score<85），或等级直接为 Poor。
// 优先用新鲜采到的 score（扩展每 5 分钟 no-store，比页面 mount 时的缓存准）；
// score 缺失时才回退到 level，避免接口偶尔不返回 score 导致漏触发。
function isBonusLevel(r) {
  if ((r.level || "").toLowerCase() === "poor") return true;
  const s = Number(r.score);
  return Number.isFinite(s) && s > 0 && s < BONUS_SCORE_MAX;
}

// 采样到加成档 → 今日未签则签到
async function checkinOnBonus(domain, score) {
  const d = await chrome.storage.local.get(["lastCheckInDate"]);
  if (d.lastCheckInDate === todayStr()) return;
  console.log("采样到加成档 score=" + score + "，执行签到");
  performFetch(todayStr(), "poor", domain, score);
}

// ---- 21:00 兜底 ----
async function forceCheckInIfNeeded() {
  try {
    const data = await chrome.storage.local.get({ lastCheckInDate: "", activeDomain: DEFAULT_DOMAIN });
    const today = todayStr();
    if (data.lastCheckInDate === today) {
      console.log("21:00 兜底：今日已签到，跳过");
      return;
    }
    console.log("21:00 兜底：今日仍未签到，执行强制签到");
    // 记录“兜底确实尝试过”，用于区分「闹钟根本没跑」与「跑了但签到失败/误判」
    await chrome.storage.local.set({ lastForceAttemptDate: today });
    openCheckinTab();                                 // 页面路径：content.js 会强制点按钮并更新徽标
    await performFetch(today, "force", data.activeDomain); // API 路径：不依赖标签页与 DOM，双保险
  } catch (e) {
    console.error("21:00 兜底执行失败:", e);
  }
}

// 打开或刷新签到页。v1.5.0 起全天只有 21:00 兜底时会调用一次。
async function openCheckinTab() {
  try {
    const data = await chrome.storage.local.get({ lastCheckInDate: "", activeDomain: DEFAULT_DOMAIN });
    if (data.lastCheckInDate === todayStr()) {
      console.log("今日已签到，跳过刷新签到页");
      return;
    }
    const tabs = await chrome.tabs.query({ url: TAB_PATTERNS });
    if (tabs.length > 0) {
      await chrome.tabs.reload(tabs[0].id);
      console.log("已刷新已有签到页:", tabs[0].url);
    } else {
      await chrome.tabs.create({ url: `https://${data.activeDomain}/console/checkin`, active: false });
      console.log("已新建签到页（后台）:", data.activeDomain);
    }
  } catch (e) {
    console.error("打开签到页失败:", e);
  }
}

// ---- 消息 ----
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  // 设置页“手动测试”：直接调用 API
  if (request.action === "forceCheckIn") {
    chrome.storage.local.get({ activeDomain: DEFAULT_DOMAIN }, (d) => {
      performFetch(todayStr(), "manual", d.activeDomain);
    });
    sendResponse({ status: "processing" });
  }
  // content script 上报：请求 background 直接调 API 签到（统一走带 PoW 挑战的 performFetch）
  if (request.action === "doCheckin") {
    const d = await chrome.storage.local.get({ activeDomain: DEFAULT_DOMAIN, lastCheckInDate: "" });
    const src = request.source === "force" ? "force" : "poor";
    if (d.lastCheckInDate !== todayStr()) {
      await performFetch(todayStr(), src, d.activeDomain);
    }
    sendResponse({ ok: true });
  }
  // content script 上报：已在页面点击 Checkin（source: poor | force）
  if (request.action === "checkinDone") {
    console.log("content script 报告已签到，来源:", request.source);
    handleCheckinResult(request.today, request.message, request.source);
  }
  // content script 上报采样结果（页面同源采样，由后台单点落盘）
  if (request.action === "iqiSample") {
    recordSample(request.sample).then((info) => sendResponse(info || {}));
  }
  return true; // 保持消息通道打开，允许异步 sendResponse
});

// 来源标签：manual=设置页手动测试, poor=网络 Poor 触发, force=21:00 兜底强制
function sourceLabel(source) {
  if (source === "manual") return "手动测试";
  if (source === "force") return "强制·21:00";
  return "Poor 自动";
}

// GLaDOS 新签到流程需要工作量证明（PoW）：
//   1) GET /api/user/checkin/challenge → { code, nonce, ttl }
//   2) proof = SHA-256( nonce + ".glados-observer-v1" ) 的十六进制
//   3) POST /api/user/checkin ，body 带上 { token, nonce, proof }
// 旧版只发 {token} 会被服务端拒签（或只给降级 1 分），故此处完整复刻该流程。
const CHECKIN_SALT = "glados-observer-v1";

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getChallenge(host) {
  try {
    const resp = await fetch(`https://${host}/api/user/checkin/challenge`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json && json.code === 0 && json.nonce) return json.nonce;
    return null;
  } catch (e) {
    return null;
  }
}

// 直接发送签到请求（Poor 触发 / 手动测试 / 21:00 兜底 共用；不依赖标签页与 DOM）
// 返回 Promise，便于调用方 await —— 确保 MV3 service worker 在请求完成前不被挂起。
function performFetch(today, source, domain, score) {
  const host = domain || DEFAULT_DOMAIN;
  return (async () => {
    const nonce = await getChallenge(host);
    const proof = nonce ? await sha256Hex(nonce + "." + CHECKIN_SALT) : "";
    return fetch(`https://${host}/api/user/checkin`, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      credentials: "include",
      body: JSON.stringify({ token: host, nonce: nonce || "", proof })
    })
      .then((response) => response.json())
      .then((result) => {
        handleCheckinResult(today, result.message, source, result, score);
      })
      .catch((error) => {
        console.error("网络请求发生错误:", error);
        saveHistory(`[${sourceLabel(source)}] 网络连接失败`);
      });
  })();
}

// 统一处理签到结果：记录历史、更新日期、发通知
function handleCheckinResult(today, statusMsg, source, result, score) {
  const label = sourceLabel(source);
  const msg = statusMsg || "服务器无返回信息";
  const code = result && result.code;
  const reason = (result && result.reason) || "";
  console.log(`[${label}] 服务器返回 code=${code} reason=${reason}:`, msg);
  // 把「触发时采样 score」与「服务端实发 points」记在同一条历史里，
  // 用于校准预估档位与实发分值的偏差（页面 Cable +N 只是前端缓存预估，不是结算单）。
  const ctx = (score !== undefined && score !== null ? ` · 触发score=${score}` : "") +
    (result && result.points !== undefined && result.points !== null ? ` · 实发${result.points}分` : "");
  saveHistory(`[${label}] ` + msg + ctx);

  // 手动测试：只记录与通知，不写日期（避免污染当天真实签到判定）
  if (source === "manual") {
    notifyIfNeeded(today, "manual", `GLaDOS ${label}`, msg);
    return;
  }

  // 设备不匹配 / 会话失效（GLaDOS 新页面引入的拦截）：必须人工重新登录，自动化无法越过。
  // 不写签到日期，保留重试机会（用户重登后自动恢复）；记录标记并通知用户。
  const isMismatch = (code === 4 && /mismatch/i.test(reason)) ||
    /device.?mismatch|设备不匹配|新设备|会话失效|请.*重新登录|请.*登录/.test(msg);
  if (isMismatch) {
    chrome.storage.local.set({ lastDeviceMismatch: today });
    chrome.runtime.sendMessage({ action: "deviceMismatch" }).catch(() => {});
    saveHistory(`[${label}] ⚠ 设备不匹配/会话失效，请手动重新登录 GLaDOS 后再自动签到`);
    notifyIfNeeded(today, "mismatch", `GLaDOS ${label}`, "⚠ 设备不匹配/会话失效，请手动重新登录 GLaDOS");
    return;
  }

  // 成功判定：服务端 code===0 为权威；或明确告知“今天已签到/重复”也算完成，避免反复重试。
  // 注意：绝不能用“消息里是否含某个词”兜底成功——旧版 msgLower.includes("get") 会把含 get 的
  // 错误提示误判为成功，导致当天被标记为已签、不再重试而静默断签。
  // 服务端「今日已记录」的英文响应："Today's observation logged. Return tomorrow for more points."
  // 旧版未识别它 → 不写日期 → 每 5 分钟重复 POST、历史刷屏（实测 11/12 晚连刷 14 次）。
  const alreadyDone = /已签到|已经签到|今天.*签到|重复签到|已签过|already.{0,6}(check|sign)|signed|duplicate|observation.{0,20}logged|return tomorrow|tomorrow for more points/i.test(msg);
  const success = code === 0 || alreadyDone;
  if (success) {
    chrome.storage.local.set({ lastCheckInDate: today, lastDeviceMismatch: "" });
    console.log("已更新签到日期标识");
    notifyIfNeeded(today, "success", `GLaDOS ${label}`, msg);
  }
  // 其余（网络错误 / 其它失败）→ 不写日期，等待下个 5 分钟闹钟重试
}

// 通知去抖：同一天同一类型只弹一次，避免 5 分钟轮询刷屏
function notifyIfNeeded(today, type, title, message) {
  chrome.storage.local.get({ lastNotify: { date: "", type: "" } }, (data) => {
    const last = data.lastNotify || { date: "", type: "" };
    if (last.date === today && last.type === type) return; // 当天同类型已通知过
    chrome.storage.local.set({ lastNotify: { date: today, type: type } });
    chrome.storage.local.get(["notifyEnabled"], (d2) => {
      if (d2.notifyEnabled !== false) {
        chrome.notifications.create({ type: "basic", iconUrl: "icon.png", title: title, message: message });
      }
    });
  });
}

// 保存签到历史记录
async function saveHistory(msg) {
  try {
    const data = await chrome.storage.local.get({ history: [] });
    const newRecord = { time: new Date().toLocaleString(), result: msg };
    const newHistory = [newRecord, ...data.history].slice(0, 30);
    chrome.storage.local.set({ history: newHistory });
  } catch (error) {
    console.error("保存历史记录失败:", error);
  }
}

// 点击插件图标 → 打开设置页
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
