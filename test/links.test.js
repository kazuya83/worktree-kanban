// 外へのリンク（リポジトリ・寄付先）と、メニューの About に足す寄付の項目
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Links = require('../renderer/links.js');
const { ICON_NAMES } = require('../renderer/icons.js');
const { aboutPanelOptions, sponsorMenuTemplate, installSponsorMenu } = require('../src/about-menu.js');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const tr = (k, vars) => (vars ? k.replace(/\{(\w+)\}/g, (m, x) => (x in vars ? vars[x] : m)) : k);

test('寄付先は GitHub Sponsors と Ko-fi の2つで、https のページ・あるアイコンを使う', () => {
  assert.deepStrictEqual(Links.SPONSORS.map((x) => x.id), ['github', 'kofi']);
  assert.strictEqual(Links.SPONSORS[0].url, `https://github.com/sponsors/${Links.GITHUB_SPONSORS_USER}`);
  assert.strictEqual(Links.SPONSORS[1].url, `https://ko-fi.com/${Links.KOFI_ID}`);
  for (const x of Links.SPONSORS) assert.ok(ICON_NAMES.includes(x.icon), x.icon);
});

test('FUNDING.yml とサイトのフッターの寄付先が links.js と揃っている', () => {
  const funding = read('.github/FUNDING.yml');
  assert.match(funding, new RegExp(`^github: ${Links.GITHUB_SPONSORS_USER}$`, 'm'));
  assert.match(funding, new RegExp(`^ko_fi: ${Links.KOFI_ID}$`, 'm'));
  const site = read('docs/index.html');
  const footer = site.slice(site.indexOf('<footer>'), site.indexOf('</footer>'));
  for (const x of Links.SPONSORS) assert.ok(footer.includes(`href="${x.url}"`), x.url);
  // 文言はどの言語にもある
  for (const lang of ['en', 'ja', 'es', 'fr', 'zh']) assert.match(site, new RegExp(`\\n      ${lang}: \\{[^\\n]*sponsor: '`), lang);
});

test('設定の「このアプリについて」に寄付のボタンがあり、押すと外のブラウザで開く', () => {
  const src = read('renderer/renderer.js');
  const html = src.slice(src.indexOf('function aboutSectionHtml()'), src.indexOf('function renderSettingsView()'));
  assert.match(html, /Links\.SPONSORS\.map/);
  assert.match(html, /data-about-url=/);
  assert.match(html, /api\.openExternal\(b\.dataset\.aboutUrl\)/);
  assert.match(src, /about: `\$\{aboutSectionHtml\(\)\}`,/);
  assert.match(src, /bindAboutSection\(\$\('settings-about'\)\)/);
  assert.match(read('renderer/index.html'), /<script src="links\.js"><\/script>\s*<script src="app-view\.js">/);
});

test('About パネルに寄付先を書く', () => {
  const o = aboutPanelOptions({ version: '1.2.3', tr });
  assert.strictEqual(o.applicationVersion, '1.2.3');
  for (const x of Links.SPONSORS) assert.ok(o.credits.includes(x.url), x.url);
  assert.strictEqual(o.website, Links.REPO_URL);
});

// Electron の Menu / MenuItem の偽物
function fakeMenu(template) {
  class MenuItem {
    constructor(o) {
      Object.assign(this, o);
      if (o.submenu) this.submenu = makeSub(o.submenu);
    }
  }
  function makeSub(items) {
    const sub = { items: items.map((i) => (i instanceof MenuItem ? i : new MenuItem(i))) };
    sub.insert = (pos, item) => sub.items.splice(pos, 0, item);
    sub.getMenuItemById = (id) => sub.items.find((i) => i.id === id) || null;
    return sub;
  }
  const menu = { items: template.map((t) => new MenuItem(t)) };
  const Menu = { set: 0, getApplicationMenu: () => menu, setApplicationMenu: (m) => { assert.strictEqual(m, menu); Menu.set++; } };
  return { Menu, MenuItem, menu };
}
const fakeApp = () => ({ panel: null, getVersion: () => '9.9.9', setAboutPanelOptions(o) { this.panel = o; } });

test('Mac: アプリ名のメニューの About のすぐ下に寄付の項目を足し、押すとそのページを開く。2回目は足さない', () => {
  const { Menu, MenuItem, menu } = fakeMenu([{ role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }, { role: 'help', submenu: [] }]);
  const opened = [];
  const app = fakeApp();
  assert.strictEqual(installSponsorMenu({ app, Menu, MenuItem, tr, openUrl: (u) => opened.push(u), platform: 'darwin' }), true);
  assert.strictEqual(app.panel.applicationVersion, '9.9.9');
  const sub = menu.items[0].submenu.items;
  assert.deepStrictEqual(sub.map((i) => i.role || i.type || i.id), ['about', 'separator', 'sponsor-github', 'sponsor-kofi', 'separator', 'quit']);
  assert.strictEqual(sub[2].label, 'GitHub Sponsors で支援する…');
  sub[3].click();
  assert.deepStrictEqual(opened, [Links.SPONSORS[1].url]);
  assert.strictEqual(Menu.set, 1);
  assert.strictEqual(installSponsorMenu({ app, Menu, MenuItem, tr, openUrl: () => {}, platform: 'darwin' }), false);
  assert.strictEqual(menu.items[1].submenu.items.length, 0);
});

test('Windows・Linux: Help のメニューに足す。メニューがなければ何もしない', () => {
  const { Menu, MenuItem, menu } = fakeMenu([{ role: 'fileMenu', submenu: [{ role: 'quit' }] }, { role: 'help', submenu: [{ label: 'Learn More' }] }]);
  assert.strictEqual(installSponsorMenu({ app: fakeApp(), Menu, MenuItem, tr, openUrl: () => {}, platform: 'win32' }), true);
  assert.deepStrictEqual(menu.items[1].submenu.items.map((i) => i.label || i.type), ['Learn More', 'separator', 'GitHub Sponsors で支援する…', 'Ko-fi で支援する…']);
  assert.strictEqual(installSponsorMenu({ app: fakeApp(), Menu: { getApplicationMenu: () => null }, MenuItem, tr, openUrl: () => {}, platform: 'linux' }), false);
});

test('メニューの項目の文言には訳がある', () => {
  const I18n = require('../renderer/i18n.js');
  for (const key of ['{v1} で支援する…', '開発を支援する', 'このアプリ', 'このアプリについて']) for (const lang of ['en', 'es', 'fr', 'zh']) assert.ok(I18n.has(key, lang), `${key} (${lang})`);
  assert.deepStrictEqual(sponsorMenuTemplate({ tr, openUrl: () => {} }).map((t) => t.id), ['sponsor-github', 'sponsor-kofi']);
});
