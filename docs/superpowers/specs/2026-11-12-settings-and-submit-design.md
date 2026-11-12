# 追加情報の設定と予約配信の申請

日付: 2026-11-12

## 目的と背景

いまの prtimes-cli は下書きの本文（タイトル、サブタイトル、本文、画像）までしか扱えない。ユーザーは下書きを作ったあと、管理画面で「次へ」に進み、目的、種類、カテゴリ、キーワードを手で入力して申請している。キーワードやカテゴリは、リリースごとに本文を読んで考えている。

この作業を CLI とエージェントで済ませられるようにする。エージェントが本文と選択肢の一覧を見比べて案を出し、ユーザーが確認してから CLI で保存し、ユーザーが明示的に頼んだときに予約配信として申請する。

## ゴール

- 下書きの「追加情報設定」（目的、種類、ビジネスカテゴリのメインとサブ、キーワード、関連URL）を CLI から保存できる
- 選択肢（目的、種類、カテゴリ、サブカテゴリ）の一覧を JSON で取得できる
- 予約配信として申請できる（PR TIMES では、予約配信にした時点で「審査中」になる）
- 予約を取り消して下書きに戻せる
- エージェント用のスキルで、案を出す → ユーザーが確認する → 保存する → 頼まれたら申請する、という流れを案内する

## やらないこと

- **今すぐ配信**（ユーザーの判断。予約配信だけにする）
- 配信先のメディアリストの手動指定（ユーザーはいつも自動選択を使っている）
- 位置情報、フッター（メディア向けの問い合わせ先）、メールの件名や本文の先頭、FAX、テストメール、ドキュメントの添付、関連リリース
- 予約中・配信済みのリリースの内容変更

## 絶対に避けること

- ユーザーが明示的に頼んでいないのに申請すること
- 保存のときに、CLI が扱わない既存の設定（キーワード、配信設定、メール設定など）を消したり、デフォルト値で上書きしたりすること
- `--yes` なしで申請・取り消しの通信をすること

## 調査で分かった API（2026-11-12 時点）

管理画面のエディタ（`/static/prtimes/js/vite/...`）は OpenAPI から生成されたクライアントを使っている。ベースは `/api/press_release_editor.php`。

### 選択肢の一覧

- `GET /press_release/editor` → `data.release_types[] {release_type_id: "01", release_type_name}`（7件）、`data.business_categories[] {busi_cate_id: "001", busi_cate_name, lv2: [...]}`（27件のグループ。`lv2` が実際に選ぶ細分類）、`edit_started_at`
- `GET /purposes` → `data[] {category_name, purpose_list[] {purpose_id: 1, purpose_name}}`
- **ビジネスカテゴリの ID は `lv2`（細分類）の ID。** `lv2` の要素は `{id: 9, name: "システム・Webサイト・アプリ開発"}` で、ID は全カテゴリを通した連番。`busi_cate_id_main`（必須）と `busi_cate_id_sub`（任意）は、どちらも `lv2` の ID を入れる。親カテゴリをまたいでもよい（リリース 203 は、main = 9「企業向けシステム・通信・機器 > システム・Webサイト・アプリ開発」、sub = 11「流通 > EC・通販」）。画面の「サブカテゴリ」は、メインの下位分類ではなく、2つめのカテゴリのこと。
- `release_type_id` は文字列（`"01"`）、`purpose_id` は数値。
- 画面の入力チェック: 目的は必須（1以上）、種類は必須、メインカテゴリは必須（1以上）、サブカテゴリは null 可でメインと同じ値は不可、キーワードは1つ60文字まで（数の上限は画面のチェックにはない。リリース 203 は10個）、関連URLは240文字までで URL の形式。

### 保存（下書きのまま）

`PUT /press_release/{id}/auto_save`（CLI が本文の保存にすでに使っている）。`press_release` には次のフィールドがすべて入る（エディタの `AutoSavePressReleaseRequestBody` より）。

`editor_version, title, subtitle, head, text, footer, reference_url, image_file_name_main, image_file_name_main_s3, images, gif_animations, release_file_name, reference_file_name, media_release_file_name, media_reference_file_name, locations, keywords, release_type_id, busi_cate_id_main, busi_cate_id_sub, release_send_target_type, company_release_media_join_master_id, company_m_my_release_media_master_id, release_additional_headline_flg, release_additional_fax_flg, release_fax_file_name, mail_title_prefix_flg, mail_title_prefix_text, mail_title_prefix_company_name_flg, mail_title_replacing_flg, mail_title, mail_body_head_flg, mail_body_head_text, media_user_sendmail_flg, socialmedia_user_sendmail_flg, other_site_send_flg, release_media_user_only_flg, release_media_list_only_flg, is_file_download_unavailable, release_date, release_time_kbn_2, twitter_send_flg, facebook_send_flg, purpose_id, template_id`

