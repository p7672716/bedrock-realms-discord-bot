# Bedrock Realms Discord Bot

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

Minecraft Bedrock Edition のRealmを監視し、プレイヤーの入退室と取得可能なRealmイベントをDiscordへ通知するセルフホスト型BOTです。DiscordからRealm情報をオンデマンドで照会できます。

## 対応機能

- Microsoft/Xbox device-code認証
- Realm参加権限を持つ通常参加者アカウントでの接続
- 1分間隔のオンライン状態差分検出
- 入室・退室通知（現在オンライン一覧付き）
- 起動時の既存プレイヤーを入室扱いしないベースライン処理
- JSONファイルによる通知済みイベントと監視状態の永続化
- `/online` `/realm` `/location`
- Realmごとの保存地点管理（保存・一覧・検索・詳細表示・項目編集・画像管理）
- 保存地点の名称重複防止、座標、ディメンション、備考、作成者、画像の永続化
- 指定形式の入退室通知とRealm Event通知（同梱した公式準拠画像を対応イベントに添付）
- Docker / Google Compute Engine向けの常時稼働構成

## 重要な制約

Bedrock Realmsの基本API（Realm情報、接続先、オンラインプレイヤー）は利用できます。一方、Realm Hub / Story Feed / Timelineのイベント一覧取得パスは、Minecraftクライアント向けの公開・安定した仕様として提供されていません。したがって本プロジェクトでは、イベント取得を差し替え可能なパス設定にし、確認済みのエンドポイントを利用者が設定した場合だけ自動通知します。

`REALM_STORY_EVENTS_PATH_TEMPLATE` が空のままでも、オンライン監視と通常のRealm照会は利用できます。イベント監視の応答形式は配列、または `events` / `stories` / `items` / `data` / `timeline` を含むJSONを受け付けます。

プレイヤー監視は標準で `PRESENCE_SOURCE=protocol` です。BOTが対象Realmへ参加するため、Realm内にBOTアカウントがオンラインプレイヤーとして見え、同時接続数を1枠使用します。これを避ける場合は `PRESENCE_SOURCE=api` に変更できますが、Bedrockの `/activities/live/players` は空の結果を返すことがあるため、厳密な監視にはprotocolモードを推奨します。

最新のBedrock Realmが `/join` で `NETHERNET_JSONRPC` とUUID形式の `address` を返す場合は、Realm APIの応答を判定してNetherNet/WebRTCシグナリングへ自動的に切り替えます。従来の `DEFAULT` と `host:port` を返すRealmでは、従来どおりRakNetを使用します。NetherNet対応に必要なUDP/WebRTC通信がVMやネットワークで制限されている場合は、接続できないことがあります。

## 必要なもの

- Node.js 22以上、またはDocker
- Discord BOTとアプリケーションID
- 対象Realmに参加できるMicrosoft/Xboxアカウント
- 対象RealmのID

Realm IDはRealms APIまたはクライアントのRealm情報から確認します。招待コードだけを持っている場合は、対象アカウントで一度Realmに参加してからIDを設定してください。

## Discord BOT設定

1. Discord Developer PortalでApplicationを作成します。
2. Botを追加し、Tokenを発行します。Tokenは `.env` にだけ保存し、公開リポジトリへコミットしません。
3. `DISCORD_APPLICATION_ID` にApplication IDを設定します。
4. BOTをサーバーへ招待します。Scopesは `bot` と `applications.commands`、権限は少なくとも通知先チャンネルの `View Channel` と `Send Messages` を付与します。
5. 開発中は `DISCORD_GUILD_ID` を設定してください。ギルドコマンドとして即時反映されます。未設定の場合はグローバルコマンドになり、反映に時間がかかることがあります。

## Microsoft/Xbox認証

初回起動時にログへMicrosoftのdevice codeが表示されます。表示されたURLをブラウザで開き、コードを入力してください。認証トークンは `DATA_DIR/auth` にキャッシュされ、通常の再起動では再認証を要求されません。

認証に使うアカウントはRealmオーナーである必要はありません。対象Realmに参加できる通常参加者であれば、アカウントに許可された範囲で動作します。認証キャッシュを失う、またはMicrosoft側で再認証が必要になった場合は、再度device code認証を行います。

## 設定

`.env.example` を `.env` にコピーして編集します。

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Discord BOT Token |
| `DISCORD_APPLICATION_ID` | Yes | Discord Application ID |
| `DISCORD_GUILD_ID` | 推奨 | スラッシュコマンドを即時登録するサーバーID |
| `DISCORD_NOTIFY_CHANNEL_ID` | 条件付き | 全Realm共通の通知先チャンネル |
| `AUTH_CACHE_KEY` | No | Microsoft認証キャッシュの識別名 |
| `BEDROCK_VERSION` | No | bedrock-protocolが対応するBedrockバージョン |
| `RAKNET_BACKEND` | No | `raknet-native`（推奨）または`jsp-raknet` |
| `REALMS_JSON` | Yes | 監視対象RealmのJSON配列 |
| `DATA_DIR` | No | 状態と認証キャッシュの保存先 |
| `PRESENCE_SOURCE` | No | `protocol` または `api` |
| `PRESENCE_POLL_MS` | No | オンライン差分確認間隔。既定値60000 |
| `STORY_POLL_MS` | No | Storyイベント確認間隔。既定値60000 |
| `REALM_STORY_EVENTS_PATH_TEMPLATE` | No | Storyイベント取得パス。未設定ならイベント監視を無効化 |

Realmごとの通知先を分ける場合は、次のように `notificationChannelId` を設定します。

```json
[
  {"id":"1234567890","name":"Survival","notificationChannelId":"111111111111111111"},
  {"id":"9876543210","name":"Creative","notificationChannelId":"222222222222222222"}
]
```

