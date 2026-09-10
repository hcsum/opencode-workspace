# web-access

一个极简 agent skill：当静态 fetch 不够用时，用它控制真实浏览器，比如登录后页面、动态 UI、点击/表单、截图、文件上传、浏览器历史/书签检索。

## 浏览器模式

主要亮点是模式切换。Agent 可以按任务选择浏览器模式，同时继续使用同一套 proxy API。

- `primary`：连接用户当前主力 Chromium 浏览器。可以接管已有页面，并无缝复用登录态、cookie、插件和书签。可能偶发需要用户确认 debug access。
- `dedicated`：连接独立 Chromium profile。通常可以规避反复 debug 确认，也能把自动化和日常浏览隔离开；但这个 profile 需要单独配置登录态、插件和书签。
- `browserbase`：通过环境变量启用远端浏览器。适合服务器、CI、或没有可用本地 GUI 浏览器的 agent 环境。

切换模式会重建 proxy 后面的 runtime，因此旧 `targetId` 应视为失效。

## 工作机制

- `SKILL.md`：告诉 agent 什么时候需要真实浏览器，以及如何选择模式。
- `scripts/check-deps.mjs`：检测可用浏览器 runtime，并启动或复用 proxy。
- `scripts/cdp-proxy.mjs`：把浏览器操作暴露成 `localhost:3456` 上的 HTTP endpoint。
- `scripts/find-url.mjs`：检索本地浏览器历史/书签。
- `references/cdp-api.md`：少见 proxy 操作的详细说明。

## 基本流程

```bash
node ./scripts/check-deps.mjs
```

如果返回 `ok: true`，proxy 已可用。如果返回 `ok: false`，按输出里的 guidance 让浏览器变为可用。

显式指定本地模式：

```bash
node ./scripts/check-deps.mjs --browser primary
node ./scripts/check-deps.mjs --browser dedicated --browser-id brave
```

启动专用 profile：

```bash
open -na "Brave Browser" --args \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.web-access/brave-dedicated-profile"
```

支持的 browser id：`chrome`、`chrome-canary`、`chromium`、`brave`、`edge`、`arc`。

## 远端浏览器

设置 Browserbase 环境变量即可启用远端 runtime：

```bash
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
```

可选变量包括 `BROWSERBASE_CONTEXT_ID`、`BROWSERBASE_CONTEXT_PERSIST`、`BROWSERBASE_USE_PROXY`、`BROWSERBASE_SOLVE_CAPTCHA`、`BROWSERBASE_VERIFIED`、`BROWSERBASE_REGION`、`BROWSERBASE_SESSION_TIMEOUT_SEC`。

## 要求

- Node.js 22+
- 本地模式需要 Chromium 系浏览器；远端模式需要 Browserbase credentials
