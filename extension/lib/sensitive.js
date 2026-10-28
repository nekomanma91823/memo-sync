// メモの中の、AI に渡したり画面に出したりしないほうがよい文字を見つける
// （API キー・パスワード・秘密鍵と、メールアドレス・電話番号・カード番号などの個人情報）。
//
// キーの頭の決まった文字、桁数と検査用の数字、「パスワード：」のような目印の言葉で探すだけで、何も外に送らない。
// 全角の英数字と記号は半角とみなして探す（1 文字ずつ置き換えるので、見つけた位置は元の文のまま使える）。

// 並びは画面に出す順。secret は「隠しますか」と聞く種類、mask は伏せるときの名前。
// キーはどのサービスのものでも <API_KEY> にする（名前を間違えて、別のサービスのキーだと伝えないように）
export const KINDS = {
  privateKey: { label: '秘密鍵', secret: true, mask: 'PRIVATE_KEY' },
  apiKey: { label: 'API キー・トークン', secret: true, mask: 'API_KEY' },
  password: { label: 'パスワード', secret: true, mask: 'PASSWORD' },
  card: { label: 'カード番号', secret: true, mask: 'カード番号' },
  myNumber: { label: 'マイナンバー', secret: true, mask: 'マイナンバー' },
  idNumber: { label: '身分証の番号', mask: '身分証の番号' },
  account: { label: '口座番号', mask: '口座番号' },
  email: { label: 'メールアドレス', mask: 'メール' },
  phone: { label: '電話番号', mask: '電話番号' },
  postal: { label: '郵便番号', mask: '郵便番号' },
  address: { label: '住所', mask: '住所' },
  birthday: { label: '生年月日', mask: '生年月日' },
  internal: { label: '社内のアドレス', mask: '社内アドレス' },
};

const PREFECTURES =
  '北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|' +
  '石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|' +
  '岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県';

