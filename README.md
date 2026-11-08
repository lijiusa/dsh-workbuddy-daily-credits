# dsh-workbuddy-daily-credits

在 dsh（DeepSeek Harness）里一键领取 **WorkBuddy** 的每日签到积分与福利活动积分。

只做 WorkBuddy 一家；**不需要下载 WorkBuddy 桌面客户端** —— 认证走 WorkBuddy 官方网页 OAuth，
在浏览器里登录授权一次即可。

## 功能

- 输入框下方常驻一张小卡片（`conversation.composer.dock` 槽位），显示：
  - 今日签到状态、连续签到天数、每日积分
  - 积分余额（个人版权益包 / 企业版额度）
  - 福利活动（补偿金、新人礼）的可领状态
- 网页登录：点击「登录 WorkBuddy」打开官方登录页完成授权，卡片自动轮询并保存凭据
- 一键「领取今日签到」「领取福利积分」
- 支持国内版（`www.codebuddy.cn`）与国际版（`www.workbuddy.ai` / `www.codebuddy.ai`）
- 同时提供 agent 工具 `workbuddy_daily_credits`（action：`status` / `checkin` / `benefit` / `login` / `poll`）

## 安装

本仓库是一个 dsh 插件包（bundle），根 `package.json` 声明了 `dsh.bundle`，可以用 dsh 的
插件管理器从以下任一来源安装：

- **插件市场**：收录后在 dshmarket 中搜索 `dsh-workbuddy-daily-credits`。
- **预构建包（推荐）**：把 Release 里的 `dsh-workbuddy-daily-credits.tgz` 作为安装源
  （`releases/latest/download/dsh-workbuddy-daily-credits.tgz`），开箱即用，不需要构建授权。
- **源码**：`github:<owner>/dsh-workbuddy-daily-credits`。

本地开发时也可以把仓库目录作为本地包安装；改完源码后用插件管理器的禁用 / 启用即可热重载。

安装后重启 dsh（或重启对应 profile）使 Host 半身与浏览器半身生效。

> 提示：如果本机用 HTTP 代理访问 GitHub，而代理做了 TLS 中间人解密，安装过程里的 pnpm
> 可能报 `unable to verify the first certificate`。此时把代理根证书导出为 PEM，
> 在 profile 目录（`~/.dsh/profiles/<profile>/`）放一个 `.npmrc` 指向它即可：
>
> ```
> cafile=/absolute/path/to/proxy-ca.pem
> ```

## 配置

插件没有需要手填的配置项。登录成功后，WorkBuddy 的访问凭据保存在 dsh 的凭据存储中
（记录键 `dsh-workbuddy-daily-credits/account`），不会写入插件配置或明文配置文件。

如果本机已经存在 WorkBuddy 留下的登录态（`~/.dsh/workbuddy-vault/<region>/*.json`，
其它 WorkBuddy 插件或桌面客户端写的），插件首次运行时会自动把它接过来，免去一次网页授权。

## 数据来源

所有数据来自 WorkBuddy 官方接口：

| 用途 | 接口 |
| --- | --- |
| 签到状态 | `POST {billing}/v2/billing/meter/checkin-activity-status` |
| 领取签到 | `POST {billing}/v2/billing/meter/daily-checkin` |
| 福利状态 | `POST {billing}/billing/meter/compensation-status`、`/billing/meter/check-gift-claimed` |
| 领取福利 | `POST {billing}/billing/meter/claim-compensation`、`/billing/meter/claim-gift` |
| 积分余额 | `POST {billing}/v2/billing/meter/get-user-resource` |
| 网页登录 | `POST {base}/v2/plugin/auth/state?platform=workbuddy`、`GET {base}/v2/plugin/auth/token?state=...` |

其中 `{billing}` 为国内版 `https://www.codebuddy.cn` 或国际版 `https://www.workbuddy.ai`。

## 隐私与安全

- 登录页面在官方站点打开，密码不经过本插件。
- 所有 Host 路由仅接受回环地址（loopback）请求，并校验 Host / Origin 头，防止 CSRF 与 DNS rebinding。
- 插件仅在你手动点击时才会调用领取接口，不会自动定时领取。

## License

MIT
