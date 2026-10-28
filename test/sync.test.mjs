import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeSyncArea, createClock, createDevice, FakeDrive, visible, visibleTexts } from './fakes.mjs';

// 2 台の端末が同じ同期先を使う
async function pair(mode) {
  const clock = createClock();
  const sync = chromeSyncArea();
  const drive = new FakeDrive();
  const a = createDevice({ sync, drive, clock });
  const b = createDevice({ sync, drive, clock });
  for (const device of [a, b]) {
    await device.engine.ready();
    if (mode === 'drive') await device.local.set({ settings: { mode: 'drive' } });
  }
  return { a, b, clock, sync, drive };
}

for (const mode of ['chrome', 'drive']) {
  test(`[${mode}] 新しい端末は既存のメモをそのまま受け取り、空のメモが増えない`, async () => {
    const { a, b } = await pair(mode);
    const { ids } = await visible(a);
    await a.engine.edit(ids[0], 'こんにちは');
    assert.equal((await a.engine.sync()).state, 'ok');
    assert.equal((await b.engine.sync()).state, 'ok');
    assert.deepEqual(await visibleTexts(b), ['こんにちは', '', '']);
    assert.deepEqual((await visible(b)).ids, ids);
    await a.engine.sync();
    assert.deepEqual((await visible(a)).ids, ids);
  });

  test(`[${mode}] 編集・追加・削除が他の端末に伝わる`, async () => {
    const { a, b } = await pair(mode);
    await a.engine.sync();
    await b.engine.sync();
    const { ids } = await visible(b);
    await b.engine.edit(ids[1], 'B で書いた');
    const added = await b.engine.add();
    await b.engine.edit(added, '追加したメモ');
    await b.engine.remove(ids[2]);
    await b.engine.sync();
    await a.engine.sync();
    assert.deepEqual(await visibleTexts(a), ['', 'B で書いた', '追加したメモ']);
  });

  test(`[${mode}] 2 台で同時に追加したメモは両方残る`, async () => {
    const { a, b } = await pair(mode);
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.edit(await a.engine.add(), 'A の新規');
    await b.engine.edit(await b.engine.add(), 'B の新規');
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const textsA = await visibleTexts(a);
    assert.deepEqual(textsA, await visibleTexts(b));
    assert.ok(textsA.includes('A の新規') && textsA.includes('B の新規'));
    assert.equal(textsA.length, 5);
  });

  test(`[${mode}] 同じメモを両方で編集したら後の編集が残る`, async () => {
    const { a, b } = await pair(mode);
    // どちらも未編集のときは、どちらの初期メモが残るかは決まっていないので、揃うまで同期する
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const { ids } = await visible(a);
    assert.deepEqual((await visible(b)).ids, ids);
    await a.engine.edit(ids[0], '先');
    await b.engine.edit(ids[0], '後');
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    assert.equal((await visibleTexts(a))[0], '後');
    assert.equal((await visibleTexts(b))[0], '後');
  });

  test(`[${mode}] 他の端末で消されたメモは消える前にバックアップされる`, async () => {
    const { a, b } = await pair(mode);
    const { ids } = await visible(a);
    await a.engine.edit(ids[0], '大事なメモ');
    await a.engine.sync();
    await b.engine.sync();
    await b.engine.remove(ids[0]);
    await b.engine.sync();
    await a.engine.sync();
    assert.ok(!(await visibleTexts(a)).includes('大事なメモ'));
    const { backups } = await a.local.get('backups');
    assert.equal(backups[0].reason, 'sync');
    assert.equal(backups[0].memos[0].text, '大事なメモ');
  });
}

test('[chrome] 8KB を超える長いメモも分けて送られ、そのまま届く', async () => {
  const { a, b, sync } = await pair('chrome');
  const { ids } = await visible(a);
  const long = '日本語の長いメモです。😀\n'.repeat(1_200);
  await a.engine.edit(ids[0], long);
  await a.engine.sync();
  assert.ok([...sync.data.keys()].filter((key) => key.startsWith(`c:${ids[0]}:`)).length > 1);
  await b.engine.sync();
  assert.equal((await visibleTexts(b))[0], long);

  // 短くしたら余った断片が消える
  await a.engine.edit(ids[0], '短い');
  await a.engine.sync();
  assert.deepEqual([...sync.data.keys()].filter((key) => key.startsWith(`c:${ids[0]}:`)), [`c:${ids[0]}:0`]);
});

test('[chrome] 容量を超えるときは送らず、端末内のメモは残る', async () => {
  const { a, sync } = await pair('chrome');
  const { ids } = await visible(a);
  await a.engine.edit(ids[0], 'あ'.repeat(40_000));
  const status = await a.engine.sync();
  assert.equal(status.state, 'error');
  assert.match(status.message, /容量/);
  assert.equal((await visibleTexts(a))[0].length, 40_000);
  assert.equal(sync.data.size, 0);
});