// 決まった頭の文字で始まるキーとトークン。上にあるものほど先に当てる（sk-ant- は sk- より先）。
// 名前は見分けるための目印で、伏せるときはどれも <API_KEY> になる
const TOKENS = [
  ['ANTHROPIC_API_KEY', String.raw`sk-ant-[\w-]{20,}`],
  ['OPENAI_API_KEY', String.raw`sk-(?:proj-|svcacct-|admin-)?[\w-]{20,}`],
  ['GITHUB_TOKEN', String.raw`gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{22,}`],
  ['GITLAB_TOKEN', String.raw`glpat-[\w-]{20,}`],
  ['AWS_ACCESS_KEY_ID', String.raw`(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}`],
  ['GOOGLE_API_KEY', String.raw`AIza[\w-]{35}`],
  ['GOOGLE_CLIENT_SECRET', String.raw`GOCSPX-[\w-]{20,}`],
  ['GOOGLE_ACCESS_TOKEN', String.raw`ya29\.[\w-]{20,}`],
  ['SLACK_TOKEN', String.raw`xox[abposre]-[A-Za-z0-9-]{10,}`],
  ['SLACK_WEBHOOK_URL', String.raw`https://hooks\.slack\.com/(?:services|workflows|triggers)/[\w/-]+`],
  ['DISCORD_WEBHOOK_URL', String.raw`https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d+/[\w-]+`],
  ['STRIPE_SECRET_KEY', String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`],
  ['STRIPE_WEBHOOK_SECRET', String.raw`whsec_[A-Za-z0-9]{20,}`],
  ['NPM_TOKEN', String.raw`npm_[A-Za-z0-9]{36}`],
  ['PYPI_TOKEN', String.raw`pypi-[\w-]{50,}`],
  ['HUGGINGFACE_TOKEN', String.raw`hf_[A-Za-z0-9]{30,}`],
  ['SENDGRID_API_KEY', String.raw`SG\.[\w-]{16,}\.[\w-]{16,}`],
  ['NOTION_TOKEN', String.raw`secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{40,}`],
  ['SUPABASE_TOKEN', String.raw`sbp_[a-f0-9]{40}`],
  ['FIGMA_TOKEN', String.raw`figd_[\w-]{30,}`],
  ['SHOPIFY_TOKEN', String.raw`shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}`],
  ['DIGITALOCEAN_TOKEN', String.raw`dop_v1_[a-f0-9]{64}`],
  ['MAILGUN_API_KEY', String.raw`key-[a-f0-9]{32}`],
  ['TELEGRAM_BOT_TOKEN', String.raw`\d{8,10}:AA[\w-]{33}`],
  ['GROQ_API_KEY', String.raw`gsk_[A-Za-z0-9]{40,}`],
  ['XAI_API_KEY', String.raw`xai-[A-Za-z0-9]{40,}`],
  ['PERPLEXITY_API_KEY', String.raw`pplx-[A-Za-z0-9]{40,}`],
  ['REPLICATE_API_TOKEN', String.raw`r8_[A-Za-z0-9]{30,}`],
  ['LINEAR_API_KEY', String.raw`lin_api_[A-Za-z0-9]{30,}`],
  ['ATLASSIAN_API_TOKEN', String.raw`ATATT[A-Za-z0-9_=-]{40,}`],
  ['POSTMAN_API_KEY', String.raw`PMAK-[a-f0-9]{24}-[a-f0-9]{34}`],
  ['SENTRY_AUTH_TOKEN', String.raw`sntry[su]_[\w+/=-]{40,}`],
  ['DATABRICKS_TOKEN', String.raw`dapi[a-f0-9]{32}(?:-\d+)?`],
  ['VAULT_TOKEN', String.raw`hv[sbr]\.[\w-]{24,}`],
  ['SUPABASE_SECRET_KEY', String.raw`sb_secret_[\w-]{20,}`],
  ['RESEND_API_KEY', String.raw`re_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}`],
  ['TEAMS_WEBHOOK_URL', String.raw`https://[\w-]+\.webhook\.office\.com/webhookb2/[\w@/.-]+`],
  ['JWT', String.raw`eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}`],
];
// 英字と数字の両方を含むものだけをキーとみなす（「sk-」で始まる長い英単語のつながりなどを外す）
const MIXED_OPTIONAL = new Set(['SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL', 'JWT']);
const TOKEN_PATTERN = new RegExp(String.raw`(?<![\w-])(?:${TOKENS.map(([, source]) => `(${source})`).join('|')})(?![\w-])`, 'g');

