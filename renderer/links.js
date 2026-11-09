// アプリの外へのリンク（リポジトリ・ライセンス・寄付先）。寄付先を変えるときはここを直す。
// サイト（docs/index.html）と .github/FUNDING.yml にも同じ寄付先を書いている（test/links.test.js で揃っているか確かめる）。
// レンダラ（<script>）とアプリ本体（require）の両方から使う
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Links = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const REPO_URL = 'https://github.com/kazuya83/worktree-kanban';
  const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
  const GITHUB_SPONSORS_USER = 'kazuya83';
  const KOFI_ID = 'kazuya83';
  // 寄付先（並びはボタンの並び）
  const SPONSORS = [
    { id: 'github', label: 'GitHub Sponsors', icon: 'heart', url: `https://github.com/sponsors/${GITHUB_SPONSORS_USER}` },
    { id: 'kofi', label: 'Ko-fi', icon: 'coffee', url: `https://ko-fi.com/${KOFI_ID}` },
  ];
  return { REPO_URL, LICENSE_URL, GITHUB_SPONSORS_USER, KOFI_ID, SPONSORS };
});
