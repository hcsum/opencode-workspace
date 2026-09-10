import { randomUUID } from 'node:crypto';

export class PlaywrightRuntime {
  constructor(config, session, browser) {
    this.config = config;
    this.session = session;
    this.browser = browser;
    this.context = browser.contexts()[0];
    this.targets = new Map();
    this.pageIds = new WeakMap();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await this.syncKnownPages();
    this.initialized = true;
  }

  async shutdown() {
    try { await this.browser.close(); } catch {}
    if (this.config.releaseBrowserbaseSession) {
      return await this.config.releaseBrowserbaseSession(this.session.id);
    }
    return { released: false, skipped: true, sessionId: this.session.id };
  }

  async health() {
    await this.init();
    const connected = this.browser.isConnected();
    return {
      provider: 'browserbase',
      browserMode: 'browserbase',
      connected,
      sessions: this.targets.size,
      chromePort: null,
      browserbaseSessionId: this.session.id,
      browserbaseDebugUrl: this.session.debugUrl,
    };
  }

  async syncKnownPages() {
    for (const page of this.context.pages()) {
      this.ensureTarget(page);
    }
  }

  ensureTarget(page) {
    if (this.pageIds.has(page)) return this.pageIds.get(page);
    const targetId = `t_${randomUUID()}`;
    this.pageIds.set(page, targetId);
    this.targets.set(targetId, page);
    page.on('close', () => {
      this.targets.delete(targetId);
      this.pageIds.delete(page);
    });
    return targetId;
  }

  getPage(targetId) {
    const page = this.targets.get(targetId);
    if (!page) {
      const error = new Error(`未知 target: ${targetId}`);
      error.statusCode = 404;
      throw error;
    }
    return page;
  }

  async listTargets() {
    await this.init();
    const result = [];
    for (const [targetId, page] of this.targets.entries()) {
      result.push({
        targetId,
        type: 'page',
        title: await page.title().catch(() => ''),
        url: page.url(),
        attached: true,
      });
    }
    return result;
  }

  async createTarget({ url = 'about:blank', background = true } = {}) {
    await this.init();
    const page = await this.context.newPage();
    const targetId = this.ensureTarget(page);
    if (url !== 'about:blank') {
      await page.goto(url, { waitUntil: 'load' }).catch(() => {});
      if (!background) await page.bringToFront().catch(() => {});
    }
    return { targetId };
  }

  async closeTarget(targetId) {
    const page = this.getPage(targetId);
    await page.close();
    return { success: true };
  }

  async navigate(targetId, url) {
    const page = this.getPage(targetId);
    const response = await page.goto(url, { waitUntil: 'load' });
    return { frameId: 'playwright', loaderId: '', errorText: response ? undefined : undefined };
  }

  async activate(targetId) {
    const page = this.getPage(targetId);
    await page.bringToFront().catch(() => {});
    return { ok: true };
  }

  async back(targetId) {
    const page = this.getPage(targetId);
    await page.goBack({ waitUntil: 'load' }).catch(() => {});
    return { ok: true };
  }

  async evaluate(targetId, expression) {
    const page = this.getPage(targetId);
    try {
      const value = await page.evaluate(async (expr) => {
        return await globalThis.eval(expr);
      }, expression);
      return { value };
    } catch (cause) {
      const error = new Error(cause instanceof Error ? cause.message : String(cause));
      error.statusCode = 400;
      throw error;
    }
  }

  async click(targetId, selector) {
    const page = this.getPage(targetId);
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click();
    const meta = await locator.evaluate((el) => ({ tag: el.tagName, text: (el.textContent || '').slice(0, 100) }));
    return { clicked: true, ...meta };
  }

  async clickAt(targetId, selector) {
    const page = this.getPage(targetId);
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox();
    if (!box) {
      const error = new Error(`未找到元素: ${selector}`);
      error.statusCode = 400;
      throw error;
    }
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    const meta = await locator.evaluate((el) => ({ tag: el.tagName, text: (el.textContent || '').slice(0, 100) }));
    return { clicked: true, x, y, ...meta };
  }

  async setFiles(targetId, selector, files) {
    const page = this.getPage(targetId);
    await page.locator(selector).first().setInputFiles(files);
    return { success: true, files: files.length };
  }

  async scroll(targetId, { y = 3000, direction = 'down' } = {}) {
    const page = this.getPage(targetId);
    let value;
    if (direction === 'top') value = await page.evaluate(() => { window.scrollTo(0, 0); return 'scrolled to top'; });
    else if (direction === 'bottom') value = await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); return 'scrolled to bottom'; });
    else if (direction === 'up') value = await page.evaluate((amount) => { window.scrollBy(0, -Math.abs(amount)); return `scrolled up ${Math.abs(amount)}px`; }, y);
    else value = await page.evaluate((amount) => { window.scrollBy(0, Math.abs(amount)); return `scrolled down ${Math.abs(amount)}px`; }, y);
    await page.waitForTimeout(800);
    return { value };
  }

  async screenshot(targetId, { filePath = null, format = 'png' } = {}) {
    const page = this.getPage(targetId);
    const buffer = await page.screenshot({ path: filePath || undefined, type: format === 'jpeg' ? 'jpeg' : 'png', quality: format === 'jpeg' ? 80 : undefined });
    return { buffer, filePath };
  }

  async info(targetId) {
    const page = this.getPage(targetId);
    return JSON.stringify({
      title: await page.title().catch(() => ''),
      url: page.url(),
      ready: await page.evaluate(() => document.readyState).catch(() => 'unknown'),
    });
  }
}