// 「password = ...」「"apiKey": "..."」のような書き方の、名前の部分の単語
const SECRET_WORDS = new Set(['password', 'passwd', 'passphrase', 'passcode', 'pass', 'pwd', 'pw', 'pin', 'secret', 'token', 'apikey', 'credential', 'credentials', 'privatekey', 'accesskey', 'secretkey']);
const PASSWORD_WORDS = new Set(['password', 'passwd', 'passphrase', 'passcode', 'pass', 'pwd', 'pw', 'pin']);
const KEY_PAIRS = new Set(['api', 'access', 'secret', 'private', 'auth', 'account', 'signing', 'encryption', 'master', 'client']);
// 名前にこれが入っていたら、キーそのものではない（max_tokens・token_type・password_hint など）
const NOT_SECRET_WORDS = new Set([
  'max', 'min', 'count', 'limit', 'type', 'url', 'uri', 'endpoint', 'length', 'len', 'size', 'expires', 'expiry', 'expiration',
  'ttl', 'input', 'output', 'usage', 'budget', 'path', 'file', 'name', 'field', 'label', 'placeholder', 'hint', 'policy',
  'header', 'prefix', 'format', 'mode', 'enabled', 'required', 'rule', 'rules', 'strength', 'timeout', 'num', 'id', 'reset',
]);
// 値がこれなら、本物のキーではない（例や型の名前、伏せた跡）
const PLACEHOLDER_VALUES = new Set([
  'null', 'none', 'nil', 'undefined', 'true', 'false', 'string', 'str', 'number', 'int', 'integer', 'boolean', 'bool', 'any',
  'object', 'required', 'optional', 'secret', 'password', 'passwd', 'token', 'changeme', 'change_me', 'example', 'dummy',
  'sample', 'placeholder', 'todo', 'tbd', 'test', 'hidden', 'redacted', 'masked', 'yourpassword', 'mypassword',
]);
const PLACEHOLDER_PATTERN =
  /^(?:<[^>]*>|\[[^\]]*\]|\{\{.*\}\}|\$\{.*\}|\$[A-Za-z_]\w*|%\w+%|[*xX•●○_#.…-]+|your[_-].*|my[_-].*|<.*|.*>)$/;
const EXPRESSION_PATTERN =
  /^(?:process\.env|import\.meta|os\.environ|os\.getenv|getenv|deno\.env|system\.getenv|env[.[(]|config\.|settings\.|secrets\.|req\.|request\.|this\.|self\.|ctx\.|context\.|props\.|params\.|args\.|options\.|opts\.)/i;

const ASSIGN_PATTERN = /(?<![\w$.-])([A-Za-z_][\w.-]{0,60})["']?[ \t]*(?:={1,3}|:=|:|=>)[ \t]*(?:(["'`])([^"'`\n]{1,200}?)\2|([^\s"'`,;]{1,200}))/dg;
const JA_PASSWORD_PATTERN = /(パスワード|パスコード|暗証番号|合言葉|ログインパス|PIN番号)(?:(?:は|が)[ \t]*|[ \t]*[:=][ \t]*|[ \t]+)["'「『]?([!-~]{3,200})/dg;
// 「トークン：…」「API キーは …」のような日本語の目印。長い方を先に書く（クライアントシークレットはシークレットより先）
const JA_KEY_PATTERN =
  /(API ?キー|アクセスキー|アクセストークン|シークレットキー|クライアントシークレット|シークレット|認証キー|認証トークン|秘密キー|トークン)(?:(?:は|が)[ \t]*|[ \t]*[:=][ \t]*|[ \t]+)["'「『]?([!-~]{12,300})/dg;
// curl -u ユーザー:パスワード（git push -u や docker run -u と取り違えないよう、curl の行だけ）
const CURL_USER_PATTERN = /\bcurl\b[^\n]*?[ \t](?:-u|--user)(?:[ \t]+|=)(["']?)[^\s:"']+:([^\s"']+)\1/dg;
const URL_PASSWORD_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/dgi;
const URL_PARAM_PATTERN =
  /[?&#;](access_token|refresh_token|id_token|auth_token|token|api_key|apikey|api-key|key|secret|client_secret|password|passwd|pwd|code|sig|signature|x-amz-signature|x-amz-security-token|x-amz-credential|x-goog-signature|x-goog-credential)=([^&#\s"'<>`]+)/dgi;
const AZURE_PATTERN = /(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/=]{20,})/dg;
const BEARER_PATTERN = /\b(?:Bearer|Basic)[ \t]+([A-Za-z0-9._~+/-]{16,}=*)/dg;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|(?=\n[ \t]*\n)|$)/g;
// PuTTY の .ppk の鍵（最後の Private-MAC の行まで）
const PUTTY_KEY_PATTERN = /PuTTY-User-Key-File-\d+:[\s\S]*?(?:Private-MAC:[^\n]*|(?=\n[ \t]*\n)|$)/g;

const CARD_PATTERN = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
// よく使われるテスト用のカード番号（決済の開発で書くもの）
const TEST_CARDS = new Set([
  '4242424242424242', '4111111111111111', '4000056655665556', '4012888888881881', '5555555555554444', '5105105105105100',
  '2223003122003222', '378282246310005', '371449635398431', '3566002020360505', '3530111333300000', '6011111111111117',
  '30569309025904', '38520000023237',
]);
const MY_NUMBER_PATTERN = /(マイナンバー|個人番号|my ?number)[^\n]{0,12}?(?<![\d-])(\d{4}[ -]?\d{4}[ -]?\d{4})(?![\d-])/dgi;
const ID_PATTERNS = [
  /(旅券|パスポート|passport)(?:番号| ?no\.?| ?number)?[^A-Za-z0-9\n]{0,6}?([A-Z]{2}\d{7})(?![A-Za-z0-9])/dgi,
  /(運転免許証?|免許証)(?:の)?(?:番号)?[^\d\n]{0,8}?(\d{12})(?!\d)/dg,
  /(在留カード|特別永住者証明書)(?:の)?(?:番号)?[^A-Za-z0-9\n]{0,8}?([A-Z]{2}\d{8}[A-Z]{2})(?![A-Za-z0-9])/dg,
  /(基礎年金番号|年金番号)[^\d\n]{0,6}?(\d{4}-?\d{6})(?!\d)/dg,
];
const ACCOUNT_PATTERN = /(口座番号|口座|普通預金|普通|当座預金|当座|貯蓄預金|貯蓄|account (?:no\.?|number))[^\d\n]{0,6}?(\d{7})(?![\d,])/dgi;
const YUCHO_PATTERN = /(?<![\d-])1\d{4}[ -]\d{7}1(?![\d-])/g; // ゆうちょ銀行の記号（5 桁）と番号（8 桁、最後は 1）
const EMAIL_PATTERN = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w-])/g;
const NOT_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net|jp)|example|test|invalid|localhost)$/i;
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'json', 'md', 'txt', 'pdf', 'zip', 'html']);
const PHONE_PATTERN =
  /(?<![\d+\-ー])(?:\+81[ -]?(?:\(0\)[ -]?)?\d{1,4}[ \-ー]?\(?\d{1,4}\)?[ \-ー]?\d{3,4}|\(?0\d{1,4}\)?[ \-ー]?\(?\d{1,4}\)?[ \-ー]?\d{3,4})(?![\d-]|ー\d)/g;
