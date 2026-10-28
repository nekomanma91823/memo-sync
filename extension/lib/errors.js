// 失敗の種類ごとに画面の表示を変えるためのエラー

// ログインが必要（Google ドライブの接続切れなど）
export class AuthError extends Error {
  name = 'AuthError';
}

// 同期先の容量が足りない
export class QuotaError extends Error {
  name = 'QuotaError';
}

// 同期先との通信や同期先のデータに問題がある
export class RemoteError extends Error {
  name = 'RemoteError';
}

// メモの数や長さの上限を超えた
export class LimitError extends Error {
  name = 'LimitError';
}

// Chrome や Google から英語で返ってくる失敗を、画面に出せる日本語にする。
// 返り値: { message: 日本語の説明, detail: 元の文（日本語に置き換えたときだけ。「詳しく」に出す） }
const KNOWN = [
  [/did not approve|not approve access|user (?:canceled|cancelled|denied)|OAuth2 request was rejected|Authorization page could not be loaded/i, 'Google へのログインが完了しませんでした。もう一度「接続する」を押してください。'],
  [/turned off browser signin|not signed in|signin is disabled/i, 'Chrome に Google アカウントでログインしていないため、接続できません。Chrome にログインしてからお試しください。'],
  [/QUOTA_BYTES_PER_ITEM/, '1 件の大きさが、Chrome 同期の上限 8KB を超えました。短くしてください。'],
  [/QUOTA_BYTES|MAX_ITEMS|quota exceeded/i, 'Chrome 同期の容量 100KB がいっぱいです。'],
  [/MAX_WRITE_OPERATIONS/, 'Chrome 同期の書き込み回数の上限に達しました。しばらくすると自動で再開します。'],
  [/storageQuotaExceeded|quotaExceeded/i, 'Google アカウントの容量がいっぱいです。Google ドライブ・Gmail・Google フォトのいらないものを消すか、容量を増やしてください。'],
  [/Document is not focused|not focused/i, 'コピーできませんでした。メモの画面を一度押してから、もう一度お試しください。'],
  [/NotAllowedError|Write permission denied|permission denied/i, 'ブラウザに止められたため、できませんでした。もう一度ボタンを押してください。'],
  [/Failed to fetch|NetworkError|network error|ERR_INTERNET_DISCONNECTED/i, 'ネットワークにつながっていません。つながると自動で再開します。'],
  [/FILE_NO_SPACE/, 'ディスクの空きが足りないため、ファイルを保存できませんでした。'],
  [/FILE_ACCESS_DENIED/, '「ダウンロード」フォルダに書き込めませんでした。フォルダの権限を確かめてください。'],
  [/FILE_NAME_TOO_LONG|FILE_TOO_LONG_PATH/, 'ファイルの場所が長すぎるため、保存できませんでした。'],
  [/FILE_BLOCKED|FILE_SECURITY_CHECK_FAILED|FILE_VIRUS_INFECTED/, 'セキュリティソフトなどに止められ、ファイルを保存できませんでした。'],
  [/FILE_\w+|NETWORK_\w+|USER_CANCELED/, 'ファイルを保存できませんでした。'],
];

export function describeError(error) {
  const original = String(error?.message ?? error ?? '').trim();
  for (const [pattern, message] of KNOWN) {
    if (pattern.test(original)) return { message, detail: original };
  }
  // 日本語の文はそのまま。英語だけの文は、日本語の前置きを付けて元の文を「詳しく」に回す
  if (!original || /[぀-ヿ一-鿿]/.test(original)) return { message: original || '処理に失敗しました。', detail: '' };
  return { message: '処理に失敗しました。', detail: original };
}

// メモの画面のお知らせのように 1 行で出すとき用。failed は「コピーできませんでした。」のような、何ができなかったかの一文。
// 知らない英語の失敗は画面に出さず、どうすればよいかを書く（元の文は開発者向けに console に残す）
export function errorText(error, failed = '') {
  const { message, detail } = describeError(error);
  if (detail && !KNOWN.some(([pattern]) => pattern.test(detail))) {
    console.warn(detail);
    return `${failed || '処理に失敗しました。'}もう一度試してください。`;
  }
  // 「コピーできませんでした。」で始まる説明に、同じ一文を重ねない
  return failed && !message.startsWith(failed) ? `${failed}${message}` : message;
}
