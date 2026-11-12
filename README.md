# prtimes-cli

[PR TIMES](https://prtimes.jp) の企業向け管理画面が使っている**非公式** API を使った CLI と、エージェント用プラグインです。Claude Code、Codex、Cursor、Gemini CLI などの AI コーディングエージェントから操作することを想定しています。すべてのコマンドは JSON を出力します。

- **下書き**: Markdown をエディタ用の HTML に変換して、プレスリリースの下書きを作成・更新します。ローカル画像のアップロードとメイン画像の設定、見出し、箇条書き、囲み、注釈、YouTube の埋め込みに対応しています。
- **確認**: 自社のプレスリリースの一覧（下書き、配信予約、配信済み）と、各リリースの本文を取得できます。
- **数字**: ダッシュボードの直近1か月の数字（ページビュー、訪問者数、転載サイト数、フォロワー数、PV とソーシャルの上位3件）を確認できます。

**審査への申請と配信はしません。** カテゴリ、キーワード、配信日時、メディアリストの設定と申請は、PR TIMES の管理画面で行ってください。CLI は下書きを作ったあと、編集画面とプレビューの URL を返します。

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
| `prtimes-cli:draft` | Markdown からプレスリリースの下書きを作成・更新・削除 |
| `prtimes-cli:releases` | 自社のリリースの一覧と本文、ダッシュボードの数字 |

使用例:「`release.md` を PR TIMES に下書き保存して」「PR TIMES の下書きを一覧にして」「今月の PR TIMES のページビューは？」

## ログイン

```bash
prtimes-cli auth login                  # Chrome/Edge/Chromium でログインページを開くので、そこでログインする
prtimes-cli auth login --browser "/path/to/chrome"
prtimes-cli auth import --cookie 'srvssid=...; prtimes_auth_token=...'   # DevTools からコピーした Cookie リクエストヘッダー
prtimes-cli auth status
prtimes-cli auth logout
```

`auth login` は使い捨てのブラウザプロファイルを開き、企業ユーザーとしてログインしたあとの Cookie を Chrome DevTools Protocol 経由で読み取ります。普段使っているブラウザのプロファイルには触れません。パスワードを CLI に渡す必要はありません。

PR TIMES の認証トークンは約24時間で切れますが、`auth login` で保存したセッションにはリフレッシュトークンも含まれるため、CLI が自動で更新します。`auth import` で取り込んだ Cookie にはリフレッシュトークンが含まれない（`HttpOnly` かつパスが `/auth` のため）ので、1日ほどで再ログインが必要です。

セッションは `~/.config/prtimes-cli/session.json` にパーミッション 0600 で保存されます。環境変数 `PRTIMES_COOKIE` を設定すると、保存済みのセッションより優先されます。

## コマンド

```bash
# 下書き
prtimes-cli draft create release.md [--title T] [--subtitle S] [--main-image main.png] [--dry-run]
prtimes-cli draft update <release_id|url> release.md [--title T] [--subtitle S] [--main-image main.png] [--dry-run]
prtimes-cli draft delete <release_id|url> --yes

# リリースの確認
prtimes-cli release list [--page N] [--limit N] [--search 語句] [--status draft|reserved|released|withdrawn_by_review]
prtimes-cli release get <release_id|url> [--html] [--max-chars N]

# ダッシュボード
prtimes-cli stats
```

`<release_id|url>` には、リリース ID、管理画面の編集 URL（`release_id=…` を含むもの）、公開 URL（`prtimes.jp/main/html/rd/p/….html`）のどれでも指定できます。

`draft update` と `draft delete` は**下書きだけ**を対象にします。配信予約中、配信済み、掲載停止のリリースを指定すると `NOT_DRAFT` で止まります。`draft update` は CLI が扱わない設定（カテゴリ、キーワード、配信設定、メディアリストなど）をそのまま残し、タイトル、サブタイトル、本文、画像だけを置き換えます。

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
| `PRTIMES_CLI_BROWSER` | `auth login` で使うブラウザの実行ファイル |
| `PRTIMES_CLI_INTERVAL_MS` | リクエスト間の最小間隔（デフォルト 500 ms） |
| `PRTIMES_CLI_DEBUG` | リクエスト URL を stderr に出力する |

## 未対応の機能

- 審査への申請、配信、配信予約
- カテゴリ、キーワード、所在地、配信日時、メディアリストの設定
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