const POSTAL_PATTERNS = [
  /(〒|郵便番号)[ \t:]*(\d{3}-?\d{4})(?![\d-])/dg,
  new RegExp(String.raw`(?<![\d-])(\d{3}-\d{4})(?=[ \t]*(?:${PREFECTURES}))`, 'dg'),
];
const KANJI = String.raw`一-鿿々`;
const ADDRESS_PATTERN = new RegExp(
  String.raw`(?:${PREFECTURES}|[${KANJI}]{1,5}[市区郡])[ぁ-んァ-ヶー${KANJI}]{0,25}?\d{1,4}(?:(?:丁目|番地|番|号|-|ー|の)\d{1,4}){1,3}(?:号|番地)?`,
  'g',
);
const PREFECTURE_START = new RegExp(`^(?:${PREFECTURES})`);
const DATE = String.raw`(?:\d{4}|(?:明治|大正|昭和|平成|令和|[MTSHR])\.? ?\d{1,2})[年/.-] ?\d{1,2}[月/.-] ?\d{1,2}日?`;
const BIRTHDAY_PATTERNS = [
  new RegExp(String.raw`(生年月日|誕生日|生まれ|date of birth|birth ?date|birthday|DOB)[^\d\n]{0,8}?(${DATE})`, 'dgi'),
  new RegExp(String.raw`(${DATE})(?:生まれ|生)(?![${KANJI}])`, 'dg'),
];
const PRIVATE_IP_PATTERN = /(?<![\d.])(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?!\d|\.\d)/g;
const INTERNAL_HOST_PATTERN = /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:local|internal|intranet|corp|lan)(?![\w-]|\.[a-z])/gi;
const NOT_INTERNAL_HOST = /^(?:host|kubernetes|gateway)\.docker\.internal$/i;

// 全角の英数字・記号と、いろいろな横棒を半角にする（文字数は変えない）
function normalize(text) {
  return text.replace(/[！-～　‐-―−]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code === 0x3000) return ' ';
    if (code >= 0xff01) return String.fromCharCode(code - 0xfee0);
    return '-';
  });
}

