#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig, resolveRuntimeAvailability } from './browser-runtime/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);

function printJson(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function fail(result, exitCode = 1) {
  printJson({ ok: false, ...result });
  process.exit(exitCode);
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const version = `v${process.versions.node}`;
  return {
    ok: major >= 22,
    version,
    recommendation: major >= 22 ? null : '建议升级到 22+',
  };
}

function httpGetJson(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => {
      try { return JSON.parse(await res.text()); } catch { return null; }
    })
    .catch(() => null);
}

function startProxyDetached(config) {
  const logFile = path.join(os.tmpdir(), 'cdp-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: {
      ...process.env,
      BROWSER_PROVIDER: config.provider,
      BROWSER_MODE: config.browserMode || '',
      BROWSER_ID: config.browserId || '',
      DEDICATED_PROFILE_DIR: config.dedicatedProfileDir || '',
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy(config) {
  const healthUrl = `http://127.0.0.1:${PROXY_PORT}/health`;
  const shutdownUrl = `http://127.0.0.1:${PROXY_PORT}/shutdown`;
  const targetsUrl = `http://127.0.0.1:${PROXY_PORT}/targets`;

  const health = await httpGetJson(healthUrl);
  if (
    health?.status === 'ok' &&
    health.provider === config.provider &&
    health.browserMode === (config.browserMode || config.provider) &&
    health.connected === true
  ) {
    return { ok: true, reusedExisting: true, restartedForModeSwitch: false };
  }

  let restartedForModeSwitch = false;
  if (
    health?.status === 'ok' &&
    ((health.provider && health.provider !== config.provider) ||
      (health.browserMode && health.browserMode !== (config.browserMode || config.provider)))
  ) {
    await httpGetJson(shutdownUrl, 2000);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    restartedForModeSwitch = true;
  }

  const targets = await httpGetJson(targetsUrl);
  if (Array.isArray(targets)) {
    return { ok: true, reusedExisting: true, restartedForModeSwitch };
  }

  startProxyDetached(config);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  let hint = null;
  for (let i = 1; i <= 15; i += 1) {
    const result = await httpGetJson(targetsUrl, 8000);
    if (Array.isArray(result)) {
      return { ok: true, reusedExisting: false, restartedForModeSwitch, hint };
    }
    if (i === 1) {
      hint = config.provider === 'browserbase'
        ? 'Browserbase 模式下若持续超时，请检查云浏览器凭据与项目配置是否有效，以及云端网络是否可访问 api.browserbase.com。'
        : config.browserMode === 'primary'
          ? '主力浏览器模式下，可能有远程调试授权弹窗，请点击“允许”后等待连接。'
          : '专用浏览器模式下通常不会有授权弹窗；若持续超时，请检查 dedicated profile 路径和启动参数是否一致。';
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return {
    ok: false,
    reusedExisting: false,
    restartedForModeSwitch,
    hint,
    reason: 'proxy_connect_timeout',
    logFile: path.join(os.tmpdir(), 'cdp-proxy.log'),
  };
}

function parseCliFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--browser' && argv[i + 1]) out.BROWSER_MODE = argv[++i];
    else if (argv[i] === '--browser-id' && argv[i + 1]) out.BROWSER_ID = argv[++i];
  }
  return out;
}

async function main() {
  const node = checkNode();
  const config = loadRuntimeConfig({ ...process.env, ...parseCliFlags(process.argv.slice(2)) });
  const runtime = await resolveRuntimeAvailability(config);

  if (!runtime.ok) {
    fail({
      node,
      provider: runtime.provider,
      proxyReady: false,
      ...runtime,
    });
  }

  config.provider = runtime.provider;
  config.browserMode = runtime.browser;
  config.browserId = runtime.browserId;
  config.dedicatedProfileDir = runtime.dedicatedProfileDir;

  const proxy = await ensureProxy(config);
  if (!proxy.ok) {
    fail({
      node,
      provider: runtime.provider,
      selectedMode: runtime.browser,
      browserId: runtime.browserId,
      dedicatedProfileDir: runtime.dedicatedProfileDir,
      port: runtime.port,
      availableModes: runtime.availableModes,
      selectedBecause: runtime.selectedBecause,
      proxyReady: false,
      proxy,
    });
  }

  const patternsDir = path.join(ROOT, 'references', 'site-patterns');
  let sitePatterns = [];
  try {
    sitePatterns = fs.readdirSync(patternsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''));
  } catch {}

  printJson({
    ok: true,
    node,
    provider: runtime.provider,
    availableModes: runtime.availableModes,
    selectedMode: runtime.browser,
    selectedBecause: runtime.selectedBecause,
    browserId: runtime.browserId,
    dedicatedProfileDir: runtime.dedicatedProfileDir,
    port: runtime.port,
    proxyReady: true,
    proxy,
    sitePatterns,
  });
}

try {
  await main();
} catch (error) {
  fail({
    reason: 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
    proxyReady: false,
  });
}
