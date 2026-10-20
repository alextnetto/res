// Runs the page scripts in headless Chromium against tests/fixture.html.
// Requires Playwright: `npm install`, or PLAYWRIGHT_MODULE=/path/to/node_modules/playwright.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pageDir = join(here, '..', 'skills', 'reverse-engineering-saas', 'scripts', 'page');
const script = (name) => readFileSync(join(pageDir, name), 'utf8');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const TASK = {
  id: '86abc1234',
  name: 'Secret task name',
  status: 'in progress',
  category: 'VIP Maria Souza',
  type: 'Lead from maria@cliente.com.br',
  due_date: 1791945176083,
  created: '2026-10-15T10:00:00Z',
  assignees: [{ id: 1, email: 'maria@cliente.com.br', color: '#ff00aa' }],
  custom_fields: [],
};

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('http://fixture.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: readFileSync(join(here, 'fixture.html'), 'utf8') });
    if (url.pathname.startsWith('/api/v2/tasks/')) return route.fulfill({ json: TASK });
    if (url.pathname === '/graphql') return route.fulfill({ json: { data: { updateTask: { id: '86abc1234', status: 'done' } } } });
    if (url.pathname.startsWith('/api/v2/lists/')) return route.fulfill({ json: { tasks: [TASK, { ...TASK, id: '86abc9999', status: 'done' }] } });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.routeWebSocket('ws://fixture.test/ws', (socket) => {
    socket.onMessage(() => socket.send(JSON.stringify({ type: 'task_updated', task: { id: '86abc1234', status: 'done', name: 'Secret task name' } })));
  });
  await page.goto('http://fixture.test/');
});

after(async () => {
  await browser?.close();
});

test('inventory finds components, test IDs, routes and storage key names', async () => {
  const result = await page.evaluate(script('inventory.js'));
  const tags = Object.fromEntries(result.components.customElements.map((entry) => [entry.name, entry.count]));
  assert.equal(tags['app-task-card'], 3);
  assert.ok(result.components.testIds.some((entry) => entry.name === 'data-testid=task-card' && entry.count === 3));
  const routes = Object.fromEntries(result.routes.map((entry) => [entry.name, entry.count]));
  assert.equal(routes['/app/:id/board'], 2);
  assert.equal(routes['/t/:id'], 1);
  assert.equal(routes['/settings'], 1);
  assert.ok(!('/help' in routes), 'external links are excluded');
  assert.ok(result.storageKeys.localStorage.includes('cu_view_state'));
  assert.ok(!JSON.stringify(result).includes('secret-local-value'), 'storage values never leave the page');
  assert.ok(result.accessibility.unnamedControls.some((path) => path.includes('icon-btn')));
  assert.ok(result.components.testIds.some((entry) => entry.name === 'data-testid=(redacted)'), 'test IDs with spaces are redacted');
  assert.ok(result.storageKeys.localStorage.includes('user.:id.prefs'), 'digit runs in storage keys become :id');
  const text = JSON.stringify(result);
  for (const secret of ['Maria', '4471', '123456']) assert.ok(!text.includes(secret), `value leaked: ${secret}`);
  assert.equal(result.accessibility.landmarks.find((entry) => entry.name === 'nav').count, 1);
  assert.deepEqual(await page.evaluate(() => typeof window.__re.inventory), 'function');
});

test('tokens maps computed values back to CSS variables', async () => {
  const result = await page.evaluate(script('tokens.js'));
  const primary = result.variables.list.find((variable) => variable.name === '--color-primary');
  assert.equal(primary.color, 'rgb(123, 104, 238)');
  const background = result.colors.find((entry) => entry.value === 'rgb(123, 104, 238)');
  assert.ok(background.background >= 1);
  assert.ok(background.variables.includes('--color-primary'));
  const radius = result.radius.find((entry) => entry.value === '8px');
  assert.ok(radius.variables.includes('--radius-md'));
  assert.ok(result.variables.list.some((variable) => variable.name === '--color-bg'), 'variables from theme selectors are listed');
  assert.ok(result.motion.some((entry) => entry.value.startsWith('transition') && entry.value.includes('0.12s')));
  const element = await page.evaluate(() => window.__re.tokens.element('#save'));
  assert.equal(element.style.backgroundColor, 'rgb(123, 104, 238)');
  assert.equal(element.style.borderTopLeftRadius, '8px');
});