function digitsOf(value) {
  return value.replace(/\D/g, '');
}

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function isCardNumber(digits) {
  if (TEST_CARDS.has(digits) || !luhn(digits)) return false;
  const n = digits.length;
  if (/^4/.test(digits)) return [13, 16, 19].includes(n); // Visa
  if (/^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return n === 16; // Mastercard
  if (/^3[47]/.test(digits)) return n === 15; // American Express
  if (/^35(?:2[89]|[3-8]\d)/.test(digits)) return n >= 16; // JCB
  if (/^3(?:0[0-5]|[689])/.test(digits)) return n >= 14; // Diners
  if (/^6(?:011|5|4[4-9]|2)/.test(digits)) return n >= 16; // Discover・銀聯
  return false;
}

// マイナンバーの 12 桁目は、上の 11 桁から決まる検査用の数字
export function isMyNumber(digits) {
  if (!/^\d{12}$/.test(digits)) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) sum += Number(digits[11 - n]) * (n <= 6 ? n + 1 : n - 5);
  const rest = sum % 11;
  return Number(digits[11]) === (rest <= 1 ? 0 : 11 - rest);
}

function validPhone(raw) {
  let digits = digitsOf(raw);
  if (raw.startsWith('+81')) digits = `0${digits.slice(2).replace(/^0/, '')}`;
  if (!/^0[1-9]/.test(digits)) return false;
  const long = /^0(?:[5789]0|800)/.test(digits);
  if (digits.length !== (long ? 11 : 10)) return false;
  // 区切りの無い 10 桁は、注文番号などと見分けられないので携帯の番号だけにする
  return raw.startsWith('+81') || /[ \-ー()]/.test(raw) || /^0[5789]0/.test(digits);
}

// camelCase・snake_case・ケバブケース・ドット区切りの名前を、小文字の単語に分ける
function wordsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// 名前の単語から、キーかパスワードかを決める（どちらでもなければ null）
function secretKind(name) {
  const words = wordsOf(name);
  if (!words.length || words.some((word) => NOT_SECRET_WORDS.has(word))) return null;
  if (words.some((word) => PASSWORD_WORDS.has(word))) return 'password';
  if (words.some((word) => SECRET_WORDS.has(word))) return 'apiKey';
  for (let i = 1; i < words.length; i++) {
    if (words[i] === 'key' && KEY_PAIRS.has(words[i - 1])) return 'apiKey';
  }
  return null;
}

function isPlaceholder(value) {
  const plain = value.trim();
  return !plain || PLACEHOLDER_VALUES.has(plain.toLowerCase()) || PLACEHOLDER_PATTERN.test(plain) || EXPRESSION_PATTERN.test(plain);
}

