// トークンなどの秘密を、OS の安全な保存先（Electron の safeStorage）の鍵で暗号化して userData/secrets.json に保存する。
// - 平文では保存しない。safeStorage が使えなければ、保存せずにエラーにする
// - ファイルは board.json と別にする（board.json の中身は画面と遠隔のクライアントに渡るため）
// - 値を読めるのは get だけ。get はメインプロセスの中で、接続先へ送る直前にだけ呼ぶ。
//   画面・遠隔のクライアント・ログ・エージェントの環境変数には渡さない（渡すのは has の結果だけ）
// - 常駐モードでは、環境変数と本人しか読めないファイルからも読む（overrides。src/headless.js）。
//   OS の安全な保存先が無いサーバーでも動かせるようにするため。こちらが保存したものより先に使われる
const fs = require('fs');
const path = require('path');
const { tr } = require('../renderer/i18n');

const VERSION = 1;

class SecretStore {
  /**
   * @param {{ file: string, safeStorage: object, overrides?: { has(name): boolean, get(name): string } }} p
   *   safeStorage は Electron のもの（テストでは差し替える）。overrides は常駐モードの環境変数とファイル
   */
  constructor({ file, safeStorage, overrides = null }) {
    this.file = file;
    this.safeStorage = safeStorage;
    this.overrides = overrides;
    this.items = null;
  }

  // 暗号化できるか。Linux で鍵の保管先が無いときの basic_text は、固定の鍵で隠すだけなので使わない
  available() {
    const s = this.safeStorage;
    if (!s || !s.isEncryptionAvailable()) return false;
    return !(typeof s.getSelectedStorageBackend === 'function' && s.getSelectedStorageBackend() === 'basic_text');
  }

  load() {
    if (this.items) return this.items;
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* まだ無い・壊れている: 何も保存していないものとして扱う */
    }
    this.items = raw && raw.items && typeof raw.items === 'object' ? { ...raw.items } : {};
    return this.items;
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, items: this.items }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  has(name) {
    if (this.overrides && this.overrides.has(name)) return true;
    return this.stored(name);
  }

  // 暗号化して保存したものがあるか（環境変数・ファイルの分は見ない）
  stored(name) {
    return Object.prototype.hasOwnProperty.call(this.load(), name);
  }

  set(name, value) {
    const text = String(value == null ? '' : value);
    if (!text) throw new Error(tr('保存する値が空です'));
    if (!this.available()) {
      if (this.overrides) throw new Error(tr('このマシンでは OS の安全な保存先を使えないので、トークンを保存できません（平文では保存しません）。常駐モードでは、環境変数か、本人しか読めないトークンのファイルに書いてください'));
      throw new Error(tr('このマシンでは OS の安全な保存先を使えないので、トークンを保存できません（平文では保存しません）。Linux では GNOME Keyring や KWallet などを使えるようにしてください'));
    }
    this.load()[name] = this.safeStorage.encryptString(text).toString('base64');
    this.write();
  }

  // 値を読む。無ければ ''
  get(name) {
    if (this.overrides && this.overrides.has(name)) return this.overrides.get(name);
    if (!this.stored(name)) return '';
    if (!this.available()) throw new Error(tr('このマシンでは OS の安全な保存先を使えないので、保存したトークンを読めません'));
    try {
      return this.safeStorage.decryptString(Buffer.from(this.items[name], 'base64'));
    } catch {
      throw new Error(tr('保存したトークンを読めませんでした。設定の「連携」で入れ直してください'));
    }
  }

  // 消すのは暗号化して保存したものだけ（環境変数・ファイルの分は、そちらで消してもらう）
  delete(name) {
    if (!this.stored(name)) return false;
    delete this.items[name];
    this.write();
    return true;
  }
}

module.exports = { SecretStore };
