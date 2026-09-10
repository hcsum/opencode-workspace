---
name: web-access
description: Use when a task needs a live browser session: opening or controlling pages, reusing logged-in state, interacting with UI (clicks, scrolling, forms, uploads), reading JavaScript-rendered content, taking screenshots, searching local browser history/bookmarks, or researching sites that typically require real browsing such as Reddit, X, social platforms, logged-in apps, dynamic pages, or anti-bot-heavy sites. Do not use for plain HTTP requests or static URL fetching on sites known to work reliably without a browser.
---

# web-access

这个 skill 用本地代理控制真实浏览器。能用普通 fetch 或静态页面读取解决的任务，不要加载它。

## 启动

在本 skill 目录运行预检：

```bash
node ./scripts/check-deps.mjs
```

只根据 JSON 结果分支：

- `ok: true`：使用已选中的 runtime 继续。
- `ok: false`：按 `guidance` 处理；只有缺浏览器访问或 debug 权限时才询问用户。
- `provider` 表示当前 runtime 是 `local` 还是 `browserbase`。
- `selectedMode` 表示当前浏览器模式是 `primary`、`dedicated` 还是 `browserbase`。

任务依赖特定浏览器时显式检查：

```bash
node ./scripts/check-deps.mjs --browser primary
node ./scripts/check-deps.mjs --browser dedicated --browser-id <browser-id>
```

## 浏览器模式

- `primary`：连接用户当前主力 Chromium 浏览器，可操作已有页面，并复用登录态、cookie、插件和书签。可能偶发需要用户确认 debug access。
- `dedicated`：连接独立自动化 profile。通常规避反复 debug 确认，也更隔离，但登录态、插件和书签都要单独配置。
- `browserbase`：设置 `BROWSERBASE_API_KEY` 等环境变量后使用远端浏览器。适合远端主机、CI、或没有可用本地 GUI 浏览器的环境。

Agent 可以按任务自由切换模式。需要用户现有登录态/页面：用 `primary`。需要隔离和稳定：用 `dedicated`。本地没有可用浏览器：用 `browserbase`。

切换 runtime 后旧 `targetId` 会失效；切换后重新列出或打开目标页。

## 专用浏览器

用户选择专用浏览器时，把浏览器 App 映射成稳定的 `browser-id`：

| browser-id | Browser app |
|---|---|
| `chrome` | `Google Chrome` |
| `chrome-canary` | `Google Chrome Canary` |
| `chromium` | `Chromium` |
| `brave` | `Brave Browser` |
| `edge` | `Microsoft Edge` |
| `arc` | `Arc` |

让用户用下面的命令启动：

```bash
open -na "<Browser App Name>" --args \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.web-access/<browser-id>-dedicated-profile"
```

用户确认已启动后，再检查：

```bash
node ./scripts/check-deps.mjs --browser dedicated --browser-id <browser-id>
```

## Proxy API

代理地址是 `http://localhost:3456`。

```bash
curl -s http://localhost:3456/targets
curl -s "http://localhost:3456/new?url=https://example.com"
curl -s "http://localhost:3456/info?target=ID"
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'document.title'
curl -s -X POST "http://localhost:3456/click?target=ID" -d 'button.submit'
curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d 'button.upload'
curl -s "http://localhost:3456/navigate?target=ID&url=https://example.com"
curl -s "http://localhost:3456/back?target=ID"
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/shot.png"
curl -s "http://localhost:3456/close?target=ID"
curl -s http://localhost:3456/shutdown
```

少见操作再读 `references/cdp-api.md`。

## 历史和书签

当用户提到以前访问过的页面、某个后台、或没有明确公开 URL 的内部系统时，检索本地浏览器历史/书签：

```bash
node ./scripts/find-url.mjs [keywords...] [--only bookmarks|history] [--limit N] [--since 1d|7h|YYYY-MM-DD] [--sort recent|visits]
```

## 操作规则

- 优先用 `/new` 打开自己的 tab；除非任务明确要求使用当前页面，否则不要打扰用户已有 tab。
- 如果登录挡住目标内容，让用户在当前浏览器登录，再刷新或继续。确认内容确实被登录挡住前，不要先要求登录。
- 任务完成后，用 `/close` 关闭自己打开的 tab。
- 如果 `provider` 不是 `local`，结束前调用 `/shutdown` 释放远端浏览器会话。