// 16 文字以上で英字と数字が混ざり、細かく切れている（英単語のつながりに見えない）値。キーやトークンによくある形
function looksRandom(value) {
  if (value.length < 16 || !/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  const runs = value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
  return runs.length >= value.length / 3;
}

// 引用符で囲まれていない値は、プログラムの式や変数名（token = newToken など）ではないものだけにする。
// 大文字と小文字が混ざっていても、英字と数字がばらばらに並ぶ長い値は変数名ではなくキーとみなす
function looksLikeCode(value, name) {
  if (/[(){}[\]]/.test(value)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return true;
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) return false;
  if (looksRandom(value)) return false;
  return /[a-z][A-Z]/.test(value) || wordsOf(value).join('_') === wordsOf(name).join('_');
}

// Docker の設定の "auth": "<ユーザー:パスワード を base64 にしたもの>"
function isDockerAuth(name, value) {
  return wordsOf(name).join('_') === 'auth' && value.length >= 16 && /^[A-Za-z0-9+/]+=*$/.test(value);
}

const pick = (match, group) => ({ start: match.indices[group][0], end: match.indices[group][1] });

// 見つけ方ごとに、[開始, 終了) と種類・伏せるときの名前を返す。上にあるものほど優先する
const RULES = [
  function* privateKeys(t) {
    for (const pattern of [PRIVATE_KEY_PATTERN, PUTTY_KEY_PATTERN]) {
      for (const m of t.matchAll(pattern)) yield { kind: 'privateKey', start: m.index, end: m.index + m[0].replace(/\s+$/, '').length };
    }
  },
  function* tokens(t) {
    for (const m of t.matchAll(TOKEN_PATTERN)) {
      const index = m.slice(1).findIndex((group) => group !== undefined);
      if (!MIXED_OPTIONAL.has(TOKENS[index][0]) && !(/\d/.test(m[0]) && /[A-Za-z]/.test(m[0]))) continue;
      yield { kind: 'apiKey', start: m.index, end: m.index + m[0].length };
    }
  },
  function* azureKeys(t) {
    for (const m of t.matchAll(AZURE_PATTERN)) yield { kind: 'apiKey', ...pick(m, 1) };
  },
  function* urlPasswords(t) {
    for (const m of t.matchAll(URL_PASSWORD_PATTERN)) {
      if (!isPlaceholder(m[1])) yield { kind: 'password', ...pick(m, 1), where: 'URL' };
    }
  },
  function* curlUsers(t) {
    for (const m of t.matchAll(CURL_USER_PATTERN)) {
      if (m[2].length >= 3 && !isPlaceholder(m[2])) yield { kind: 'password', ...pick(m, 2), where: 'curl -u' };
    }
  },
  function* urlParams(t) {
    for (const m of t.matchAll(URL_PARAM_PATTERN)) {
      const param = m[1].toLowerCase();
      const password = ['password', 'passwd', 'pwd'].includes(param);
      if (m[2].length < (password ? 3 : 6) || isPlaceholder(m[2])) continue;
      // ログイン後に戻る URL の code=。ページの番号などの短い code は外す
      if (param === 'code' && !(m[2].length >= 16 && /\d/.test(m[2]) && /[A-Za-z]/.test(m[2]))) continue;
      yield { kind: password ? 'password' : 'apiKey', ...pick(m, 2), where: m[1] };
    }
  },
  function* bearer(t) {
    for (const m of t.matchAll(BEARER_PATTERN)) {
      if (/\d/.test(m[1]) && /[A-Za-z]/.test(m[1])) yield { kind: 'apiKey', ...pick(m, 1) };
    }
  },
  function* assignments(t) {
    for (const m of t.matchAll(ASSIGN_PATTERN)) {
      const [, key, , quoted, bare] = m;
      const value = quoted ?? bare;
      const kind = secretKind(key) ?? (isDockerAuth(key, value) ? 'password' : null);
      if (!kind) continue;
      const group = quoted !== undefined ? 3 : 4;
      // キーやパスワードは英数字と記号で書く（"password": "パスワード" のような画面の文言は外す）
      if (value.length < (quoted !== undefined ? 1 : 3) || /[^\x20-\x7e]/.test(value) || isPlaceholder(value)) continue;
      if (quoted === undefined) {
        if (looksLikeCode(value, key)) continue;
        // 「Password: Enter your password」のような英語の説明文
        const end = m.indices[4][1];
        const lineEnd = t.indexOf('\n', end);
        if (/^ +[A-Za-z]+ +[A-Za-z]+/.test(t.slice(end, lineEnd === -1 ? t.length : lineEnd))) continue;
      } else if (/^[A-Za-z][a-z]*(?: [a-z]+)+[.!?]?$/.test(value)) {
        continue; // "Enter your password" のような説明文
      }
      yield { kind, ...pick(m, group), where: key };
    }
  },
  function* japanesePasswords(t) {
    for (const m of t.matchAll(JA_PASSWORD_PATTERN)) {
      const value = m[2].replace(/[.,;:!?)\]}"'`]+$/, '');
      if (value.length < 3 || isPlaceholder(value) || /^https?:/i.test(value)) continue;
      const start = m.indices[2][0];
      yield { kind: 'password', start, end: start + value.length, where: m[1] };
    }
  },
  function* japaneseKeys(t) {
    for (const m of t.matchAll(JA_KEY_PATTERN)) {
      const value = m[2].replace(/[.,;:!?)\]}"'`]+$/, '');
      // 「API キーは OPENAI_API_KEY に入れる」のような説明は外し、英字と数字が混ざった値だけにする
      if (value.length < 12 || !/\d/.test(value) || !/[A-Za-z]/.test(value) || isPlaceholder(value) || /^https?:/i.test(value)) continue;
      const start = m.indices[2][0];
      yield { kind: 'apiKey', start, end: start + value.length, where: m[1] };
    }
  },
  function* cards(t) {
    for (const m of t.matchAll(CARD_PATTERN)) {
      if (isCardNumber(digitsOf(m[0]))) yield { kind: 'card', start: m.index, end: m.index + m[0].length };
    }
  },
  function* myNumbers(t) {
    for (const m of t.matchAll(MY_NUMBER_PATTERN)) {
      if (isMyNumber(digitsOf(m[2]))) yield { kind: 'myNumber', ...pick(m, 2) };
    }
  },
  function* idNumbers(t) {
    for (const pattern of ID_PATTERNS) {
      for (const m of t.matchAll(pattern)) yield { kind: 'idNumber', ...pick(m, 2) };
    }
  },
  function* accounts(t) {
    for (const m of t.matchAll(ACCOUNT_PATTERN)) yield { kind: 'account', ...pick(m, 2) };
    for (const m of t.matchAll(YUCHO_PATTERN)) yield { kind: 'account', start: m.index, end: m.index + m[0].length };
  },
  function* emails(t) {
    for (const m of t.matchAll(EMAIL_PATTERN)) {
      const [local, domain] = [m[0].slice(0, m[0].lastIndexOf('@')), m[0].slice(m[0].lastIndexOf('@') + 1)];
      if (NOT_EMAIL_DOMAIN.test(domain) || FILE_EXTENSIONS.has(domain.split('.').pop().toLowerCase())) continue;
      if (/^(?:git|no-?reply|do-?not-?reply)$/i.test(local) || t.slice(Math.max(0, m.index - 3), m.index) === '://') continue;
      yield { kind: 'email', start: m.index, end: m.index + m[0].length };
    }
  },
  function* phones(t) {
    for (const m of t.matchAll(PHONE_PATTERN)) {
      if (validPhone(m[0])) yield { kind: 'phone', start: m.index, end: m.index + m[0].length };
    }
  },
  function* postalCodes(t) {
    for (const pattern of POSTAL_PATTERNS) {
      for (const m of t.matchAll(pattern)) yield { kind: 'postal', ...pick(m, pattern === POSTAL_PATTERNS[0] ? 2 : 1) };
    }
  },
  function* addresses(t) {
    for (const m of t.matchAll(ADDRESS_PATTERN)) {
      const prefecture = m[0].match(PREFECTURE_START)?.[0] ?? '';
      const rest = m[0].slice(prefecture.length);
      const place = rest.slice(0, rest.search(/\d/));
      const numbers = rest.slice(place.length);
      // 都道府県から始まるときは市区町村まで、そうでないときは「○○市○○区」か「1-2-3」「1丁目2」の形まであるものだけ
      const full = numbers.match(/\d+/g).length >= 3 || /丁目|番|号/.test(numbers) || /市.+区|郡.+[町村]/.test(place);
      if (prefecture ? !/[市区町村郡]/.test(place) : !full) continue;
      yield { kind: 'address', start: m.index, end: m.index + m[0].length };
    }
  },
  function* birthdays(t) {
    for (const pattern of BIRTHDAY_PATTERNS) {
      for (const m of t.matchAll(pattern)) yield { kind: 'birthday', ...pick(m, pattern === BIRTHDAY_PATTERNS[0] ? 2 : 1) };
    }
  },
  function* internal(t) {
    for (const m of t.matchAll(PRIVATE_IP_PATTERN)) {
      if (m[0].split('.').every((part) => Number(part) <= 255)) yield { kind: 'internal', start: m.index, end: m.index + m[0].length };
    }
    for (const m of t.matchAll(INTERNAL_HOST_PATTERN)) {
      if (!NOT_INTERNAL_HOST.test(m[0])) yield { kind: 'internal', start: m.index, end: m.index + m[0].length };
    }
  },
];

