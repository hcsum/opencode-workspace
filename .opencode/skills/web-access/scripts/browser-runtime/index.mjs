import { CdpRuntime } from './cdp-runtime.mjs';
import { ALLOWED_BROWSER_IDS, defaultDedicatedProfileDir, resolveProviderFromEnv } from './provider-resolver.mjs';
import { resolveLocalBrowser } from './providers/local.mjs';
import { createBrowserbaseSession, releaseBrowserbaseSession } from './providers/browserbase.mjs';

// playwright-core 仅 Browserbase 云浏览器模式需要，在对应分支内动态加载。
// 本地 CDP 浏览器（primary/dedicated）走纯 CDP，不依赖 playwright-core。

export function loadRuntimeConfig(env = process.env) {
  const config = resolveProviderFromEnv(env);
  config.browserbaseApiBaseUrl = (env.BROWSERBASE_API_BASE_URL || 'https://api.browserbase.com').replace(/\/$/, '');
  return config;
}

export async function resolveRuntimeAvailability(config) {
  if (config.provider === 'browserbase') {
    return {
      ok: true,
      provider: 'browserbase',
      browser: 'browserbase',
      browserId: null,
      dedicatedProfileDir: null,
      port: null,
      availableModes: ['browserbase'],
      selectedBecause: 'cloud_browser_configured',
    };
  }

  if (config.browserMode) {
    const local = await resolveLocalBrowser(config);
    if (!local) {
      return {
        ok: false,
        provider: 'local',
        reason: config.browserMode === 'primary' ? 'primary_not_connected' : 'dedicated_not_connected',
        availableModes: [],
        requestedMode: config.browserMode,
        browserId: config.browserId,
        dedicatedProfileDir: config.dedicatedProfileDir,
        guidance: config.browserMode === 'primary'
          ? '请先开启 primary browser 的远程调试，或改为 dedicated 模式。'
          : '请先启动专用浏览器，或检查 dedicated profile 路径是否正确。',
      };
    }
    return {
      ok: true,
      provider: 'local',
      browser: local.browserMode,
      browserId: local.browserId,
      dedicatedProfileDir: local.dedicatedProfileDir,
      port: local.port,
      availableModes: [local.browserMode],
      selectedBecause: 'requested_mode',
      local,
    };
  }

  const primary = await resolveLocalBrowser({ ...config, browserMode: 'primary' });
  const dedicated = await resolveFirstDedicatedBrowser(config);
  const availableModes = [];
  if (primary) availableModes.push('primary');
  if (dedicated) availableModes.push('dedicated');
  if (primary && dedicated) {
    return { ok: true, provider: 'local', browser: dedicated.browserMode, browserId: dedicated.browserId, dedicatedProfileDir: dedicated.dedicatedProfileDir, port: dedicated.port, availableModes, selectedBecause: 'dedicated_preferred_when_both_available', local: dedicated };
  }
  if (dedicated) {
    return { ok: true, provider: 'local', browser: dedicated.browserMode, browserId: dedicated.browserId, dedicatedProfileDir: dedicated.dedicatedProfileDir, port: dedicated.port, availableModes, selectedBecause: 'only_dedicated_available', local: dedicated };
  }
  if (primary) {
    return { ok: true, provider: 'local', browser: primary.browserMode, browserId: null, dedicatedProfileDir: null, port: primary.port, availableModes, selectedBecause: 'only_primary_available', local: primary };
  }
  return {
    ok: false,
    provider: 'local',
    reason: 'no_browser_available',
    availableModes,
    requestedMode: null,
    guidance: {
      primary: '先在主力浏览器开启 remote debugging，然后重跑 check-deps。',
      dedicated: '先启动 dedicated profile（带 --remote-debugging-port），再重跑 check-deps。',
    },
  };
}

async function resolveFirstDedicatedBrowser(config) {
  const preferredIds = [];
  if (config.browserId && ALLOWED_BROWSER_IDS.has(config.browserId)) preferredIds.push(config.browserId);
  for (const id of ALLOWED_BROWSER_IDS) {
    if (!preferredIds.includes(id)) preferredIds.push(id);
  }
  for (const browserId of preferredIds) {
    const dedicated = await resolveLocalBrowser({
      ...config,
      browserMode: 'dedicated',
      browserId,
      dedicatedProfileDir: defaultDedicatedProfileDir(browserId),
    });
    if (dedicated) return dedicated;
  }
  return null;
}

export async function createRuntime(config, runtimeInfo) {
  if (runtimeInfo.provider === 'browserbase') {
    let chromium;
    let PlaywrightRuntime;
    try {
      ({ chromium } = await import('playwright-core'));
      ({ PlaywrightRuntime } = await import('./playwright-runtime.mjs'));
    } catch (cause) {
      const error = new Error(
        'Browserbase（云浏览器）模式需要 playwright-core 依赖。请在 skill 根目录运行 `npm install`（或 `npm install playwright-core`）后重试。本地 CDP 浏览器（primary/dedicated）模式无需此依赖。' +
        `\n原始错误: ${cause instanceof Error ? cause.message : String(cause)}`
      );
      error.code = 'PLAYWRIGHT_CORE_MISSING';
      error.statusCode = 503;
      throw error;
    }
    const session = await createBrowserbaseSession(config);
    const browser = await chromium.connectOverCDP(session.connectUrl);
    const runtime = new PlaywrightRuntime({
      releaseBrowserbaseSession: async (sessionId) => releaseBrowserbaseSession(config, sessionId),
    }, session, browser);
    await runtime.init();
    return runtime;
  }

  return new CdpRuntime({
    provider: 'local',
    browserMode: runtimeInfo.browser,
    browserId: runtimeInfo.browserId,
    dedicatedProfileDir: runtimeInfo.dedicatedProfileDir,
    port: runtimeInfo.port,
    wsUrl: runtimeInfo.local.wsUrl,
  });
}