## Realm Event画像

イベント画像は外部URLから取得せず、`assets/events` に同梱したMinecraft Bedrock EditionのRealm Event / Realm Stories用GUIアセット33枚を使用します。イベント種別または内容が対応しない場合は、画像を添付せずテキストだけを送信します。

画像の出典と権利上の注意は [assets/events/NOTICE.md](./assets/events/NOTICE.md) を参照してください。

## ローカル起動

```powershell
npm install
Copy-Item .env.example .env
# .envを編集
npm run dev
```

本番用の型チェック・ビルド・起動は次のとおりです。

```powershell
npm run check
npm test
npm run build
npm start
```

## Docker起動

```powershell
Copy-Item .env.example .env
# .envを編集
docker compose up -d --build
docker compose logs -f bot
```

`./data` をコンテナ外へマウントするため、コンテナの再作成やVM再起動後も認証キャッシュと監視状態を維持できます。

## Google Cloud Compute Engine無料枠での運用例

無料枠の対象条件・対象リージョン・外部IPなどの条件はGoogle Cloud側で変更される可能性があるため、作成時にGoogle CloudのAlways Free条件を確認してください。

1. 無料枠対象の小規模VM（Linux、常時稼働可能な構成）を作成します。
2. SSHで接続し、Dockerをインストールします。
3. リポジトリをcloneし、`.env` を作成します。
4. `docker compose up -d --build` を実行します。
5. 初回ログのdevice codeでMicrosoft認証を完了します。
6. `docker compose logs -f bot` でDiscord接続とRealm監視開始を確認します。

VMのディスク上にある `data` ディレクトリを削除しないでください。削除するとMicrosoft認証キャッシュが失われ、監視状態も初期化されます。Discord Token、認証キャッシュ、Realm情報は公開リポジトリやIssueへ貼らないでください。

NetherNet対応は、`bedrock-protocol`の現在のRakNet APIへ、固定コミットの`nethernet`実装とRealm用JSON-RPCシグナリングを接続しています。依存先の更新で接続仕様が変わる可能性があるため、`package-lock.json`の更新を伴わない依存更新は避けてください。

## 自動処理の範囲

常時自動で行うのは、オンライン差分確認、入退室通知、設定済みStoryイベントの差分確認、Realmイベント通知だけです。Realm情報、接続情報はスラッシュコマンド実行時に取得します。

イベント監視は起動時に取得した履歴を通知せず、現在値をベースラインとして保存します。その後に現れたイベントだけを通知し、`data/state.json` に保存したイベントIDで重複通知を防ぎます。

## スラッシュコマンド

| コマンド | 内容 |
| --- | --- |
| `/online` | 現在オンラインのプレイヤーと人数 |
| `/realm` | Realm名、ID、状態、説明、最大人数、難易度、接続情報 |
| `/location save` | 名称付きの座標を保存します。ディメンション省略時はオーバーワールドです |
| `/location list` | ディメンション別に保存地点名を一覧表示します |
| `/location search` | 名称または備考を検索します |
| `/location show` | 保存地点の座標、備考、作成者、画像を表示します |
| `/location delete` | 指定した保存地点を削除します |
| `/location edit` | 保存地点の名称、座標、ディメンション、備考を項目単位で編集します |
| `/location image add` | コマンド直後に同じチャンネルへ投稿された画像を保存地点へ追加します |
| `/location image remove` | `show`で表示された画像番号を指定して画像を削除します |

`/realm` はRealm情報に加えて、接続ホスト、ポート、リージョンも表示します。

### 保存地点の使い方

保存地点はRealmごとに管理され、名称は大文字小文字や全角半角を区別せず重複禁止です。保存時にはX・Y・Z座標を指定し、`dimension` を省略するとオーバーワールドになります。備考と作成者も保存されます。

保存地点の構文は次のとおりです。`<>` は必須、`[]` は任意項目です。

```text
/location save <名称> <x> <y> <z> [ディメンション] [備考]
/location list
/location search <検索ワード>
/location show <名称>
/location delete <名称>
/location edit <名称> <項目名> <変更後>
/location image add <名称>
/location image remove <名称> <画像番号>
```

Discord上では、実際には入力欄として表示されます。保存時のディメンションは `オーバーワールド` / `overworld`、`ネザー` / `nether`、`エンド` / `end` に対応し、省略時はオーバーワールドです。

例：

```text
/location save name:拠点 x:120 y:64 z:-35 dimension:overworld note:倉庫とネザーゲート
/location list
/location search query:倉庫
/location show name:拠点
/location delete name:旧拠点
/location edit target:拠点 field:name value:新拠点
/location edit target:拠点 field:coordinates x:130 y:65 z:-40
/location edit target:拠点 field:dimension value:nether
/location edit target:拠点 field:note value:ネザー側の入口
/location image add target:拠点
（BOTの案内後、同じチャンネルへ画像を投稿）
/location image remove target:拠点 image_index:1
```

編集項目は `名称`、`座標`、`ディメンション`、`備考` です。座標を変更する場合はX・Y・Zをすべて指定します。画像は保存時または `/location image add` で追加でき、画像追加ではBOTの案内から60秒以内に、コマンドを実行したユーザーが同じチャンネルへ投稿した画像を対象にします。`show` の画像一覧に表示される番号を `/location image remove` に指定して削除します。画像URLは保存時の `image_urls` に改行またはカンマ区切りで複数指定できます。

保存地点のデータは `DATA_DIR/state.json` に保存されるため、VMやBOTを再起動しても維持されます。

実際のDiscord表示例は [docs/response-examples.md](./docs/response-examples.md) を参照してください。

## ライセンス

MIT License。詳細は [LICENSE](./LICENSE) を参照してください。