test('[chrome] 一部の断片しか届いていないメモは取り込まず、上書きもしない', async () => {
  const { a, b, sync } = await pair('chrome');
  const { ids } = await visible(a);
  await a.engine.edit(ids[0], '古い内容');
  await a.engine.sync();
  await b.engine.sync();
  // 他の端末の書き込みが途中まで届いた状態を作る
  await sync.set({ [`h:${ids[0]}`]: { u: 9e15, n: 2 }, [`c:${ids[0]}:0`]: { u: 9e15, s: '新しい内容の前半' } });
  await b.engine.sync();
  assert.equal((await visibleTexts(b))[0], '古い内容');
  assert.deepEqual(sync.data.get(`h:${ids[0]}`), { u: 9e15, n: 2 });
  // 残りが届いたら取り込む
  await sync.set({ [`c:${ids[0]}:1`]: { u: 9e15, s: '後半' } });
  await b.engine.sync();
  assert.equal((await visibleTexts(b))[0], '新しい内容の前半後半');
});

test('[chrome] 自分の書き込みによる変更通知では同期し直さない', async () => {
  const { a, sync } = await pair('chrome');
  const { ids } = await visible(a);
  const seen = [];
  sync.listeners.push((changes) => seen.push(changes));
  await a.engine.edit(ids[0], 'x');
  await a.engine.sync();
  assert.ok(seen.length > 0);
  assert.ok(seen.every((changes) => a.engine.backends.chrome.isOwnChange(changes)));
  assert.equal(a.engine.backends.chrome.isOwnChange({ meta: { newValue: { v: 1, o: [], ou: 1 } } }), false);
});

test('[drive] 重複したファイルは統合して 1 つにまとめる', async () => {
  const { a, drive } = await pair('drive');
  drive.addFile(JSON.stringify({ order: ['aaaa'], orderUpdatedAt: 5, memos: { aaaa: { text: '1つ目のファイル', updatedAt: 5 } } }));
  drive.addFile(JSON.stringify({ order: ['bbbb'], orderUpdatedAt: 4, memos: { bbbb: { text: '2つ目のファイル', updatedAt: 4 } } }));
  assert.equal((await a.engine.sync()).state, 'ok');
  assert.deepEqual(await visibleTexts(a), ['1つ目のファイル', '2つ目のファイル']);
  assert.equal(drive.files.size, 1);
});

test('[drive] トークンの期限切れは 1 回だけ取り直して続ける', async () => {
  const { a, drive } = await pair('drive');
  drive.validTokens = new Set(['token-2']);
  a.auth.refreshTo = 'token-2';
  assert.equal((await a.engine.sync()).state, 'ok');
  assert.equal(a.auth.token, 'token-2');
});

test('[drive] 未接続なら「要ログイン」になり、メモは端末内に残る', async () => {
  const { a } = await pair('drive');
  const { ids } = await visible(a);
  await a.engine.edit(ids[0], '書いたもの');
  a.auth.token = null;
  const status = await a.engine.sync();
  assert.equal(status.state, 'auth');
  assert.equal((await visibleTexts(a))[0], '書いたもの');
  assert.equal((await a.local.get('dirty')).dirty, true);
});

test('[drive] 読めないファイルは上書きせずに止める', async () => {
  const { a, drive } = await pair('drive');
  const id = drive.addFile('{ 壊れた JSON');
  const status = await a.engine.sync();
  assert.equal(status.state, 'error');
  assert.equal(drive.files.get(id).content, '{ 壊れた JSON');
});

test('同期方式を切り替えると、移った先に今のメモが統合される', async () => {
  const { a, drive } = await pair('chrome');
  const { ids } = await visible(a);
  await a.engine.edit(ids[0], 'Chrome 同期で書いた');
  await a.engine.sync();
  assert.equal((await a.engine.setMode('drive')).state, 'ok');
  const [file] = drive.files.values();
  assert.match(file.content, /Chrome 同期で書いた/);
});

