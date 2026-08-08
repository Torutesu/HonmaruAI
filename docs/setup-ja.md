# はじめかた（Honmaru AI を iPhone に入れるまで）

エンジニアでなくても進められるように、1ステップずつ書いています。
上から順に、飛ばさずにやってください。

使うのは **Mac の「ターミナル」** というアプリです。
`command`（⌘）+ スペース → `ターミナル` と打って Enter で開きます。

以下、灰色の枠の中身は**コピーして、ターミナルに貼り付けて、Enter**を押す、という意味です。

---

## ステップ 0：ファイルを自分の Mac に持ってくる

**ここを飛ばすと `scripts/setup.sh` は「そんなファイルはありません」と言われます。**
リリース用のファイルは `claude/app-store-connect-cli-itldg5` という**枝分かれした置き場所（ブランチ）**にあり、
最初はあなたの Mac に降りてきていないからです。

### 0-1. これを1回貼り付けて実行する

**途中で改行せず、この1行をまるごとコピーして**貼り付けてください。

```
cd ~/HonmaruAI && git fetch origin claude/app-store-connect-cli-itldg5 && git checkout claude/app-store-connect-cli-itldg5 && ls scripts/
```

最後に `ExportOptions.plist.template` `release.sh` `setup.sh` の3つが表示されれば成功です。
ステップ1に進んでください。

> **なぜ1行にまとめているか**：`cd` は「今いる場所」を変えるコマンドです。
> 途中で別のコマンドを挟んで場所が変わると、その後の `git` が
> `not a git repository` で失敗します。`&&` でつないでおけば、
> 場所が変わらないまま最後まで一息で進みます。

### 0-2. うまくいかなかったとき

**`cd: no such file or directory: /Users/あなた/HonmaruAI`**

フォルダの場所が違います。Finder でプロジェクトのフォルダを探して、
ターミナルに `cd ` と打ち（**最後のスペースまで**）、そのあと
**フォルダをターミナルにドラッグ＆ドロップ**して Enter。
そのあと 0-1 の `cd ~/HonmaruAI && ` を取り除いた残り（`git fetch ...` 以降）を実行してください。

フォルダがどこにも無い場合だけ、まるごと取ってきます。

```
cd ~ && git clone https://github.com/Torutesu/HonmaruAI.git && cd ~/HonmaruAI && git checkout claude/app-store-connect-cli-itldg5 && ls scripts/
```

**`Your local changes would be overwritten`**

その Mac 側で編集途中のファイルがあります。取っておく場合はこれを実行してから 0-1 をやり直します。

```
cd ~/HonmaruAI && git stash
```

**`fatal: not a git repository`**

`cd` が効いておらず、プロジェクト以外の場所にいます。0-1 の1行をまとめて貼り直してください。

---

## ステップ 1：道具をそろえる（初回だけ）

### 1-1. Homebrew を入れる

すでに入っている人は飛ばしてください。入っているか分からなければ、まずこれを実行します。

```
brew --version
```

