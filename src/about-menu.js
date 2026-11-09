// アプリのメニューの「About」まわり: About パネルに寄付先を書き、メニューに寄付のページを開く項目を足す。
// Mac はアプリ名のメニュー（「About Worktree Kanban」の下）、ほかの OS は「Help」のメニューに足す。
// リンク先は renderer/links.js にまとめる
const Links = require('../renderer/links');

// 役割（role）は大文字・小文字を区別しない（既定のメニューは appMenu、ほかは appmenu と書くこともある）
const hasRole = (item, role) => String((item && item.role) || '').toLowerCase() === role;

// About パネル（Mac の「About Worktree Kanban」・Linux の About）に出す内容
function aboutPanelOptions({ version, tr }) {
  return {
    applicationName: 'Worktree Kanban',
    applicationVersion: version,
    version: '',
    credits: `${tr('開発を支援する')}\n${Links.SPONSORS.map((x) => `${x.label}: ${x.url}`).join('\n')}`,
    website: Links.REPO_URL,
  };
}

// メニューに足す項目（click は openUrl(url) を呼ぶ）
function sponsorMenuTemplate({ tr, openUrl }) {
  return Links.SPONSORS.map((x) => ({ id: `sponsor-${x.id}`, label: tr('{v1} で支援する…', { v1: x.label }), click: () => openUrl(x.url) }));
}

// いまのメニュー（既定のメニュー）に寄付の項目を足す。入れる先のメニューがなければ何もしない
function installSponsorMenu({ app, Menu, MenuItem, tr, openUrl, platform = process.platform }) {
  try {
    app.setAboutPanelOptions(aboutPanelOptions({ version: app.getVersion(), tr }));
  } catch {}
  const menu = Menu.getApplicationMenu();
  if (!menu) return false;
  const target = platform === 'darwin' ? menu.items.find((m) => hasRole(m, 'appmenu')) || menu.items[0] : menu.items.find((m) => hasRole(m, 'help'));
  const sub = target && target.submenu;
  if (!sub || sub.getMenuItemById('sponsor-github')) return false;
  const items = sponsorMenuTemplate({ tr, openUrl }).map((t) => new MenuItem(t));
  const aboutAt = sub.items.findIndex((m) => hasRole(m, 'about'));
  let at = aboutAt >= 0 ? aboutAt + 1 : sub.items.length;
  sub.insert(at++, new MenuItem({ type: 'separator' }));
  for (const it of items) sub.insert(at++, it);
  Menu.setApplicationMenu(menu);
  return true;
}

module.exports = { aboutPanelOptions, sponsorMenuTemplate, installSponsorMenu };