test('api-shapes records endpoint templates and shapes without values', async () => {
  await page.evaluate(script('api-shapes.js'));
  await page.evaluate(() => window.__re.api.clear());
  await page.evaluate(() => window.runActions());
  await page.waitForFunction(() => window.__re.api.count() >= 5);
  const entries = await page.evaluate(() => window.__re.api.dump());
  const byUrl = Object.fromEntries(entries.map((entry) => [`${entry.call} ${entry.url}${entry.operation ? ` ${entry.operation}` : ''}`, entry]));

  const task = byUrl['GET /api/v2/tasks/:id?include&page'];
  assert.ok(task, `task endpoint missing: ${Object.keys(byUrl).join(', ')}`);
  assert.equal(task.response.due_date, 'number<epoch-ms>');
  assert.equal(task.response.created, 'string<iso-date>');
  assert.equal(task.response.assignees[0].email, 'string<email>');
  assert.equal(task.response.assignees[0].color, 'string<hex-color>');
  assert.deepEqual(task.enumSamples['response.status'], ['in progress']);
  assert.equal(task.enumSamples['response.category'], undefined, 'category values are not sampled');
  assert.equal(task.enumSamples['response.type'], undefined, 'values with an email are not sampled');

  const graph = byUrl['POST /graphql UpdateTask'];
  assert.ok(graph, 'graphql operation missing');
  assert.deepEqual(graph.request, { id: 'string', name: 'string' });

  const list = byUrl['GET /api/v2/lists/:id/tasks'];
  assert.ok(list, 'XHR endpoint missing');
  assert.deepEqual(list.enumSamples['response.tasks[].status'].sort(), ['done', 'in progress']);

  assert.ok(byUrl['WS-out ws://fixture.test/ws subscribe'], 'outgoing socket frame missing');
  assert.ok(byUrl['WS-in ws://fixture.test/ws task_updated'], 'incoming socket frame missing');

  const text = JSON.stringify(entries);
  for (const secret of ['Secret task name', 'maria@cliente.com.br', 'Private name', '86abc1234', '1791945176083', 'Maria Souza', '900000000001']) {
    assert.ok(!text.includes(secret), `value leaked: ${secret}`);
  }
  await page.evaluate(() => {
    window.__re.api.clear();
    window.__re.api.enumSamples = false;
  });
  await page.evaluate(() => fetch('/api/v2/tasks/86abc1234'));
  await page.waitForFunction(() => window.__re.api.count() >= 1);
  const quiet = await page.evaluate(() => window.__re.api.dump());
  assert.deepEqual(quiet[0].enumSamples, {}, 'enumSamples = false keeps no values');
  await page.evaluate(() => window.__re.api.uninstall());
  assert.equal(await page.evaluate(() => window.__re.api), undefined);
});

test('mask blurs personal data and clear removes it', async () => {
  const result = await page.evaluate(script('mask.js'));
  assert.ok(result.byReason.email >= 1);
  assert.ok(result.byReason.phone >= 1);
  assert.ok(result.byReason.money >= 1);
  assert.equal(result.byReason.avatar, 1);
  const filter = await page.evaluate(() => getComputedStyle(document.querySelector('.contact')).filter);
  assert.match(filter, /blur/);
  const dateMasked = await page.evaluate(() => document.querySelector('.date').classList.contains('__re-masked'));
  assert.equal(dateMasked, false, 'ISO dates are not phone numbers');
  const named = await page.evaluate(() => window.__re.mask.apply({ names: ['Review PR'] }));
  assert.ok(named.byReason.name1 >= 1);
  await page.evaluate(() => window.__re.mask.clear());
  assert.equal(await page.evaluate(() => document.querySelectorAll('.__re-masked').length), 0);
});

test('mask rules cover elements rendered later, and placeholders', async () => {
  await page.evaluate(script('mask.js'));
  const result = await page.evaluate(() => {
    const field = document.createElement('input');
    field.id = 'owner';
    field.placeholder = 'maria@cliente.com.br';
    document.querySelector('main').append(field);
    return window.__re.mask.apply({ selectors: ['.popover', '..bad'] });
  });
  assert.equal(result.byReason['placeholder email'], 1);
  assert.deepEqual(result.invalidSelectors, ['..bad']);
  assert.deepEqual(result.rules, { selectors: 1, placeholders: false });
  const placeholderColor = (id) => page.evaluate((target) => getComputedStyle(document.getElementById(target), '::placeholder').color, id);
  assert.equal(await placeholderColor('owner'), 'rgba(0, 0, 0, 0)');

  // The .popover rule from the first call stays; placeholders: true adds a rule for every placeholder.
  await page.evaluate(() => window.__re.mask.apply({ placeholders: true }));
  const popoverFilter = await page.evaluate(() => {
    const popover = document.createElement('div');
    popover.className = 'popover';
    popover.textContent = 'Lost reason: [customer] churned';
    const later = document.createElement('input');
    later.id = 'later';
    later.placeholder = 'Activity type: Visit';
    document.body.append(popover, later);
    return getComputedStyle(popover).filter;
  });
  assert.match(popoverFilter, /blur/, 'a popover rendered after apply() is blurred');
  assert.equal(await placeholderColor('later'), 'rgba(0, 0, 0, 0)');

  await page.evaluate(() => window.__re.mask.clear());
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.popover')).filter), 'none');
  assert.notEqual(await placeholderColor('later'), 'rgba(0, 0, 0, 0)');
  assert.deepEqual(await page.evaluate(() => window.__re.mask.rules), { selectors: [], placeholders: false });
  await page.evaluate(() => document.querySelectorAll('#owner, #later, .popover').forEach((element) => element.remove()));
});