`command not found` と出たら入っていないので、[brew.sh](https://brew.sh) の手順に従ってください。

### 1-2. 必要な道具を入れる

```
brew install asc xcodegen
```

### 1-3. Xcode を入れる

Mac App Store で「Xcode」を検索してインストールします。**サイズが大きいので時間がかかります**（1時間以上かかることもあります）。先に進む前に完了させてください。

---

## APIキーは本当に必要？

**TestFlight で配るだけなら不要です。** Xcode の画面からでも配れます。

| | TestFlight に必要 | App Store 審査に必要 |
|---|---|---|
| Apple Developer Program | ✅ | ✅ |
| Team ID | ✅ | ✅ |
| Xcode | ✅ | ✅ |
| App Store Connect のアプリ登録枠 | ✅ | ✅ |
| **APIキー（.p8 / Key ID / Issuer ID）** | **不要** | **不要**（あると自動化できる） |

APIキーは「ターミナルから自動化するため」のものです。**毎回 Xcode を開いて10回以上クリックする作業**が、
`scripts/release.sh testflight` の1行になります。リリースを繰り返すなら間違いなく元が取れますが、
**初回はキー無しで進めても構いません。**

キー無しで進める場合は、ステップ2〜4を飛ばして
**[Xcode の画面から配る（APIキー不要）](#付録xcode-の画面から配るapiキー不要)** に進んでください。

---

## ステップ 2：Apple から3つの情報を取ってくる

貼る場所はステップ3で自動的に聞かれます。**ここではメモ帳などに控えるだけ**でOKです。

### 2-1. Team ID

1. [developer.apple.com/account](https://developer.apple.com/account) を開いてサインイン
2. 左のメニューから **Membership details**（メンバーシップの詳細）
3. **Team ID** という項目の、`A1B2C3D4E5` のような**10文字**をコピー

### 2-2. Key ID と Issuer ID、そして鍵ファイル

1. [App Store Connect](https://appstoreconnect.apple.com) を開く
2. **ユーザーとアクセス** → **インテグレーション** → **App Store Connect API**
3. **＋** ボタンで新しいキーを作る
   - 名前：`Honmaru AI Release` など何でもOK
   - アクセス：**App Manager** を選ぶ ← 審査提出に必要です。ここを間違えると後で作り直しになります
4. 作成すると一覧に表示されるので、
   - **キー ID**（`ABC123XYZ9` のような文字列）をコピー
   - ページ上部の **Issuer ID**（ハイフン入りの長い文字列）をコピー
5. **「ダウンロード」ボタンで鍵ファイル（.p8）を保存**

> ⚠️ **この .p8 ファイルは1回しかダウンロードできません。**
> 無くすとキーを作り直しになります。消さないでください。

ダウンロードした .p8 を、決まった場所に移しておきます。ターミナルにこれを貼り付けて実行してください。

```
mkdir -p ~/.appstoreconnect/private_keys && mv ~/Downloads/AuthKey_*.p8 ~/.appstoreconnect/private_keys/
```

---

## ステップ 3：設定する（質問に答えるだけ）

プロジェクトのフォルダに移動して、セットアップを実行します。

```
cd ~/HonmaruAI
```

> フォルダの場所が違う場合は、Finder でプロジェクトのフォルダを探して、
> `cd ` と打ったあと（最後のスペースまで入れて）**フォルダをターミナルにドラッグ＆ドロップ**すると、正しい場所が入ります。

```
scripts/setup.sh
```

ステップ2で控えた情報を聞かれるので、順番に貼り付けて Enter を押していきます。

- .p8 ファイルの場所を聞かれたら、**Finder からファイルをターミナルにドラッグ＆ドロップ**すると楽です
- **App ID はまだ空のまま Enter でOK**です（ステップ5で入れます）

最後に緑色の ✓ が並べば成功です。

---

## ステップ 4：Apple に接続できるか確認する

```
scripts/release.sh login
```

```
scripts/release.sh doctor
```

`doctor` は「今どこまで準備できているか」を全部チェックしてくれます。
黄色い `!` が出たら、そこに書いてある内容が足りていない部分です。

---

## ステップ 5：アプリの登録枠を作る

ここだけは Apple のサイト上での作業です。

1. [App Store Connect](https://appstoreconnect.apple.com) → **マイ App** → **＋** → **新規 App**
2. 入力内容：
   - プラットフォーム：**iOS**
   - 名前：`Honmaru AI`（**App Store 全体で早い者勝ち**なので、取られていたら少し変えます）
   - 主要言語：日本語 or 英語
   - バンドル ID：**`com.honmaru.ai`** を選ぶ
   - SKU：`honmaru-ai` など、自分が分かる文字列で構いません

> バンドル ID が選択肢に出てこない場合は、先に
> [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) →
> **Identifiers** → **＋** → **App IDs** → **App** で `com.honmaru.ai` を登録してください。

作れたら、ターミナルで番号を確認します。

```
asc apps list --output table
```

表示された**数字のID**（`6478123456` のような10桁）をコピーして、もう一度セットアップを実行し、
App ID のところに貼り付けてください（他の項目は Enter で飛ばせます）。

```
scripts/setup.sh
```

---

## ステップ 6：iPhone に入れる

```
scripts/release.sh build 0.1.0
```

```
scripts/release.sh testflight
```

`build` は10〜20分かかることがあります。終わったら iPhone に **TestFlight** アプリ
（App Store から無料で入れられます）を入れて、Apple ID でサインインすると出てきます。

これで実機で動きます。**審査は不要**です。

---

## ステップ 7：App Store に出す（まだ先です）

```
scripts/release.sh all 1.0.0
```

ただし、**今のままでは審査に落ちます**。先に片付ける必要があるものが
[PROGRESS.md](../PROGRESS.md#app-store-submission-blockers) にまとめてあります。
一番大きいのは、アプリが `127.0.0.1`（＝自分のMac）のサーバーに繋ぎに行く作りのままなので、
審査担当者の iPhone ではサインインすらできない、という点です。

---

## 付録：Xcode の画面から配る（APIキー不要）

.p8 が手元に無い、または先に1本動かしてみたい場合はこちらです。
**ステップ5（アプリの登録枠を作る）は、この方法でも必須**なので先に済ませてください。

### A-1. Xcode でプロジェクトを開く

```
cd ~/HonmaruAI && xcodegen generate && open HonmaruAI.xcodeproj
```

### A-2. チームを選ぶ

1. 左側の一番上にある青いアイコン **HonmaruAI** をクリック
2. 中央の **TARGETS** の下の **HonmaruAI** をクリック
3. 上のタブから **Signing & Capabilities**
4. **Automatically manage signing** にチェックが入っていることを確認
5. **Team** のプルダウンから自分のチームを選ぶ

赤いエラーが消えればOKです。

> ここで選んだ設定は `xcodegen generate` を実行し直すと消えます。
> 毎回選び直すのが面倒になったら、`.asc.env` に Team ID を入れて
> `scripts/release.sh build` を使うほうが早くなります。

### A-3. 書き出す

1. 画面上部中央の実行先が iPhone シミュレータになっているので、
   クリックして **Any iOS Device (arm64)** に変える
2. メニューバー **Product** → **Archive**
   - 10〜20分かかります。終わると Organizer ウインドウが自動で開きます
3. **Distribute App** ボタン
4. **TestFlight & App Store** を選んで **Distribute**
5. Apple ID でのサインインを求められたら、Developer Program に登録したアカウントで

アップロード後、Apple 側の処理に5〜15分かかります。
処理が終わると App Store Connect の **TestFlight** タブにビルドが出てきます。

### A-4. iPhone に入れる

1. App Store Connect → マイ App → Honmaru AI → **TestFlight** タブ
2. **内部テスト** グループに自分を追加
3. iPhone に **TestFlight** アプリ（App Store から無料）を入れる
4. Developer Program と同じ Apple ID でサインインすると出てきます

**内部テストは審査不要**なので、追加すればすぐ届きます。

---

## 困ったときは

**何をやっても不安なとき**は、まずこれを実行してください。何も壊さずに状態だけ調べます。

```
scripts/release.sh doctor
```

**実行前に「何が起きるか」だけ見たいとき**は、コマンドの後ろに `--dry-run` を付けます。
実際には何も実行されず、これから動くコマンドの一覧だけが表示されます。

```
scripts/release.sh all 1.0.0 --dry-run
```

**Apple には勝手に送信されません。** 送信前に必ず `[y/N]` と確認が出るので、
`y` を押さない限り何も起きません。

| 出たメッセージ | 意味と対処 |
|---|---|
| `scripts/setup.sh: No such file or directory` | **ステップ0 がまだ**。ファイルが Mac に来ていません |
| `zsh: permission denied: scripts/setup.sh` | `bash scripts/setup.sh` と、頭に `bash ` を付けて実行する |
| `cd: no such file or directory` | フォルダの場所が違う。ステップ0-1 のドラッグ＆ドロップを使う |
| `command not found: asc` | ステップ1-2 をやり直す |
| `not authenticated` | `scripts/release.sh login` を実行する |
| `DEVELOPMENT_TEAM unset` | ステップ3 をやり直して Team ID を入れる |
| `private key not found` | .p8 の場所が違う。ステップ2-2 の最後のコマンドを実行する |
| `ASC_APP_ID unset` | ステップ5 がまだ。実機テストだけなら気にしなくてOK |

英語の詳しい版は [app-store-release.md](app-store-release.md) にあります。
