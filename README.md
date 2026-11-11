# GLaDOS 签到助手 · IQI 采样 + Poor 签到

![Version](https://img.shields.io/badge/version-1.5.5-blue.svg)
![Platform](https://img.shields.io/badge/platform-Chrome%20MV3-orange.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

一个本地运行的 Chrome Manifest V3 扩展：每 5 分钟采样 GLaDOS 的网络质量（IQI）并记录，**优先在网络为 Poor 时签到**（争取更高的线路加成）；当天 21:00 仍未签则强制兜底，防止漏签。

> 注意：最终发放多少积分**由服务端在签到那一刻结算**，扩展只能尽量挑质量差的时刻提交，不能保证拿到某个具体分值。详见下方「关于 Cable +8」。

> 本仓库是 [原版 GLaDOS 自动签到助手](https://imneko.com) 的 **fork 修改版**，与原作者的 Chrome 商店版本（不同扩展 ID）互不兼容。请以本仓库源码通过开发者模式加载。

## 为什么要等 Poor 再签

GLaDOS 设有「线路加成（Cable Bonus）」：**网络越差，单次签到的加成越高**。签到页 `renderPointsBreakdown` 里前端按 `iqi.quality.score` 预估的档位是：

| 质量指数 `score` | 前端预估加成 |
|---|---|
| `< 80` | +8 |
| `< 85` | +5 |
| `< 90` | +3 |
| `<= 95` | +2 |
| `> 95` | +1 |

`/console/network` 的 Cable Bonus 卡片用 `[80, 85, 90, 96]` 对 `network-insight` 的 `current.score` 分档，口径基本一致。

### 关于「页面显示 Cable +8，实际只加 1」

这是**正常现象，不是扩展故障**，手动点页面按钮也一样。原因有三：

1. **那张明细卡是说明性的，不是结算承诺**。同一行里 `Base` 档直接写死 `"+X"` 占位符；`Cable` 的值是浏览器本地用 `iqi.quality.score` 算出来的预估。
2. **页面 IQI 只在 `componentDidMount` 取一次**（`loadIQI()` 无轮询、`setInterval` 与 IQI 无关）。页面开着不刷新，`Cable +8` 就是**打开页面那一刻**的旧值；几小时后网络恢复，值还停在 +8。
3. **实际发放由服务端决定**：`POST /user/checkin` 响应里的 `points` 才是本次实发，前端只是 `setState({points: n.points})` 显示它。服务端按签到请求那一刻自己的线路质量快照结算，与浏览器缓存的 IQI 不同源、不同时点。

自查方法：刷新签到页后把鼠标悬停在 `Cable +N` 徽标上看 tooltip `Current index XXX`；或打开 `/console/network` 看 Cable Bonus 卡片里带 **`· now`** 高亮的那一行 `+points`——那是服务端当前档位。若它是 `+1`，签到加 1 分就是正确结算。

因此扩展的定位是：**尽量把提交动作放到质量差的时刻**，21:00 兜底只保证「今天不漏签」（通常就是 1 分）。选项页导出的每条采样都带 `s`（score），把签到时刻的 score 与实发分数对照，就能校准你自己线路的真实映射。

选项页的 **IQI 采样面板**提供 24 小时聚合表（均分 / 最低分 / Poor 次数，含 Poor 的时段高亮），攒几天数据就能看出自己线路一天中的差时段。

## 功能

- **5 分钟采样**：`/api/user/iqi`，带 `cache-busting` + `no-store`，保证拿到服务端实时值；签到页开着由页面采，关了由 service worker 接手，不依赖标签页。
- **数据可信度判定**：选项页明确给出「数据确实在更新 / 尚未观察到变化 / 全部采样失败」三态，失败样本不参与变化比对，不谎报。
- **PoW 工作量证明**：GLaDOS 改版后签到接口强制要求先取 challenge nonce、再提交 `SHA-256(nonce + "glados-observer-v1")` 作为 proof。本扩展在后台完整复刻该流程，不依赖点击页面按钮。
- **21:00 兜底**：判定窗口 21:00–23:59，期间每个 5 分钟采样闹钟都会检查一次（约 36 次机会），避开 MV3 单次闹钟被节流吞掉的风险。`lastCheckInDate` 保证幂等，不会重复签。
- **多域名通配**：自动适配 `glados.cloud` / `glados-facility.com` / `glados.rocks` / `glados.space` / `glados.one` / `glados.network`，自动识别当前登录的是哪个。
- **设备不匹配提示**：GLaDOS 返回 `code=4 / device-mismatch` 时不误判为成功，明确提示手动重新登录并保留重试。
- **导出**：选项页可把采样数据导出为 JSON。

## 安装

> 前提：当前 Chrome 已登录任一 GLaDOS 站点。

1. 克隆本仓库：`git clone https://github.com/vanechen-hub/glados-checkin-ext.git`
2. 打开 `chrome://extensions/`，开启右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本仓库根目录
4. 确认版本 **1.5.5**、ID `dajcldcodnpcnamjfbmioehhnaanlodm`

**更新代码后**：`manifest.json` 有变更时，扩展卡片的 ⟳ 刷新按钮常不生效，需 **移除后重新加载**。

`manifest.json` 里的 `key` 是 RSA **公钥**（不是私钥），仅用于固定扩展 ID，公开无害。对应私钥不在本仓库中。

## 文件结构

```
manifest.json      扩展配置（MV3 / 权限 / 域名通配）
background.js      service worker：采样、PoW 签到、21:00 兜底、结果判定、历史
content.js         签到页内：采样上报、状态徽标、触发签到
content.css        徽标样式
options.html/js    设置页 + IQI 采样面板（24 小时聚合、导出）
icon.png           图标
tests/             Node vm 仿真验证脚本（加载真实 background.js）
```

## 运行验证

```bash
node tests/verify_force_v153.js       # 21:00 兜底窗口边界与幂等      16 项
node tests/verify_result_v154.js      # 签到结果判定（成功/失败/设备不匹配）10 项
node tests/verify_challenge_v155.js   # PoW challenge → proof → POST     12 项
```

脚本用 Node `vm` 加载**真实** `background.js`，mock `chrome` / `fetch` / `crypto.subtle`，不改动扩展源码、不需要浏览器。

## 版本沿革（摘）

| 版本 | 关键改动 |
|---|---|
| 1.5.0 | 通配 6 域名；刷新改为每天仅 1 次；轮询 10s → 5min 并落盘；采样下沉到 service worker |
| 1.5.1 | `poor` 等级判定改为大小写无关；按钮点不到时改走 API |
| 1.5.2 | 修复 MV3 service worker 在异步闹钟中提前挂起导致的静默漏签 |
| 1.5.3 | 兜底窗口由 23:55 的 5 分钟扩到 21:00–23:59（原判定 `getHours() > 23` 恒为 false） |
| 1.5.4 | 成功判定改为权威 `code===0`，删掉会把含 "get" 的错误误判成功的兜底；新增设备不匹配处理 |
| 1.5.5 | 适配 GLaDOS 新签到接口的 PoW 挑战；废弃已失效的按钮点击路径 |

## 致谢与许可

- 原作者：[一只夜猫子 imneko.com](https://imneko.com)，原版采用 MIT 许可，版权声明见 [LICENSE](LICENSE)。
- 本仓库为个人学习用的修改版，与 GLaDOS 官方无隶属关系。使用自动化签到请自行确认是否符合该站点的服务条款。
- MIT License，详见 [LICENSE](LICENSE)；隐私说明见 [PRIVACY_POLICY.md](PRIVACY_POLICY.md)。