test('mask watch covers new text, names, avatars and field edits and stops cleanly', async () => {
  await page.evaluate(script('mask.js'));
  try {
    const result = await page.evaluate(() => {
      window.__re.mask.clear();
      return window.__re.mask.watch({ names: ['Private Watch Name'] });
    });
    assert.equal(result.watching, true);
    assert.ok(!JSON.stringify(result).includes('Private Watch Name'));
    await page.evaluate(() => {
      const host = document.createElement('section');
      host.id = 'watch-fixture';
      host.innerHTML = '<p id="watch-email">initial</p><p id="watch-name">Private Watch Name</p><input id="watch-field"><img id="watch-avatar" class="avatar" width="32" height="32">';
      document.body.append(host);
      document.getElementById('watch-email').firstChild.nodeValue = 'synthetic@example.test';
    });
    await page.waitForFunction(() => ['watch-email', 'watch-name', 'watch-avatar'].every((id) => document.getElementById(id).classList.contains('__re-masked')));
    await page.evaluate(() => {
      const field = document.getElementById('watch-field');
      field.value = 'synthetic@example.test';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.setAttribute('placeholder', 'synthetic@example.test');
    });
    await page.waitForFunction(() => document.getElementById('watch-field').classList.contains('__re-masked-placeholder'));
    assert.equal(await page.locator('#watch-field').evaluate((field) => getComputedStyle(field).filter), 'blur(6px)');
    const output = await page.evaluate(() => window.__re.last);
    for (const secret of ['Private Watch Name', 'synthetic@example.test']) assert.ok(!JSON.stringify(output).includes(secret));
    await page.evaluate(() => {
      window.__re.mask.clear();
      window.__re.mask.watch({ avatars: false });
    });
    assert.equal(await page.locator('#watch-avatar').evaluate((element) => element.classList.contains('__re-masked')), false);
    await page.evaluate(() => {
      window.__re.mask.clear();
      const late = document.createElement('p');
      late.id = 'watch-late';
      late.textContent = 'later@example.test';
      document.getElementById('watch-fixture').append(late);
    });
    // A browser task boundary lets any incorrectly retained observer run.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(await page.locator('#watch-late').evaluate((element) => element.classList.contains('__re-masked')), false);
  } finally {
    await page.evaluate(() => {
      window.__re.mask.clear();
      document.getElementById('watch-fixture')?.remove();
    });
  }
});

test('mask watch replacement, stop and reinstallation leave no stale observer', async () => {
  await page.evaluate(script('mask.js'));
  try {
    await page.evaluate(() => {
      window.__re.mask.clear();
      window.__re.mask.watch({ names: ['Old private name'] });
      window.__re.mask.watch({ names: ['New private name'] });
      const host = document.createElement('section');
      host.id = 'watch-lifecycle';
      host.innerHTML = '<p id="old-name">Old private name</p><p id="new-name">New private name</p>';
      document.body.append(host);
    });
    await page.waitForFunction(() => document.getElementById('new-name').classList.contains('__re-masked'));
    assert.equal(await page.locator('#old-name').evaluate((element) => element.classList.contains('__re-masked')), false);
    const stopped = await page.evaluate(() => window.__re.mask.stop());
    assert.deepEqual(stopped, { watching: false });
    assert.equal(await page.locator('#new-name').evaluate((element) => element.classList.contains('__re-masked')), true);
    await page.evaluate(() => {
      document.getElementById('old-name').textContent = 'New private name';
    });
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(await page.locator('#old-name').evaluate((element) => element.classList.contains('__re-masked')), false);
    await page.evaluate(() => window.__re.mask.watch({ names: ['Reinstalled private name'] }));
    await page.evaluate(script('mask.js'));
    await page.evaluate(() => {
      document.getElementById('old-name').textContent = 'Reinstalled private name';
    });
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(await page.locator('#old-name').evaluate((element) => element.classList.contains('__re-masked')), false);
  } finally {
    await page.evaluate(() => {
      window.__re.mask.clear();
      document.getElementById('watch-lifecycle')?.remove();
    });
  }
});

test('annotate outlines regions and reports missing selectors', async () => {
  await page.evaluate(script('annotate.js'));
  const result = await page.evaluate(() => window.__re.annotate(['header', 'main', '.missing']));
  assert.deepEqual(result.map((entry) => entry.found), [true, true, false]);
  assert.deepEqual(result.filter((entry) => entry.found).map((entry) => entry.n), [1, 2]);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#__re-annotate > div').length), 4);
  const landmarks = await page.evaluate(() => window.__re.annotate());
  assert.ok(landmarks.filter((entry) => entry.found).length >= 3);
  await page.evaluate(() => window.__re.annotate.clear());
  assert.equal(await page.evaluate(() => document.getElementById('__re-annotate')), null);
});
