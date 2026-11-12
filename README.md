# prtimes-cli

[PR TIMES](https://prtimes.jp) の企業向け管理画面が使っている**非公式** API を使った CLI と、エージェント用プラグインです。Claude Code、Codex、Cursor、Gemini CLI などの AI コーディングエージェントから操作することを想定しています。すべてのコマンドは JSON を出力します。

- **下書き**: Markdown をエディタ用の HTML に変換して、プレスリリースの下書きを作成・更新します。ローカル画像のアップロードとメイン画像の設定、見出し、箇条書き、囲み、注釈、YouTube の埋め込みに対応しています。
- **設定と申請**: 目的、種類、ビジネスカテゴリ、キーワード、関連URL、配信日時を設定し、予約配信として審査に申請できます。メディアリストは自動選択です。
- **確認**: 自社のプレスリリースの一覧（下書き、配信予約、配信済み）と、各リリースの本文を取得できます。
- **数字**: ダッシュボードの直近1か月の数字（ページビュー、訪問者数、転載サイト数、フォロワー数、PV とソーシャルの上位3件）を確認できます。

**申請は予約配信だけです。今すぐ配信はしません。** 予約配信で申請すると、PR TIMES の審査に回り、承認されると予約した日時に公開されます。審査中は `draft unsubmit` で下書きに戻せます。位置情報、フッター、メールの設定、メディアリストの手動選択は、PR TIMES の管理画面で行ってください。

> 申請（`draft submit --yes`）と取り消し（`draft unsubmit`）は、管理画面が送る通信と同じ形にしてありますが、開発中に本番では実行していません。初めて使うときは、管理画面でステータスを確かめてください。

> ⚠️ PR TIMES の公式 API ではありません。予告なく動かなくなる可能性があります。自社のアカウントで少量の利用にとどめ、PR TIMES の利用規約に従ってください。

姉妹プロジェクト: [note-cli](https://github.com/shoot16625/note-cli)

## インストール

プラグインには依存パッケージのない単一ファイルの CLI（`dist/prtimes-cli.js`）が同梱されています。必要なのは [Bun](https://bun.sh) 1.2 以降だけです。

```bash
curl -fsSL https://bun.sh/install | bash
```

インストール方法はエージェントごとに異なります。

| エージェント | インストール |
|---|---|
| [Claude Code](#claude-code) | `/plugin marketplace add shoot16625/prtimes-cli` |
| [Codex](#codex) | `codex plugin marketplace add shoot16625/prtimes-cli` |
| [Cursor](#cursor) | このリポジトリから `/add-plugin` |
| [Gemini CLI](#gemini-cli) | `gemini extensions install https://github.com/shoot16625/prtimes-cli` |
| [GitHub Copilot CLI](#github-copilot-cli) | `copilot plugin marketplace add shoot16625/prtimes-cli` |
| [Factory Droid](#factory-droid) | `droid plugin marketplace add https://github.com/shoot16625/prtimes-cli` |
| [Qwen Code](#qwen-code) | `qwen extensions install shoot16625/prtimes-cli` |
| [Devin CLI](#devin-cli) | `devin plugins install shoot16625/prtimes-cli` |
| [Kimi Code](#kimi-code) | `/plugins install https://github.com/shoot16625/prtimes-cli` |
| [Antigravity](#antigravity) | `agy plugin install https://github.com/shoot16625/prtimes-cli` |
| [Pi](#pi) | `pi install git:github.com/shoot16625/prtimes-cli` |
| [その他](#その他のエージェントopencodewindsurfcline-など) | `npx skills add shoot16625/prtimes-cli` |

### Claude Code

```text
/plugin marketplace add shoot16625/prtimes-cli
/plugin install prtimes-cli@prtimes-cli
```

更新するときは、マーケットプレイスを更新してからプラグインを更新します。

```bash
claude plugin marketplace update prtimes-cli
claude plugin update prtimes-cli@prtimes-cli
```

### Codex

```bash
codex plugin marketplace add shoot16625/prtimes-cli
```

続けて `/plugins`（CLI）またはサイドバーの **Plugins**（アプリ）を開き、**prtimes-cli** をインストールします。

### Cursor

```text
/add-plugin https://github.com/shoot16625/prtimes-cli
```

### Gemini CLI

```bash
gemini extensions install https://github.com/shoot16625/prtimes-cli
gemini extensions update prtimes-cli   # 更新するとき
```

### GitHub Copilot CLI

```bash
copilot plugin marketplace add shoot16625/prtimes-cli
copilot plugin install prtimes-cli@prtimes-cli
```

### Factory Droid

```bash
droid plugin marketplace add https://github.com/shoot16625/prtimes-cli
droid plugin install prtimes-cli@prtimes-cli
```

### Qwen Code

```bash
qwen extensions install shoot16625/prtimes-cli
```

### Devin CLI

```bash
devin plugins install shoot16625/prtimes-cli
```

### Kimi Code

```text
/plugins install https://github.com/shoot16625/prtimes-cli
```

### Antigravity

```bash
agy plugin install https://github.com/shoot16625/prtimes-cli
```

### Pi

```bash
pi install git:github.com/shoot16625/prtimes-cli
```

### その他のエージェント（OpenCode、Windsurf、Cline など）

```bash
npx skills add shoot16625/prtimes-cli
bun add -g github:shoot16625/prtimes-cli   # スキルだけがコピーされるので、CLI も入れる
```

### CLI のみ（任意）

```bash
bun add -g github:shoot16625/prtimes-cli
```

## スキル

| スキル | できること |
|---|---|
| `prtimes-cli:draft` | Markdown からプレスリリースの下書きを作成・更新・削除し、追加情報を設定して予約配信で申請 |
| `prtimes-cli:releases` | 自社のリリースの一覧と本文、ダッシュボードの数字 |

使用例:「`release.md` を PR TIMES に下書き保存して」「この下書きのキーワードとカテゴリを考えて設定して」「11月20日10時で予約配信して」「PR TIMES の下書きを一覧にして」「今月の PR TIMES のページビューは？」

## ログイン

```bash
prtimes-cli auth login                  # Chrome/Edge/Chromium でログインページを開くので、そこでログインする
prtimes-cli auth login --browser "/path/to/chrome"
prtimes-cli auth login --email you@example.com          # メールアドレスとパスワードでログイン（パスワードは入力を隠して聞かれる）
printf '%s\n' "$PASSWORD" | prtimes-cli auth login --email you@example.com --password-stdin
prtimes-cli auth import --cookie 'srvssid=...; prtimes_auth_token=...'   # DevTools からコピーした Cookie リクエストヘッダー
prtimes-cli auth status
prtimes-cli auth logout
```

`auth login` は使い捨てのブラウザプロファイルを開き、企業ユーザーとしてログインしたあとの Cookie を Chrome DevTools Protocol 経由で読み取ります。普段使っているブラウザのプロファイルには触れません。パスワードを CLI に渡す必要はありません。

`auth login --email` は、ブラウザを使わずにログインフォームへメールアドレスとパスワードを送ります。パスワードは端末で入力を隠して聞くほか、`--password-stdin`（標準入力の1行目）か環境変数 `PRTIMES_PASSWORD` で渡せます。シェル履歴に残らないよう、パスワードをコマンドライン引数で渡すオプションはありません。パスワードは保存しません。二段階認証など、メールアドレスとパスワード以外の手順を求められた場合は `LOGIN_UNSUPPORTED` で止まるので、ブラウザ方式の `auth login` を使ってください。

CI などでは、`PRTIMES_EMAIL` と `PRTIMES_PASSWORD` を設定しておくと、セッションが無いときや更新できなくなったときに自動でログインし直します（`PRTIMES_COOKIE` を設定している場合は使いません）。

PR TIMES の認証トークンは約24時間で切れますが、`auth login` で保存したセッションにはリフレッシュトークンも含まれるため、CLI が自動で更新します。`auth import` で取り込んだ Cookie にはリフレッシュトークンが含まれない（`HttpOnly` かつパスが `/auth` のため）ので、1日ほどで再ログインが必要です。

セッションは `~/.config/prtimes-cli/session.json` にパーミッション 0600 で保存されます。環境変数 `PRTIMES_COOKIE` を設定すると、保存済みのセッションより優先されます。

## コマンド

```bash
# 下書き
prtimes-cli draft create release.md [--title T] [--subtitle S] [--main-image main.png] [--dry-run]
prtimes-cli draft update <release_id|url> release.md [--title T] [--subtitle S] [--main-image main.png] [--dry-run]
prtimes-cli draft delete <release_id|url> --yes

# 追加情報の設定と申請
prtimes-cli draft options                                   # 目的、種類、ビジネスカテゴリの選択肢
prtimes-cli draft settings <release_id|url> [release.md] [--purpose 目的] [--type 種類] [--category カテゴリ] [--subcategory カテゴリ|none] [--keywords "a,b"] [--url URL] [--at "YYYY-MM-DD HH:MM"] [--dry-run]
prtimes-cli draft submit <release_id|url> [--at "YYYY-MM-DD HH:MM"] [--yes]   # 予約配信で申請。--yes がなければ送る内容を表示するだけ
prtimes-cli draft unsubmit <release_id|url> --yes            # 予約配信を下書きに戻す

# リリースの確認
prtimes-cli release list [--page N] [--limit N] [--search 語句] [--status draft|scheduled|released|withdrawn_by_review|...]
prtimes-cli release get <release_id|url> [--html] [--max-chars N]

# ダッシュボード
prtimes-cli stats
```

`<release_id|url>` には、リリース ID、管理画面の編集 URL（`release_id=…` を含むもの）、公開 URL（`prtimes.jp/main/html/rd/p/….html`）のどれでも指定できます。

`draft update`、`draft settings`、`draft submit`、`draft delete` は**下書きだけ**を対象にします。配信予約中、配信済み、掲載停止のリリースを指定すると `NOT_DRAFT` で止まります。`draft update` はタイトル、サブタイトル、本文、画像と、フロントマターに書いた設定だけを置き換え、それ以外の設定はそのまま残します。

### 追加情報と予約配信

- `--purpose`、`--type`、`--category`、`--subcategory` には、`draft options` の ID か名前をそのまま指定します。ビジネスカテゴリは細分類（`businessCategories[].items`）から選びます。`--category`（申請に必須）と `--subcategory`（任意）は別々の2つのカテゴリで、同じものは指定できません。同じ名前が複数のグループにあるときは `"グループ > 名前"` と書きます。
- `--keywords` はキーワードの一覧を置き換えます。`,` か `、` で区切り、1つ60文字までです。`--url` は関連URL（240文字まで）です。
- `--at` は日本時間で、10分単位で、現在時刻より10分以上先の日時です（管理画面と同じルール）。`draft settings` で指定すると、下書きのまま日時だけを保存します。ただし、そのあと管理画面で下書きを編集すると、保存した日時は今日の 0:00 に戻ります。申請するときは `draft submit --at` で日時を渡すのが確実です。
- フロントマターでも指定できます（`purpose:`、`type:`、`category:`、`subcategory:`、`keywords: [a, b]`、`url:`、`scheduledAt:`）。`draft create`、`draft update`、`draft settings <id> release.md` で使われ、オプションのほうが優先されます。指定しなかった項目は、今の値のまま残ります。
- `draft submit` の前に、タイトル、本文、メイン画像、目的、種類、ビジネスカテゴリ、10分以上先の配信日時がそろっているかを確認し、足りなければ `INCOMPLETE` で止めます。配信先は自動選択になります。

エラーは `{"error": {"code", "message", ...}}` の形式で stderr に出力されます。終了コードはエラー時が 1、使い方の誤りが 2 です。

### Markdown の変換

| Markdown | PR TIMES |
|---|---|
| フロントマターの `title:`、または先頭の `# 見出し` | タイトル（100文字まで） |
| フロントマターの `subtitle:` | サブタイトル（100文字まで） |
| `#` / `##` | 中見出し |
| `###` | 小見出し |
| `####` 以降 | 太字の段落 |
| 段落内の改行 | 改行 |
| 太字、斜体、リンク、箇条書き、番号付きリスト、水平線 | そのまま |
| 引用（`>`） | 囲み |
| `※` で始まる段落 | 注釈 |
| ローカルパスの画像（`![](img/a.png "キャプション")`） | アップロードして画像ブロックにする。title はキャプション。PNG、JPEG、GIF で 10 MB まで、30 枚まで |
| URL の画像 | リンクに置き換え、警告を出す |
| 1行だけの YouTube の URL | YouTube の埋め込み |
| コードブロック | 段落にして警告を出す |
| 表 | 1行ずつ段落にして警告を出す（表ブロックは管理画面で作り直す） |
| HTML | エスケープして警告を出す |

メイン画像は `--main-image` またはフロントマターの `mainImage:` で指定します。指定がなければ本文の最初の画像がメイン画像になります。本文は 8,000 文字まで（超えると警告）です。

`--dry-run` は画像を読み込んで検証し、変換後の HTML を出力しますが、通信はしません。

### 環境変数

| 変数 | 用途 |
|---|---|
| `PRTIMES_COOKIE` | Cookie ヘッダー文字列。保存済みのセッションより優先される |
| `PRTIMES_CLI_HOME` | セッションを保存するディレクトリ |
| `PRTIMES_EMAIL` | `auth login --email` を省略したときのメールアドレス。`PRTIMES_PASSWORD` と両方あれば、セッションが無いときや切れたときに自動でログインする |
| `PRTIMES_PASSWORD` | パスワード方式のログインで使うパスワード |
| `PRTIMES_CLI_BROWSER` | `auth login` で使うブラウザの実行ファイル |
| `PRTIMES_CLI_INTERVAL_MS` | リクエスト間の最小間隔（デフォルト 500 ms） |
| `PRTIMES_CLI_DEBUG` | リクエスト URL を stderr に出力する |

## 未対応の機能

- 今すぐ配信
- 位置情報、フッター（メディア関係者への追加情報）、メールの件名や本文の設定、メディアリストの手動選択
- 表ブロック、ボタン、PDF などのファイル添付、YouTube 以外の埋め込み
- ストーリー、Webクリッピング

## 開発

```bash
bun install
bun run dev release list          # ソースから実行
bun run build                     # src/ を dist/prtimes-cli.js にバンドル（生成物もコミットする）
bun run check                     # 型チェック、テスト、ビルド、dist/ が最新かどうかの確認
```

リポジトリの構成とマニフェストの扱いは [note-cli](https://github.com/shoot16625/note-cli) と同じです。バージョンを上げるときはすべてのマニフェストを更新してください。`test/manifests.test.ts` が `package.json` と一致しているかを確認します。

ドキュメントは README のみ日本語で書き、スキル（`skills/`）やコード、マニフェストは英語で書きます。
