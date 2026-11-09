// ダウンロード数の記録（scripts/update-download-stats.mjs）: 1時間に1つだけ記録する
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../scripts/update-download-stats.mjs')).href);

test('同じ時間（UTC）の記録があるかを判定する', async () => {
  const { hasSnapshotForHour } = await load();
  const snaps = [{ t: '2026-11-09T07:35:20.000Z', total: 10 }];
  assert.strictEqual(hasSnapshotForHour(snaps, '2026-11-09T07:52:01.000Z'), true);
  assert.strictEqual(hasSnapshotForHour(snaps, '2026-11-09T08:07:01.000Z'), false);
  assert.strictEqual(hasSnapshotForHour(undefined, '2026-11-09T08:07:01.000Z'), false);
});

test('同じ時間は上書きし、新しい時間は時刻順に足す', async () => {
  const { upsertHourlySnapshot } = await load();
  let snaps = [{ t: '2026-11-09T07:35:20.000Z', total: 10 }];
  snaps = upsertHourlySnapshot(snaps, '2026-11-09T07:52:00.000Z', 12);
  assert.deepStrictEqual(snaps, [{ t: '2026-11-09T07:52:00.000Z', total: 12 }]);
  snaps = upsertHourlySnapshot(snaps, '2026-11-09T08:07:00.000Z', 15);
  assert.strictEqual(snaps.length, 2);
  assert.strictEqual(snaps[1].total, 15);
});
