// 当页面打开时，读取保存的值并显示
document.addEventListener('DOMContentLoaded', async () => {
  // 1. 获取所有需要的数据
  const data = await chrome.storage.local.get({
    targetHour: 9,
    notifyEnabled: true,
    history: []
  });

  // 恢复用户的设置选项
  document.getElementById('targetHour').value = data.targetHour;
  document.getElementById('notifyToggle').checked = data.notifyEnabled;

  // 2. 显示最近 30 次签到历史
  const list = document.getElementById('historyList');
  if (data.history.length === 0) {
    list.innerHTML = '<li>暂无签到日志</li>';
  } else {
    data.history.forEach(item => {
      const li = document.createElement('li');
      li.textContent = `[${item.time}] ${item.result}`;
      list.appendChild(li);
    });
  }

  // 3. 渲染 IQI 采样面板
  renderIQI();
});

// ---------- IQI 采样面板 ----------

function fmtAgo(ts) {
  if (!ts) return '—';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分前';
  return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时前';
}

function fmtSpan(min) {
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' 小时';
  return (h / 24).toFixed(1) + ' 天';
}

async function renderIQI() {
  const st = await chrome.storage.local.get({
    iqiSamples: [], iqiLastChange: 0, activeDomain: '-'
  });
  const samples = st.iqiSamples;          // 新的在前
  const box = document.getElementById('iqiSummary');
  const hourlyBox = document.getElementById('iqiHourly');

  if (!samples.length) {
    box.innerHTML = '暂无采样数据。扩展每 5 分钟采样一次，请稍候片刻再刷新本页；'
      + '若长时间为空，多半是当前浏览器<b>未登录</b> GLaDOS。';
    hourlyBox.innerHTML = '';
    return;
  }

  const valid = samples.filter(x => x && x.l);
  const latest = samples[0];
  const changes = samples.filter(x => x && x.c).length;
  const spanMin = Math.max(1, Math.round((samples[0].t - samples[samples.length - 1].t) / 60000));
  const rate = Math.round((valid.length / samples.length) * 100);
  const nPage = samples.filter(x => x && x.src === 'page').length;
  const nBg = samples.filter(x => x && x.src === 'bg').length;

  // 「数据是否真的在更新」的判定 —— 这是本面板最重要的一行
  let verdict;
  if (!valid.length) {
    verdict = `<span style="color:#c0392b;">⚠ 全部采样失败（最近原因：${latest.e || '未知'}），数据不可用</span>`;
  } else if (changes === 0) {
    verdict = `<span style="color:#8a6d00;">⏳ 采样正常，但分数尚未观察到变化（服务端可能低频更新，继续观察）</span>`;
  } else {
    verdict = `<span style="color:#1a7f37;">✓ 数据确实在更新：已记录 <b>${changes}</b> 次变化，`
      + `上次变化 ${fmtAgo(st.iqiLastChange)}</span>`;
  }

  const latestTxt = latest.l
    ? `<b>${latest.l}</b>${latest.s === null || latest.s === undefined ? '' : ' ' + latest.s + ' 分'}`
    : `<span style="color:#c0392b;">读取失败（${latest.e || '未知'}）</span>`;

  box.innerHTML = `
    <div>${verdict}</div>
    <div>最近采样：${latestTxt} &nbsp;·&nbsp; ${fmtAgo(latest.t)} &nbsp;·&nbsp; 来源 ${latest.src === 'page' ? '签到页' : '后台'}</div>
    <div>累计 <b>${samples.length}</b> 条，跨度 ${fmtSpan(spanMin)}，成功率 <b>${rate}%</b>
         （签到页 ${nPage} / 后台 ${nBg}）</div>
    <div>当前域名：<b>${latest.host || st.activeDomain}</b></div>
  `;

  // 按小时聚合，用于判断“一天中的好时机”
  const buckets = [];
  for (let i = 0; i < 24; i++) buckets.push({ n: 0, sum: 0, cnt: 0, min: null, poor: 0 });
  valid.forEach(x => {
    const b = buckets[new Date(x.t).getHours()];
    b.n++;
    if (typeof x.s === 'number') {
      b.sum += x.s;
      b.cnt++;
      b.min = (b.min === null) ? x.s : Math.min(b.min, x.s);
    }
    if (x.l === 'poor' || x.l === 'critical') b.poor++;
  });

  const rows = [];
  for (let h = 0; h < 24; h++) {
    const b = buckets[h];
    if (!b.n) continue;
    const avg = b.cnt ? (b.sum / b.cnt).toFixed(1) : '—';
    rows.push(
      `<tr class="${b.poor ? 'hot' : ''}">` +
      `<td>${String(h).padStart(2, '0')}:00</td>` +
      `<td>${b.n}</td><td>${avg}</td><td>${b.min === null ? '—' : b.min}</td>` +
      `<td>${b.poor || ''}</td></tr>`
    );
  }

  hourlyBox.innerHTML = rows.length
    ? `<div class="muted" style="margin:10px 0 4px;">按小时聚合（分数越低网络越差；Poor 次数多的时段更容易触发自动签到）</div>
       <table class="iqi">
         <tr><th>时段</th><th>样本</th><th>均分</th><th>最低</th><th>Poor</th></tr>
         ${rows.join('')}
       </table>`
    : '<div class="muted" style="margin-top:10px;">暂无有效样本，无法按小时聚合。</div>';
}

// 保存设置
document.getElementById('saveBtn').addEventListener('click', () => {
  const hour = parseInt(document.getElementById('targetHour').value);
  const notify = document.getElementById('notifyToggle').checked;

  chrome.storage.local.set({
    targetHour: hour,
    notifyEnabled: notify
  }, () => {
    alert("设置已保存！\n注意：本版签到时机由「网络 Poor」与「21:00 兜底」决定，上方的时间下拉框不再生效。");
  });
});

// 立即测试按钮的逻辑
document.getElementById('testBtn').addEventListener('click', () => {
  // 发送消息给后台脚本 background.js，让它立刻执行签到
  chrome.runtime.sendMessage({ action: "forceCheckIn" }, () => {
    alert("测试指令已发送，请检查下方历史记录或系统通知。");
    setTimeout(() => location.reload(), 2000);
  });
});

// 导出采样数据（便于离线分析最佳签到时机）
document.getElementById('exportBtn').addEventListener('click', async () => {
  const st = await chrome.storage.local.get({ iqiSamples: [] });
  if (!st.iqiSamples.length) { alert('还没有采样数据。'); return; }
  const blob = new Blob([JSON.stringify(st.iqiSamples, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `glados-iqi-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// 清空采样
document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('确定清空全部 IQI 采样记录？此操作不可撤销（签到历史不受影响）。')) return;
  await chrome.storage.local.set({ iqiSamples: [], iqiLastChange: 0 });
  renderIQI();
});