**今の `SAVE_FIELDS`（`src/api.ts`）には、このうち `reference_url`、`gif_animations`、`release_type_id`、`busi_cate_id_main`、`busi_cate_id_sub`、`mail_title_prefix_flg`、`mail_title_prefix_text`、`release_date`、`release_time_kbn_2`、`purpose_id`、`template_id` が入っていない。** これらを送らないとサーバー側で消えるのかどうかは分かっていない。いずれにしても、全フィールドを今のリリースの値から引き継ぐように直す。これで、既存の `draft update` が設定を消すおそれもなくなる。

### 申請（予約配信）と取り消し

`PUT /press_release/{id}`（エディタの `updatePressRelease`）。ボディは次のとおり。

```json
{
  "press_release": { "...auto_save と同じ全フィールド": "...", "release_send_kbn": 3, "release_date": "2026-11-20", "release_time_kbn_2": "1000" },
  "csrf_token": "...", "edit_started_at": 1794461551, "company_id": 85052, "is_force_mode": false
}
```

- `release_send_kbn`: 1 = 下書き、2 = 今すぐ配信（**使わない**）、3 = 予約配信
- `release_date`: `yyyy-MM-dd`。`release_time_kbn_2`: `HHMM`（時と分をつなげたもの。画面の分の選択は10分単位）。日本時間
- `release_send_target_type`: 1 = 手動、2 = 自動。過去に配信したリリース 203 は 2 で、メディアリストの ID は null だった
- 取り消しは同じ API に `release_send_kbn: 1` を送る（エディタの「予約配信を下書きに戻す」と同じ操作）
- 予約中のリリースは `delivery_status: "scheduled"`。ステータスの値は `draft, released, scheduled, unpublish_requested, unpublished, republish_reserved, published_media_list_only, withdrawn_by_review`
- レスポンスは `data.edit_started_at`（auto_save と同じ）

## コマンド

### `draft options`

選択肢の一覧を出力する。エージェントはこれを見て案を作る。

```json
{
  "purposes": [{ "category": "マーケティング／PR", "items": [{ "id": 1, "name": "新サービス開始" }] }],
  "releaseTypes": [{ "id": "01", "name": "商品サービス" }],
  "businessCategories": [{ "group": "企業向けシステム・通信・機器", "items": [{ "id": 9, "name": "システム・Webサイト・アプリ開発" }] }]
}
```

### `draft settings <release_id|url> [file.md] [--purpose <id|名前>] [--type <id|名前>] [--category <id|名前>] [--subcategory <id|名前>] [--keywords <a,b,c>] [--url <URL>] [--at "YYYY-MM-DD HH:MM"] [--dry-run]`

- 下書きの追加情報を保存する。下書き以外を指定したときは `NOT_DRAFT` で止める（今の `assertDraft` と同じ）
- 値はオプションか、`file.md` のフロントマターで指定する（`purpose:`、`type:`、`category:`、`subcategory:`、`keywords:`（配列またはカンマ区切り）、`url:`）。両方あるときはオプションを優先する
- 名前は、選択肢の名前と完全に一致したときだけ受け付ける。見つからないとき（`INVALID_OPTION`）は、候補をエラーに含める
- `--category` と `--subcategory` には、どちらも `lv2` の ID または名前を指定する。名前が複数のグループにあるときは「グループ名 > 名前」の形でも指定できるようにする。メインと同じ値をサブに指定したときは拒否する。`--subcategory none` でサブを消せる
- **私の判断**: メインだけを変えて、新しいメインが今のサブと同じ値になったときは `INVALID_OPTION` で止め、`--subcategory` も指定するよう促す（サブは独立した2つめのカテゴリなので、それ以外はそのまま残す）
- 指定しなかった項目は、今の値のまま残す
- 画面と同じ入力チェックをする（キーワードは1つ60文字まで、関連URLは240文字までで http(s) の URL）
- `--at` は予約日時を下書きのまま保存する（`release_date` と `release_time_kbn_2` だけ。`release_send_kbn` は 1 のまま）。管理画面の「配信詳細設定」で日時を入れて保存したのと同じ状態になる。フロントマターでは `scheduledAt:`。**私の判断**: ユーザーの「予約の日時入力まで」に合わせて追加した
- `--dry-run` は、保存する値（名前つき）を出力するだけで、保存しない
- 出力: `releaseId`、保存した各項目（ID と名前）、`editUrl`、`previewUrl`

`draft create` と `draft update` も、フロントマターに上の項目があれば同じように保存する（本文と同じ auto_save で保存する）。

### `draft submit <release_id|url> [--at "YYYY-MM-DD HH:MM"] [--yes]`

