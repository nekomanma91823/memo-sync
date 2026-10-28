# ストアに出す手順

## 事前の準備

- [ ] 公開に使う Google アカウントに、パスキーかセキュリティキーで 2 段階認証をかける。乗っ取られると、全利用者に不正な更新を配られてしまうため
- [ ] [Chrome ウェブストアのデベロッパー ダッシュボード](https://chrome.google.com/webstore/devconsole)に登録する。登録料は 5 ドル
- [ ] `docs/privacy-policy.md` の「未定」を埋めて、公開の URL に置く。ストアと Google の OAuth 設定の両方で必要
- [ ] 名前を決めたら、`extension/_locales/ja/messages.json` の `appName` を変える。画面の名前もここから入る
- [ ] プライバシーポリシーの URL が決まったら、`extension/ui/options.js` の `PRIVACY_POLICY_URL` に入れる。設定画面にリンクが出る

## 提出

1. `npm run pack` で `dist/memo-sync-<version>.zip` を作る。manifest の `key` は自動で外す。クライアント ID は手元の manifest のものが入る
2. ダッシュボードで zip をアップロードする。まだ公開はしない
3. 「パッケージ」の「公開鍵を表示」で出た鍵を、`extension/manifest.json` の `key` に貼り替える。これで開発中の ID がストアの ID と同じになる
4. Google Cloud のクライアントの「アイテム ID」を、ストアの ID に変える
5. ストアの「プライバシー」欄を書く
   - 単一用途：メモを書いて、利用者自身の Google アカウントで複数の PC に同期する
   - 権限の理由
     - storage と unlimitedStorage：メモの保存
     - activeTab と、任意の tabs：「URL を入れる」ボタンで、表示中のページの URL を入れる
     - contextMenus：右クリックで、選んだ文字をメモに送る
     - alarms：定期的な同期とバックアップ
     - identity：Google ドライブ同期のログイン
     - sidePanel：サイドパネルでの表示
     - 任意の downloads：「コピー」でメモの画像をファイルに保存し、その場所を文章に入れる。画像付きで初めてコピーするときに許可を求める
   - 開発者はデータを集めない。外部のコードは読み込まない
6. 説明文、1280×800 のスクリーンショット、128px のアイコン `extension/icons/icon128.png` を用意して、審査に出す

## 公開した後

- ストアには「署名付きアップロードを必須にする」設定がある。オンにすると、秘密鍵で署名した CRX しか受け付けなくなり、アカウントを乗っ取られても不正な更新を出されにくくなる
- 「拡張機能を買い取りたい」という連絡には応じない

## 秘密鍵 private/key.pem の扱い

- 開発中の拡張機能 ID の元です。Git には入れません。`.gitignore` で外してあります
- 失くしても、ストアに出した後はストアの鍵を使うので困りません。署名付きアップロードに使う場合は、別の安全な場所にも控えを置いてください
