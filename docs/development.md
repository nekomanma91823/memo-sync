# 開発の手引き

## はじめに 1 回だけ

```
npm run setup
```

Git の設定を 1 つ足します。`extension/manifest.json` の OAuth クライアント ID を、Git に入れるときだけ `YOUR_CLIENT_ID` に置き換える設定です。
自分のクライアント ID を公開のリポジトリに載せないためです。手元のファイルには本物の ID が残るので、開発中も Google ドライブ同期を試せます。
しくみは `tools/client-id-filter.mjs` の先頭に書いてあります。

拡張機能を読み込むのにも、テストを動かすのにも、`npm install` はいりません。
書式を付けて表示するときの入力欄に使う CodeMirror は、1 つのファイルにまとめて `extension/vendor/` に入れてあります。
`npm install` がいるのは、CodeMirror を新しくするときだけです。手順は「[CodeMirror を新しくする](#codemirror-を新しくする)」にあります。

## Chrome に読み込む

1. Chrome で `chrome://extensions` を開く
2. 右上の「デベロッパー モード」をオンにする
3. 「パッケージ化されていない拡張機能を読み込む」で `extension` フォルダを選ぶ
4. ツールバーのパズルのアイコンから、ちょこメモをピン留めする

コードを変えたら、`chrome://extensions` のちょこメモの「再読み込み」ボタンを押します。

`manifest.json` に公開鍵の `key` を入れてあるので、どの PC で読み込んでも拡張機能 ID は `hginhpfnpmeapbkbdohpelmdcdgppjhi` になります。
Chrome 同期のデータも Google のログイン設定もこの ID に結び付くので、PC ごとに ID が変わると同期できません。
別の ID で使いたいときは、`key` を消すか、自分の鍵に替えてください。

### 2 台の PC で同期を試す

1. 両方の PC に、同じ `extension` フォルダを読み込む
2. 両方の Chrome に同じ Google アカウントでログインし、同期をオンにする。`chrome://settings/syncSetup` で「拡張機能」もオンにする
3. 片方で書いて、数十秒後にもう片方でポップアップを開く

## Google ドライブ同期を使えるようにする

公開しているリポジトリの `manifest.json` では、`oauth2.client_id` が `YOUR_CLIENT_ID…` になっています。このままだと、設定画面の「Google ドライブ」は選べません。
自分の Google Cloud でクライアントを作って入れます。

1. [Google Cloud Console](https://console.cloud.google.com/) で新しいプロジェクトを作る
2. 「API とサービス」の「ライブラリ」で **Google Drive API** を探して「有効にする」
3. 「Google Auth Platform」を設定する
   - アプリ名・サポートメール・デベロッパーの連絡先を入れる
   - 対象は「外部」にする
   - 「データアクセス」で、スコープに `.../auth/drive.appdata` だけを足す
   - 試すあいだは「テストユーザー」に自分の Gmail を足す
4. 「クライアント」の「クライアントを作成」で、種類を **Chrome 拡張機能** にし、アイテム ID に拡張機能 ID を入れる
5. 表示されたクライアント ID を、次の 2 か所に書く
   - `extension/manifest.json` の `oauth2.client_id`
   - `private/oauth-client-id.txt`。Git には入りません。別の PC でリポジトリを取り出したとき、ここから ID を戻します
6. 拡張機能を再読み込みし、設定画面で「Google ドライブ」を選ぶ

別の PC で始めるときは、`private/oauth-client-id.txt` を置いてから `npm run setup` を実行し、`git checkout -- extension/manifest.json` で manifest を取り出し直します。

同意画面が「テスト中」のままだと、しばらくするとログインし直しが必要になることがあります。ストアに出すときは「本番環境」にします。
`drive.appdata` は Google の分類で「非センシティブ」なので、重い審査はいりません。アプリ名とロゴの確認、プライバシーポリシーの URL は必要です。

## テスト

```
npm test
```

統合のルール、Chrome 同期の容量の上限、Google ドライブのトークンの期限切れや壊れたファイル、取り込みの形式、Markdown の変換、検索と置換、
要注意の文字の検出、ファイル構成の約束ごとを確かめます。Chrome は使いません。

`npm test` は画面の JS を読み込みません。画面のコードを変えたら、`node --check` でも構文を確かめてください。

## フォルダ構成

```
memo-sync/
├── extension/            Chrome に読み込むフォルダ。ストアに出すのもこの中身
│   ├── manifest.json
│   ├── _locales/ja/      名前と説明。名前を変えるときはここだけを直す
│   ├── background.js     Chrome のイベントを Engine につなぐだけ
│   ├── lib/              chrome の API に頼らない処理。Node でテストしている
│   │   ├── model.js        メモのデータ構造と、端末どうしの内容を統合するルール
│   │   ├── engine.js       保存と同期の中心。保存はすべてここを通す
│   │   ├── local-doc.js    端末の中での置き方
│   │   ├── chrome-sync.js  同期の方式 1：Chrome の同期機能。8KB ごとに分けて保存する
│   │   ├── drive-sync.js   同期の方式 2：Google ドライブのアプリ専用フォルダ
│   │   ├── markdown.js     Markdown の読み取りと、書式付きコピー・記号を外したコピーへの変換
│   │   ├── live-marks.js   書式を付けて表示している間に、どこに書式を付け、どの記号を隠すか
│   │   ├── edit-keys.js    ⌘B などの書式の付け外しと、Tab の字下げ
│   │   ├── search.js       すべてのメモからの検索と置換
│   │   ├── sensitive.js    パスワード・API キー・個人情報らしい文字の検出
│   │   ├── copy-format.js  「コピー」で作る文章の形
│   │   ├── backup-format.js, zip.js  書き出しと取り込みの形式
│   │   └── そのほかの小さな部品
│   ├── ui/               ポップアップ・サイドパネル・設定画面
│   │   ├── editor.js       メモの画面の中心
│   │   ├── live-editor.js  書式を付けて表示している間の入力欄。CodeMirror で作る
│   │   ├── preview.js      書式を付けて表示している間の表と画像
│   │   ├── search.js       探す欄と置換の欄
│   │   └── memo-copy.js, images.js, menu.js, notice.js など
│   ├── vendor/           CodeMirror をまとめたものと、そのライセンスの文。npm run vendor で作る。直接は書き換えない
│   └── icons/
├── test/                 node --test で動くテスト
├── tools/                アイコン作成、ストア提出用の zip 作成、クライアント ID の置き換え、CodeMirror のまとめ
├── docs/                 この手引き、ストアに出す手順、プライバシーポリシー、画面の用語集
└── private/              秘密鍵とクライアント ID の控え。Git には入らない
```

画面の文を書くときは、[用語集](glossary.md) の語を使います。括弧で補足せず、文を分けて書きます。

## CodeMirror を新しくする

1. `package.json` の `@codemirror/state`・`@codemirror/view`・`@codemirror/commands` の版を変えて、`npm install` を実行する。出てから 2 週間ほどたった版を選びます
2. `npm run vendor` を実行する。`extension/vendor/codemirror.js` と、ライセンスの文の `codemirror.LICENSE.txt` を作り直します
3. `npm test` を実行し、Chrome に読み込み直して、書式を付けて表示したまま書けるかを確かめる

`npm run vendor` は、CodeMirror の部品の style-mod を 1 か所だけ書き換えます。
拡張機能の画面は、ページの中に書いたスタイルを読み込まない決まりにしているので、見た目をスクリプトから作るスタイルシートで入れるためです。
書き換える場所が見つからないときは、止まって知らせます。

## 同期のしくみ

- メモは番号ではなく固定の ID で管理し、画面の 1, 2, 3… は並び順で付けています。番号で同期すると、削除で番号がずれたときに別のメモを上書きしてしまうためです。
- メモごとに、更新時刻が新しい方を採用します。同じメモを 2 台でほぼ同時に編集したら、後に保存した方が残ります。
- 前回の同期のあと両方の端末で書き換わっていたメモは、負けた側の内容を、同期した端末のバックアップに取ります。画面にもお知らせを出します。
  前回の同期でそろえた各メモの更新時刻を、端末の中の `synced` に覚えておき、それと違えば「その後に書き換わった」とみなします。
- 削除は「削除済み」の印を残して、ほかの端末に伝えます。印は 90 日後に片付けます。
- 一度も書いていない初期のメモは、ほかの端末の並び順に合わせて捨てます。新しい PC を足すたびに、空のメモが増えないようにするためです。
- 同期でメモが消えたり、半分以下になったりするときは、その前に端末の中へバックアップを取ります。
- 画像の記録は memo-sync.json に入れ、本体は同じ専用フォルダに `img-<画像の ID>` として 1 枚ずつ置きます。
  本体を先に送ってから記録を書き、ほかの端末は同期のときに数枚ずつ取ってきます。大きな画像は、貼るときに長い辺 2560px の WebP に縮めます。1 枚 4MB までです。
- 自動のバックアップに入るのは文字だけです。削除したメモと画像は、画像ごと端末の中のゴミ箱に 30 日間残します。
  ほかの端末で削除されて同期で消えたものも、この PC に中身があればゴミ箱に入ります。
- 設定画面の「全部を書き出す」は、画像があれば `memos.txt` と `images/memo-<番号>/image-<n>` をまとめた ZIP にします。
- グループの色は Chrome の同期機能の `groupColors` に置きます。メモを Google ドライブで同期しているときも、色は Chrome の同期機能で届きます。
- 並べ替えたグループの順も、同じく Chrome の同期機能の `groupOrder` に置きます。並べ替えたことのないグループは、メモの並びで初めて出てくる順に後ろへ足します。
  色はメモの並びの順で割り当てるので、グループを並べ替えても色は変わりません。
- 詳しくは `extension/lib/model.js` と `extension/lib/engine.js` の先頭のコメントを見てください。