- 予約配信で申請する。日時は日本時間で、分は10分単位、未来の日時だけを受け付ける。`--at` がなければ、下書きに保存済みの日時を使う。どちらもなければ `INCOMPLETE`
- 対象は下書きだけ
- 送る前に、必須項目（タイトル、本文、メイン画像、目的、種類、メインカテゴリ）がそろっているかを確認し、足りなければ `INCOMPLETE` で止める。何が足りないかをエラーに含める（**私の判断**: メイン画像は、既存のコードが「配信前に必要」と警告しているので含める。サブタイトルとキーワードは画面のチェックで任意なので含めない。ここに挙げていないサーバー側のチェックは、サーバーのエラーをそのまま返す）
- 配信先は自動選択（`release_send_target_type: 2`）にする
- `--yes` がないときは通信せず、`CONFIRMATION_REQUIRED` を返す。そのとき、申請する内容（タイトル、配信日時、目的・種類・カテゴリの名前、キーワード、配信先 = 自動選択、プレビュー URL）をエラーの `detail` に入れて、エージェントがユーザーに見せられるようにする
- 成功したら、もう一度リリースを取得して `delivery_status` を出力に含める。**私の判断**: サーバーが受け付けた（2xx）なら、ステータスが `scheduled` でなくても成功（`submitted: true`）として扱い、`warnings` に「ステータスが scheduled ではない」と入れる。CLI は自動で再送しない。スキルには「申請を繰り返さず、`release get` で状態を確かめる」と書く
- 出力: `submitted: true`、`releaseId`、`scheduledAt`、`status`、`editUrl`、`previewUrl`

### `draft unsubmit <release_id|url> --yes`

- 予約中（`scheduled`）のリリースを下書きに戻す。それ以外のステータスのときは `NOT_SCHEDULED` で止める
- `--yes` が必要
- 成功したら、`delivery_status` が `draft` に戻ったことを確かめる

### そのほかの変更

- `release get` の出力に、目的、種類、カテゴリの**名前**（ID とあわせて）、関連URL、予約日時（`scheduled` のとき）を加える
- `release list --status` の値を、実際のステータス名（`scheduled` など）に直す。今は `reserved` と書いてあるが、実際の値は `scheduled`

## スキルと README

- `skills/draft/SKILL.md` に次の流れを書く
  1. `draft options` と本文から、目的、種類、カテゴリ、キーワードの案を作り、ユーザーに見せる
  2. ユーザーが了承したら `draft settings` で保存する
  3. 申請は、ユーザーが日時を指定して明示的に頼んだときだけ行う。`--yes` なしで実行して内容を見せ、ユーザーが確認してから `--yes` をつけて実行する
  4. 今すぐ配信はできないことと、予約中は `draft unsubmit` で下書きに戻せることを書く
- README の「審査への申請と配信はしません」を、「予約配信での申請まで。今すぐ配信はしない」に書き換え、コマンドとフロントマターの説明を追加する。「未対応の機能」も更新する
- バージョンは 0.2.0 に上げる（すべてのマニフェストを更新する）

## 確かめ方

- 単体テスト（今の `test/cli.test.ts` と同じ偽の fetch）:
  - settings: 名前から ID への変換、メインとサブが同じときの拒否、指定しなかった項目と CLI が扱わない設定が残ること
  - submit: `--yes` なしでは通信しないこと、必須項目が足りないときに止まること、過去の日時や10分単位でない日時を拒否すること、ボディの `release_send_kbn: 3`、`release_date`、`release_time_kbn_2`、`release_send_target_type: 2`
  - unsubmit: `scheduled` 以外を拒否すること
  - `buildSavePayload` が全フィールドを引き継ぐこと
- 本番での E2E（ユーザーのアカウント）。**申請（`PUT /press_release/{id}` に `release_send_kbn: 3` を送ること）は、本番では一度も実行しない（ユーザーの指示）。** 手順は次のとおり。
  1. テスト用の下書きを作る
  2. `draft settings` で追加情報と予約日時（`--at`、下書きのまま `release_date` と `release_time_kbn_2` だけを保存）を保存する
  3. 管理画面で、追加情報と配信詳細設定の日時が入っていることを確認する
  4. `draft submit`（`--yes` なし）で、送る内容が表示されて通信しないことを確認する
  5. 下書きを削除する
- 申請と取り消しの通信の形は、単体テストと、調査で読んだエディタのコードとの突き合わせだけで確かめる。実際に動くかは、ユーザーが初めて本番で使うときに分かる。README とスキルにも、そのことを書く

## 実装する人に任せること

- オプション名の細部、出力の JSON のキー名（既存のコマンドに合わせる）
- エラーコードの細かい分け方（既存の `CliError` に合わせる）