// 見つけたもの：{ kind, start, end, value, where? } を、本文の前から順に。
// 重なったときは、上の見つけ方（RULES の順）を優先する
export function findSensitive(text) {
  if (!text) return [];
  const t = normalize(text);
  const taken = []; // 前から順に並べ、重ならないようにしておく
  for (const rule of RULES) {
    for (const found of rule(t)) {
      if (found.end <= found.start) continue;
      // found より前で始まる最後のものとだけ重なりうる
      let lo = 0;
      let hi = taken.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (taken[mid].start < found.end) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && taken[lo - 1].end > found.start) continue;
      taken.splice(lo, 0, { ...found, value: text.slice(found.start, found.end) });
    }
  }
  return taken;
}

// 見つけた文字を <API_KEY> や <メール1> のような名前に置き換える。同じ文字には同じ名前を付ける。
// キー・パスワード・秘密鍵は、サービスや書き方によらず種類ごとに同じ名前にする（2 つ目からは <API_KEY_2>）
export function maskSensitive(text, findings = findSensitive(text)) {
  const names = new Map();
  const counts = new Map();
  let out = '';
  let last = 0;
  for (const found of findings) {
    let placeholder = names.get(found.value);
    if (!placeholder) {
      const base = KINDS[found.kind].mask;
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      placeholder = /^[A-Z_]+$/.test(base) ? `<${n === 1 ? base : `${base}_${n}`}>` : `<${base}${n}>`;
      names.set(found.value, placeholder);
    }
    out += text.slice(last, found.start) + placeholder;
    last = found.end;
  }
  return out + text.slice(last);
}