for (const mode of ['chrome', 'drive']) {
  test(`[${mode}] 並べ替えが他の端末に伝わる`, async () => {
    const { a, b } = await pair(mode);
    await a.engine.sync();
    await b.engine.sync();
    const { ids } = await visible(b);
    await b.engine.reorder([ids[1], ids[2], ids[0]]);
    await b.engine.sync();
    await a.engine.sync();
    assert.deepEqual((await visible(a)).ids, [ids[1], ids[2], ids[0]]);
  });

  test(`[${mode}] 同期前の編集が他の端末の編集で置き換わったら、バックアップとお知らせを残す`, async () => {
    const { a, b } = await pair(mode);
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const { ids } = await visible(a);
    await a.engine.edit(ids[0], '元の内容');
    await a.engine.sync();
    await b.engine.sync();
    // A はつながらない間に書き、その後 B が同じメモを書いて先に同期した
    await a.engine.edit(ids[0], '元の内容\nA で足した行');
    await b.engine.edit(ids[0], '元の内容\nB で足した行');
    await b.engine.sync();
    await a.engine.sync();
    assert.equal((await visibleTexts(a))[0], '元の内容\nB で足した行');
    const { backups, alert } = await a.local.get(['backups', 'alert']);
    assert.equal(backups[0].reason, 'conflict');
    assert.equal(backups[0].memos[0].text, '元の内容\nA で足した行');
    assert.deepEqual(alert.titles, ['元の内容']);
    // どのメモが重なったかと、どのバックアップかを覚えている
    assert.deepEqual(backups[0].conflicts, [ids[0]]);
    assert.deepEqual(alert.ids, [ids[0]]);
    assert.equal(alert.backupAt, backups[0].at);
    // 負けた方の内容を、新しいメモとして元のメモのすぐ後ろに戻せる
    const { memoId } = await a.engine.restoreBackupMemo(alert.backupAt, ids[0]);
    const after = await visible(a);
    assert.equal(after.ids[1], memoId);
    assert.equal((await visibleTexts(a))[1], '元の内容\nA で足した行');
    await assert.rejects(a.engine.restoreBackupMemo(alert.backupAt, 'nothere'), /見つかりません/);
    // B は自分の編集が残ったので、お知らせは出ない
    await b.engine.sync();
    assert.equal((await b.local.get('alert')).alert, undefined);
  });
}

test('同期済みのメモが他の端末で書き換わっても、お知らせは出さない', async () => {
  const { a, b } = await pair('drive');
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  const { ids } = await visible(a);
  await a.engine.edit(ids[0], 'A で書いた');
  await a.engine.sync();
  await b.engine.sync();
  await b.engine.edit(ids[0], 'B で書き直した');
  await b.engine.sync();
  await a.engine.sync();
  assert.equal((await visibleTexts(a))[0], 'B で書き直した');
  assert.equal((await a.local.get('alert')).alert, undefined);
});

test('同期方式を切り替えた直後は、置き換わりのお知らせを出さない', async () => {
  const { a, b } = await pair('chrome');
  await a.engine.sync();
  const { ids } = await visible(a);
  await b.local.set({ settings: { mode: 'drive' } });
  await b.engine.sync();
  await b.engine.edit((await visible(b)).ids[0], 'ドライブ側の内容');
  await b.engine.sync();
  await a.engine.edit(ids[0], 'Chrome 同期で書いた');
  await a.engine.sync();
  await a.engine.setMode('drive');
  assert.equal((await a.local.get('alert')).alert, undefined);
});

for (const mode of ['chrome', 'drive']) {
  test(`[${mode}] オフラインの間の編集が後から勝ったときは、他の端末の編集をバックアップに残す`, async () => {
    const { a, b } = await pair(mode);
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const { ids } = await visible(a);
    await a.engine.edit(ids[0], '元の内容');
    await a.engine.edit(ids[1], '関係ないメモ');
    await a.engine.sync();
    await b.engine.sync();
    // B が先に書いて送り、オフラインだった A がその後に（B の編集を見ないまま）書いた
    await b.engine.edit(ids[0], '元の内容\nB で足した行');
    await b.engine.sync();
    await a.engine.edit(ids[0], '元の内容\nA でオフライン中に足した行');
    await a.engine.sync();
    assert.equal((await visibleTexts(a))[0], '元の内容\nA でオフライン中に足した行');
    const { backups, alert } = await a.local.get(['backups', 'alert']);
    assert.equal(backups[0].reason, 'conflict');
    assert.deepEqual(backups[0].memos.map((m) => m.text), ['元の内容\nB で足した行', '関係ないメモ', '']);
    assert.deepEqual(alert.titles, ['元の内容']);
    await b.engine.sync();
    assert.equal((await visibleTexts(b))[0], '元の内容\nA でオフライン中に足した行');
  });

  test(`[${mode}] 他の端末で書き足されたメモを、それを見ないまま消したときも、書き足された内容をバックアップに残す`, async () => {
    const { a, b } = await pair(mode);
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const { ids } = await visible(a);
    await a.engine.edit(ids[0], 'A の内容');
    await a.engine.sync();
    await b.engine.sync();
    await b.engine.edit(ids[0], 'B が書き足した内容');
    await b.engine.sync();
    // A は B の編集を見ないまま、そのメモを消した
    await a.engine.remove(ids[0]);
    await a.engine.sync();
    assert.ok(!(await visibleTexts(a)).includes('B が書き足した内容'));
    const { backups } = await a.local.get('backups');
    assert.ok(backups.some((backup) => backup.reason === 'conflict' && backup.memos.some((m) => m.text === 'B が書き足した内容')));
  });
}
