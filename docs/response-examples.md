# 応答例

以下はDiscord上での表示形式の例です。実際のプレイヤー名、イベント内容、座標は取得結果に置き換わります。

## 入室通知

```text
🟢 Alex（Alex）がログインしました。
現在：Alex（Alex）, Steve（Steve）, CreeperHunter（未紐付け）
```

## 退室通知

```text
🔴 Steve（Steve）がログアウトしました。
現在：Alex（Alex）, CreeperHunter（未紐付け）
```

## Realmイベント通知

```text
ダイヤモンドを発見しました
達成者：Alex（Alex）
座標：120, 64, -35
```

同梱された対応画像があるイベントの場合は、上記メッセージに画像を添付します。対応画像がない場合は画像を送信しません。

## `/online`

```text
オンライン人数：3
プレイヤー：Alex（Alex）, Steve（Steve）, CreeperHunter（未紐付け）
```

## `/realm`

```text
Realm名：My Realm
Realm ID：1234567890
稼働状態：Open
説明：Survival World
最大人数：10
難易度：Normal
接続ホスト：realm-production-eastus.example
ポート：19132
リージョン：eastus
```

## 取得できない情報がある場合

Realm側の権限やAPIの応答に含まれない情報は、次のように表示されます。

```text
取得できませんでした
```

## `/location save`

```text
保存地点を保存しました。
名称：拠点
座標：120, 64, -35
ディメンション：オーバーワールド
作成者：Alex（Alex）
備考：倉庫とネザーゲート
```

## `/location list`

```text
保存地点一覧

### オーバーワールド
- 拠点
- 村

### ネザー
- ネザー拠点
```

## `/location search`

```text
検索結果：倉庫（1件）

### オーバーワールド
- 拠点
  - 備考：倉庫とネザーゲート
```

## `/location show`

```text
名称：拠点
座標：120, 64, -35
ディメンション：オーバーワールド
作成者：Alex（Alex）
備考：倉庫とネザーゲート
画像：
- 1. [拠点全体.png](https://cdn.example.com/base.png)
- 2. [倉庫.png](https://cdn.example.com/storage.png)
```

## `/location edit`

名称を変更する場合：

```text
/location edit target:拠点 field:name value:新拠点
```

応答：

```text
保存地点を更新しました。
名称：新拠点
座標：120, 64, -35
ディメンション：オーバーワールド
作成者：Alex
備考：倉庫とネザーゲート
```

## `/location delete`

```text
/location delete name:旧拠点
```

応答：

```text
保存地点「旧拠点」を削除しました。
```

座標を変更する場合：

```text
/location edit target:新拠点 field:coordinates x:130 y:65 z:-40
```

画像を追加する場合：

```text
/location image add target:新拠点
```

応答：

```text
保存地点「新拠点」に追加する画像を、このチャンネルへ60秒以内に投稿してください。
```

その後、同じユーザーが同じチャンネルへ画像を投稿すると保存されます。

画像を削除する場合：

```text
/location image remove target:新拠点 image_index:1
```

## `/player link`

```text
/player link player_name:Alex role_name:建築担当
```

```text
プレイヤー「Alex（建築担当）」とDiscordアカウントを紐づけました。専用ロールはメンション不可です。
```

## `/monitor status`

```text
監視状態：有効
認証状態：認証が必要
認証URL：https://www.microsoft.com/link
コード：ABCD1234
```

監視用アカウントがゲーム内で使用中の場合は、次のエラーを表示します。

```text
監視用アカウントはMinecraft本体または別端末で使用中のため、BOTがRealmへログインできません。Minecraftからログアウトしてから `/monitor login` を再実行してください。
```
