import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSensitive,
  hasSecret,
  isCardNumber,
  isMyNumber,
  maskSensitive,
  sensitiveHint,
  summarizeSensitive,
} from '../extension/lib/sensitive.js';

const kinds = (text) => findSensitive(text).map((found) => `${found.kind}:${found.value}`);
const none = (text) => assert.deepEqual(findSensitive(text), [], text);

test('決まった頭の文字のキーとトークンを見つけ、どのサービスでも <API_KEY> で伏せる', () => {
  const anthropic = 'sk-ant-api03-AbCdEf1234567890_xyzXYZ-abcdefghij';
  const google = `AIza${'Sy0123456789abcdefghijklmnopqrstuvw'}`;
  const text = [
    `ANTHROPIC_API_KEY=${anthropic}`,
    'OPENAI_API_KEY="sk-proj-1234567890abcdefABCDEF1234"',
    'token: ghp_1234567890abcdefghijABCDEFGHIJ123456',
    'aws AKIAIOSFODNN7EXAMPLE で',
    `url?key=${google}`,
    'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ].join('\n');
  assert.equal(
    maskSensitive(text),
    [
      'ANTHROPIC_API_KEY=<API_KEY>',
      'OPENAI_API_KEY="<API_KEY_2>"',
      'token: <API_KEY_3>',
      'aws <API_KEY_4> で',
      'url?key=<API_KEY_5>',
      '<API_KEY_6>',
      '<API_KEY_7>',
    ].join('\n'),
  );
  assert.ok(findSensitive(text).every((found) => found.kind === 'apiKey'));
  // 「sk-」で始まっても、数字の無い単語のつながりはキーとみなさない
  none('branch sk-this-is-a-long-branch-name-here');
});

test('秘密鍵は始まりから終わりまでをまとめて伏せる', () => {
  const text = '鍵\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n次の行';
  assert.equal(maskSensitive(text), '鍵\n<PRIVATE_KEY>\n次の行');
  assert.equal(sensitiveHint(findSensitive(text)[0]), 'BEGIN OPENSSH PRIVATE KEY');
});

test('パスワードは書き方の名前と一緒に見つけ、どれも <PASSWORD> で伏せる', () => {
  assert.equal(maskSensitive('DB_PASSWORD=hunter2'), 'DB_PASSWORD=<PASSWORD>');
  assert.equal(maskSensitive('password: "s3cr3t!"'), 'password: "<PASSWORD>"');
  assert.equal(maskSensitive('PW: abc123'), 'PW: <PASSWORD>');
  assert.equal(maskSensitive('pin: 1234'), 'pin: <PASSWORD>');
  assert.equal(maskSensitive('postgres://admin:hunter2@db.mycorp.co.jp:5432/app'), 'postgres://admin:<PASSWORD>@db.mycorp.co.jp:5432/app');
  assert.equal(maskSensitive('curl https://api.example.jp/v1?api_key=abcd1234efgh&x=1'), 'curl https://api.example.jp/v1?api_key=<API_KEY>&x=1');
  assert.equal(maskSensitive('Authorization: Bearer abc123def456ghi789jkl'), 'Authorization: Bearer <API_KEY>');
  assert.equal(maskSensitive('"clientSecret": "Zx81-aa9Q"'), '"clientSecret": "<API_KEY>"');
  // 日本語の目印（全角のコロンや数字でも）
  assert.equal(maskSensitive('パスワード：abc12345'), 'パスワード：<PASSWORD>');
  assert.equal(maskSensitive('パスワードは「Xy9!pass」です'), 'パスワードは「<PASSWORD>」です');
  assert.equal(maskSensitive('暗証番号 ４８２９'), '暗証番号 <PASSWORD>');
});

test('.env の英字と数字が混ざった値・日本語の目印・新しいキーの形も見つける', () => {
  const token = 'Xa9fK2mQ7rT1vB8nL4pW6sD3hJ5kG0cZ2eR9yU1i';
  // 引用符の無い値でも、大文字と小文字と数字がばらばらに並ぶ長い値は、変数名ではなくキー
  assert.equal(maskSensitive(`CLOUDFLARE_API_TOKEN=${token}`), 'CLOUDFLARE_API_TOKEN=<API_KEY>');
  assert.equal(maskSensitive(`//registry.npmjs.org/:_authToken=${token}`), '//registry.npmjs.org/:_authToken=<API_KEY>');
  assert.equal(maskSensitive(`    token: ${token}`), '    token: <API_KEY>');
  // 日本語の目印
  assert.equal(maskSensitive(`トークン：${token}`), 'トークン：<API_KEY>');
  assert.equal(maskSensitive(`APIキーは ${token} です`), 'APIキーは <API_KEY> です');
  assert.equal(maskSensitive(`クライアントシークレット: ${token}`), 'クライアントシークレット: <API_KEY>');
  assert.equal(sensitiveHint(findSensitive(`アクセスキー ${token}`)[0]), '「アクセスキー」の後ろ');
  // 頭の文字が決まったキー
  for (const key of [
    `gsk_${token}abcd`, `xai-${token}abcd`, `pplx-${token}abcd`, `r8_${token}`, `lin_api_${token}`, `ATATT3xFfGF0${token}`,
    `PMAK-${'a1b2c3'.repeat(4)}-${'d4e5f6'.repeat(5)}abcd`, `sntrys_${token}abcd`, `dapi${'a1b2'.repeat(8)}`, `hvs.${token}`,
    `sb_secret_${token}`, `re_Ab12Cd34_${token}`, `https://contoso.webhook.office.com/webhookb2/a1b2@c3d4/IncomingWebhook/${'a1b2'.repeat(8)}/e5f6`,
  ]) {
    assert.equal(maskSensitive(`key ${key} end`), 'key <API_KEY> end', key);
  }
  // curl -u・Docker の auth・ログイン後に戻る URL の code・PuTTY の鍵
  assert.equal(maskSensitive('curl -u admin:Hunter2pass https://api.example.co.jp/'), 'curl -u admin:<PASSWORD> https://api.example.co.jp/');
  assert.equal(maskSensitive('"auth": "dGFybzpIdW50ZXIycGFzcw=="'), '"auth": "<PASSWORD>"');
  assert.equal(maskSensitive(`https://app.example.co.jp/callback?code=4/0Ab${token}&state=x`), 'https://app.example.co.jp/callback?code=<API_KEY>&state=x');
  const putty = `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\n${token}\nPrivate-MAC: ${'ab12'.repeat(8)}`;
  assert.equal(maskSensitive(`鍵\n${putty}\n次の行`), '鍵\n<PRIVATE_KEY>\n次の行');
  assert.equal(sensitiveHint(findSensitive(putty)[0]), 'PuTTY-User-Key-File-3');
});

test('キーらしく見えても、説明文・プログラムの名前・ほかのコマンドは見つけない', () => {
  none('トークンの上限は 4096 です');
  none('APIキーは OPENAI_API_KEY に入れる');
  none('アクセストークンの有効期限は1時間');
  none('token = generateTokenV2ForUser1234');
  none('secret = base64EncodedValue123');
  none('git push -u origin main');
  none('docker run -u 1000:1000 node');
  none('curl -u $USER:$TOKEN https://api.example.co.jp/');
  none('https://example.co.jp/list?code=ABC&page=2');
  none('re_render_component_v2_with_extra_props');
  none('"auth": true');
  none('commit 7659deec2e4f9933861cdeb3d18e95edf67f1d07');
});

test('パスワードという言葉があるだけのところは見つけない', () => {
  none('パスワードは8文字以上にしてください');
  none('パスワードを変更しました');
  none('パスワード: ********');
  none('パスワード：https://example.com/reset');
  // プログラムの式・型・例・環境変数から読むもの
  none('const token = newToken;');
  none('password: string;');
  none('password = getpass()');
  none('apiKey: process.env.OPENAI_API_KEY,');
  none('password: ${DB_PASSWORD}');
  none('password: "<your password>"');
  none('token: req.query.token');
  none('password: password');
  // 名前にトークンなどが入っていても、数や種類の設定
  none('max_tokens: 4096');
  none('token_type: bearer');
  none('password_hint: 誕生日');
  // 画面の文言と説明文
  none('"password": "パスワード"');
  none('"password": "Enter your password"');
  none('Password: Enter your password here');
  none('secretary: 田中');
  none('compass: north');
});

test('カード番号は検査用の数字とブランドで確かめ、テスト用の番号は外す', () => {
  assert.deepEqual(kinds('カード 4980 1234 5678 9011'), ['card:4980 1234 5678 9011']);
  assert.deepEqual(kinds('JCB 3530-1234-5678-9018'), ['card:3530-1234-5678-9018']);
  assert.ok(isCardNumber('371449635398456'));
  assert.ok(!isCardNumber('4980123456789012')); // 検査用の数字が合わない
  none('テストカード 4242 4242 4242 4242');
  none('伝票 1234 5678 9012 3456');
  assert.equal(sensitiveHint(findSensitive('4980 1234 5678 9011')[0]), '…9011');
});

test('マイナンバーは「マイナンバー」などの言葉の近くにあり、検査用の数字が合うものだけ', () => {
  assert.ok(isMyNumber('123456789018'));
  assert.ok(!isMyNumber('123456789012'));
  assert.equal(maskSensitive('マイナンバー：1234 5678 9018'), 'マイナンバー：<マイナンバー1>');
  assert.equal(maskSensitive('個人番号（12桁）は 123456789018 です'), '個人番号（12桁）は <マイナンバー1> です');
  none('マイナンバー：1234 5678 9012');
  none('注文番号 123456789018');
});

test('メールアドレス・電話番号・郵便番号・住所', () => {
  assert.deepEqual(kinds('連絡先 taro.yamada@gmail.com まで'), ['email:taro.yamada@gmail.com']);
  none('user@example.com icon@2x.png git@github.com:foo/bar.git noreply@anthropic.com');
  assert.deepEqual(kinds('電話 090-1234-5678 / 06(1234)5678 / 0120-123-456 / ０３－１２３４－５６７８ / 09012345678 / +81 90-1234-5678'), [
    'phone:090-1234-5678',
    'phone:06(1234)5678',
    'phone:0120-123-456',
    'phone:０３－１２３４－５６７８',
    'phone:09012345678',
    'phone:+81 90-1234-5678',
  ]);
  // 区切りの無い 10 桁・日付・時刻は電話番号とみなさない
  none('注文番号 0312345678 日付 2024-10-19 時刻 09:00-17:30 部品 01-02-2024');
  assert.equal(
    maskSensitive('〒530-0001 大阪府大阪市北区梅田1-2-3 梅田ビル5F'),
    '〒<郵便番号1> <住所1> 梅田ビル5F',
  );
  assert.deepEqual(kinds('東京都千代田区丸の内1丁目2番3号'), ['address:東京都千代田区丸の内1丁目2番3号']);
  assert.deepEqual(kinds('堺市堺区南瓦町3-1'), ['address:堺市堺区南瓦町3-1']);
  none('都市部で3-4割、東京都の人口は1400万人');
});

test('口座番号・生年月日・身分証の番号・社内のアドレス', () => {
  assert.deepEqual(kinds('普通 1234567'), ['account:1234567']);
  assert.deepEqual(kinds('ゆうちょ 10123-12345671'), ['account:10123-12345671']);
  assert.deepEqual(kinds('生年月日: 1990/01/02'), ['birthday:1990/01/02']);
  assert.equal(maskSensitive('1985年3月4日生まれ'), '<生年月日1>生まれ');
  none('2024年10月19日生産');
  assert.deepEqual(kinds('パスポート番号 TK1234567'), ['idNumber:TK1234567']);
  assert.deepEqual(kinds('サーバー 192.168.1.10 と 10.0.0.256 と printer.local と host.docker.internal'), [
    'internal:192.168.1.10',
    'internal:printer.local',
  ]);
  none('バージョン 1.2.3.4 と localhost:3000');
});

test('伏せるときは同じ文字に同じ名前を付け、メモの位置どおりに置き換える', () => {
  const text = 'a@corp.co.jp と b@corp.co.jp、もう一度 a@corp.co.jp\nDB_PASSWORD=one\nADMIN_PASSWORD=two\nPASSWORD=three\nPW: four4';
  assert.equal(
    maskSensitive(text),
    '<メール1> と <メール2>、もう一度 <メール1>\nDB_PASSWORD=<PASSWORD>\nADMIN_PASSWORD=<PASSWORD_2>\nPASSWORD=<PASSWORD_3>\nPW: <PASSWORD_4>',
  );
  // 全角の文字の後ろでも位置がずれない
  const wide = '全角ＡＢＣ　メール：ｔａｒｏ＠ｇｍａｉｌ．ｃｏｍ';
  const [found] = findSensitive(wide);
  assert.equal(wide.slice(found.start, found.end), 'ｔａｒｏ＠ｇｍａｉｌ．ｃｏｍ');
});

test('まとめた一覧は種類ごとの件数と、中身を出さない手がかり', () => {
  const findings = findSensitive('OPENAI_API_KEY=sk-proj-1234567890abcdefABCDEF1234\nDB_PASSWORD=hunter2\nパスワード：abc12345\nx@corp.co.jp');
  assert.deepEqual(summarizeSensitive(findings), [
    { kind: 'apiKey', label: 'API キー・トークン', count: 1, hints: ['sk-proj-…1234'], moreHints: 0 },
    { kind: 'password', label: 'パスワード', count: 2, hints: ['DB_PASSWORD の値', '「パスワード」の後ろ'], moreHints: 0 },
    { kind: 'email', label: 'メールアドレス', count: 1, hints: ['x@corp.co.jp'], moreHints: 0 },
  ]);
  assert.ok(hasSecret(findings));
  assert.ok(!hasSecret(findSensitive('x@corp.co.jp 090-1234-5678')));
});

test('大きなメモでもすぐに終わる', () => {
  const lines = ['DB_PASSWORD=hunter2', 'taro@corp.co.jp', '090-1234-5678', '大阪府大阪市北区梅田1-2-3', 'ふつうの文章です。'.repeat(5), 'const a = b(c);'];
  const text = lines.join('\n').repeat(2000);
  const started = performance.now();
  const findings = findSensitive(text);
  assert.equal(findings.length, 8000);
  assert.ok(performance.now() - started < 1000);
});
