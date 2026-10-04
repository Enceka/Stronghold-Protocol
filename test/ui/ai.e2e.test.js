// Real WebSocket/server/browser integration. Uses an isolated headless browser profile, never the user's profile.
// SP_E2E=1 node --test test/ui/ai.e2e.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { startServer } from '../../server/index.js';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const firefox = '/Applications/Firefox.app/Contents/MacOS/firefox';
const executable = existsSync(chrome) ? chrome : firefox;
const enabled = process.env.SP_E2E === '1' && existsSync(executable);

test('AI assistant: recommend and apply, reject stale advice, save config, and start/stop autoplay', { skip: !enabled, timeout: 90000 }, async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, seedFn: () => 1 });
  const puppeteer = (await import('puppeteer-core')).default;
  let browser, page;
  try {
    browser = await puppeteer.launch({ browser: executable === firefox ? 'firefox' : 'chrome', executablePath: executable, headless: true,
      ...(executable === firefox ? {} : { args: ['--no-sandbox', '--mute-audio'] }) });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluateOnNewDocument(() => { localStorage.setItem('sp.name', 'AI测试'); sessionStorage.setItem('sp.entered', '1'); });
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online');
    await page.evaluate(async () => { await __SP__.net.request('room.create', { mode: 'solo', difficulty: 'FUNNY' }); await __SP__.net.request('room.start', {}); });
    await page.waitForSelector('[data-testid="ai-assistant-open"]', { visible: true });
    const clickText = async (text) => {
      const buttons = await page.$$('button');
      for (const b of buttons) if ((await b.evaluate((el) => el.textContent.trim())).includes(text)) { await b.click(); return; }
      throw new Error(`button missing: ${text}`);
    };
    await page.click('[data-testid="ai-assistant-open"]');
    await page.waitForSelector('[data-testid="ai-assistant"]', { visible: true });
    await clickText('获取建议');
    await page.waitForFunction(() => document.querySelector('.ai-assistant__advice b')?.textContent.includes('确认本局信息'));
    await clickText('执行这一步');
    await page.waitForFunction(() => __SP__.store.get().match.public?.phase === 'BAND_DRAFT');
    // The assistant persists across screen changes. Request advice for the current strategy turn.
    await new Promise((r) => setTimeout(r, 1100));
    await clickText('获取建议');
    await page.waitForFunction(() => document.querySelector('.ai-assistant__advice b')?.textContent.includes('选择策略'));
    await clickText('执行这一步');
    await page.waitForFunction(() => __SP__.store.get().match.public?.phase === 'PREP', { timeout: 15000 });
    await page.click('[data-testid="ai-assistant-open"]');
    await new Promise((r) => setTimeout(r, 1100));
    await clickText('获取建议');
    await page.waitForSelector('.ai-assistant__advice b');
    await page.evaluate(() => __SP__.net.request('g.freeze', {}));
    await page.waitForFunction(() => document.querySelector('.ai-assistant__advice b')?.textContent.includes('建议已过期'));
    const disabled = await page.$$eval('button', (bs) => bs.find((b) => b.textContent.includes('执行这一步'))?.disabled);
    assert.equal(disabled, true);
    await page.click('.ai-assistant summary');
    await page.$eval('#ai-config-json', (el) => { el.focus(); });
    await page.keyboard.down('Meta'); await page.keyboard.press('KeyA'); await page.keyboard.up('Meta');
    await page.keyboard.type('{"policy":"preferences","preferredBands":["band_bldsk"]}');
    await clickText('保存并应用到本局');
    await page.waitForFunction(() => __SP__.store.get().match.private?.aiConfig?.policy === 'preferences');
    // Phone-size modal remains inside the viewport and scrolls vertically.
    await page.setViewport({ width: 844, height: 390 });
    await new Promise((r) => setTimeout(r, 250));
    const bounds = await page.$eval('[data-testid="ai-assistant"]', (el) => { const r = el.closest('.modal__box')?.getBoundingClientRect() || el.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    assert.ok(bounds.left >= 0 && bounds.right <= 845, JSON.stringify(bounds));
    assert.ok(await page.$eval('.ai-assistant p', (el) => parseFloat(getComputedStyle(el).fontSize) >= 12));
    mkdirSync('test/e2e/out', { recursive: true });
    await page.screenshot({ path: 'test/e2e/out/ai-assistant-phone.png' });
    await page.setViewport({ width: 1280, height: 720 });
    await clickText('按当前配置托管');
    await page.waitForFunction(() => __SP__.store.get().match.public?.players.some((p) => p.autoplay));
    await clickText('返回模拟');
    await page.waitForFunction(() => __SP__.store.get().match.public?.players.every((p) => !p.autoplay));
    assert.deepEqual(errors, []);
  } catch (e) {
    if (page) {
      mkdirSync('test/e2e/out', { recursive: true });
      await page.screenshot({ path: 'test/e2e/out/ai-assistant-failed.png' });
      console.error(await page.evaluate(() => ({ assistant: document.querySelector('.ai-assistant')?.textContent, phase: globalThis.__SP__?.store.get().match.public?.phase })));
    }
    throw e;
  } finally { await browser?.close(); await server.close(); }
});