// 画面に出すときの手がかり。キーやパスワードは中身を出さず、頭と最後の 4 文字か、どこに書いてあったかだけにする
export function sensitiveHint(found) {
  const value = found.value.replace(/\s+/g, ' ').trim();
  switch (found.kind) {
    case 'privateKey':
      return value.match(/BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?|^PuTTY-User-Key-File-\d+/)?.[0] ?? '';
    case 'apiKey':
    case 'password': {
      if (found.where === 'URL') return 'URL の中';
      if (found.where) return /^[\x20-\x7e]+$/.test(found.where) ? `${found.where} の値` : `「${found.where}」の後ろ`;
      if (value.length < 12) return '';
      const head = value.match(/^(?:[A-Za-z0-9]{1,7}[-_.]){1,2}/)?.[0] ?? value.slice(0, 4);
      return `${head.slice(0, 11)}…${value.slice(-4)}`;
    }
    case 'card':
    case 'myNumber':
      return `…${digitsOf(value).slice(-4)}`;
    case 'account':
    case 'idNumber':
      return `…${value.slice(-3)}`;
    case 'address':
      return value.length > 14 ? `${value.slice(0, 12)}…` : value;
    default:
      return value.length > 40 ? `${value.slice(0, 38)}…` : value;
  }
}

// 種類ごとにまとめる（画面の一覧用）。hints は重ならない手がかりを 3 つまで
export function summarizeSensitive(findings) {
  return Object.entries(KINDS)
    .map(([kind, { label }]) => {
      const items = findings.filter((found) => found.kind === kind);
      const hints = [...new Set(items.map(sensitiveHint).filter(Boolean))];
      return { kind, label, count: items.length, hints: hints.slice(0, 3), moreHints: Math.max(0, hints.length - 3) };
    })
    .filter((group) => group.count > 0);
}

// パスワード・キー・カード番号・マイナンバーがあるか（「このメモを隠しますか」と聞く）
export function hasSecret(findings) {
  return findings.some((found) => KINDS[found.kind].secret);
}
