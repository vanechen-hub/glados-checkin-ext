# 隐私政策 (Privacy Policy)

**生效日期：2026年1月14日**
**更新日期：2026年11月9日**

欢迎使用 **GLaDOS 签到助手（IQI 采样 + Poor 签到）**。本扩展是纯本地运行的自动化工具，以下是它实际处理的数据。

## 1. 数据收集与使用

- **个人信息**：本扩展**不会**收集、上传或存储任何个人身份信息（姓名、邮箱、密码等）。
- **登录凭证**：仅复用你浏览器中已有的 GLaDOS 登录状态（Cookie）完成签到请求。扩展本身**不会**读取、记录或存储密码与 Cookie 内容，请求使用 `credentials: "include"` 由浏览器自动携带。
- **网络质量数据**：每 5 分钟向站点读取一次 IQI 网络质量（等级 / 分数），仅保存在本地，用于判断签到时机和生成时段统计。**不会上传**到任何服务器。

## 2. 数据存储

全部数据存于本机 `chrome.storage.local`，不离开浏览器：

| 键 | 内容 | 上限 |
|---|---|---|
| `iqiSamples` | IQI 采样序列（时间、等级、分数、来源域名） | 4032 条 ≈ 14 天 |
| `history` | 最近签到结果日志 | 30 条 |
| `lastCheckInDate` 等 | 当天是否已签、兜底尝试、通知去抖、当前活跃域名 | 少量状态位 |

选项页提供「导出 JSON」和「清空采样数据」按钮，数据完全由你掌控。**卸载扩展时 Chrome 会自动清除上述全部本地数据。**

## 3. 第三方共享

- 本扩展**不会**把任何数据共享、出售或传输给第三方。
- 唯一的对外通信对象是 **GLaDOS 官方站点本身**，包括：
  - `GET /api/user/iqi` — 读取网络质量
  - `GET /api/user/checkin/challenge` — 获取签到挑战 nonce
  - `POST /api/user/checkin` — 提交签到（含由 nonce 计算的 proof）
- 覆盖域名：`glados.cloud`、`glados-facility.com`、`glados.rocks`、`glados.space`、`glados.one`、`glados.network`。
- 仓库内的 `tests/` 脚本只在本机用 Node 模拟运行，不发起真实网络请求。

## 4. 权限说明

| 权限 | 用途 |
|---|---|
| `storage` | 保存采样序列、签到历史与状态位 |
| `alarms` | 5 分钟采样 / 每日 21:00 兜底调度 |
| `notifications` | 签到结果（同天同类型已做去抖，不会刷屏） |
| `tabs` | 21:00 兜底时刷新或新建签到页 |
| `declarativeNetRequest` | 为签到请求补上与页面一致的 `Origin` / `Referer` 请求头，使后台直接发起的 API 请求符合站点校验 |
| `host_permissions` | 仅上述 6 个 GLaDOS 域名的 `/console/checkin*` 与 API 路径 |

`manifest.json` 中的 `key` 为固定扩展 ID 所用的 **RSA 公钥**，不含任何密钥材料；对应私钥不在源码仓库中。

## 5. 联系方式

有疑问请通过 GitHub Issue 联系。

---
*注：本扩展为个人开发工具，与 GLaDOS 官方团队无隶属关系。*
