# 個人記帳（Personal Expense Tracker）

用 Notion 當資料庫、Cloudflare Worker 當後端的個人收支記帳 PWA。
手機瀏覽器開啟後加入主畫面，就能像原生 App 一樣使用；所有記錄即時寫入你自己的 Notion database，
在電腦前想用 Notion 的表格、看板、圖表怎麼分析都可以。

不需要註冊任何服務的帳號、不需要伺服器、沒有訂閱費 — Notion 與 Cloudflare 的免費額度對個人記帳綽綽有餘。

## 功能

- **記帳**：數字鍵盤快速輸入，支出／收入切換，分類與付款方式一點即選
- **收據辨識**：拍照或選圖，由 Gemini 視覺模型讀出金額、店名、日期、分類，確認後才送出
- **多幣別**：出國消費直接記外幣，匯率可在設定頁維護；**每筆記錄都存下當時用的匯率**，日後調整匯率不會竄改歷史數字
- **常用範本**：房租、訂閱、薪資這類固定收支存成範本，一點帶入名稱與金額
- **統計**：本月收支結餘與上月比較、分類佔比環形圖、月度趨勢折線、每日花費長條、十大支出
- **不計入統計**：信用卡還款、提領現金這類「錢只是換位置」的動作可勾選排除，月支出不會被灌水
- **進階欄位**：選到「行」才出現公里數／公升數，選到「住」才出現水電用量，平常不干擾日常記帳
- **離線記帳**：沒網路時暫存在手機，恢復連線自動同步
- **生物辨識鎖**：可開啟 Face ID／指紋才能進入 App
- **個人化**：淺色／深色／跟隨系統主題，繁體中文／English

## 架構

```
手機 PWA（public/index.html，單檔無框架）
   ↓ fetch /api/*（x-user / x-code 標頭驗證）
Cloudflare Worker（src/worker.js）
   ├─ Cloudflare KV：月份查詢結果快取
   ├─ Notion API 2025-09-03：讀寫收支記錄
   └─ Gemini Interactions API：收據辨識
Notion database「個人收支記錄」
```

- 前後端由同一個 Worker 服務（靜態資源 + API），沒有 CORS 問題
- Notion token、通行碼、Gemini key 只存在 Cloudflare secret，前端程式碼不含任何機密
- **按月查詢**而非一次抓全部：個人帳跑好幾年、累積數千筆之後，開啟速度不會退化
- **KV 快取**：當月 5 分鐘 TTL、過去月份 30 天；經由 App 的任何寫入都會即時清掉受影響月份的快取。
  直接在 Notion 網頁上改東西也會在 5 分鐘內同步過來，或按 App 裡的「更新」立即重抓

## 專案結構

```
personal-expense/
├── wrangler.jsonc          # Cloudflare 設定（不含任何機密）
├── src/worker.js           # API：登入、Notion 讀寫、月度彙總、收據辨識；MOCK=1 時用內建假資料
├── public/
│   ├── index.html          # 前端全部（UI、圖表、i18n、主題、離線佇列）
│   ├── sw.js               # Service Worker 離線快取
│   ├── manifest.webmanifest
│   └── icon-192/512.png
└── .dev.vars.example       # 本地開發環境變數範本
```

## 建置你自己的一份

### 1. 建立 Notion database

新增一個 database，欄位如下（**名稱必須完全一致**，worker.js 用中文欄位名讀寫）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| 名稱 | Title | 項目名稱 |
| 日期 | Date（含時間） | 消費／收入日期 |
| 類型 | Select | `支出`、`收入` |
| 金額 | Number | 原始幣別的金額 |
| 幣別 | Select | `TWD`、`JPY`、`USD`、`EUR`、`KRW`、`CNY` |
| 匯率 | Number | 記帳當下的匯率，TWD 為 1 |
| 台幣金額 | Formula | `prop("金額") * prop("匯率")` — 統計一律以這欄為準 |
| 類別 | Select | 支出：`食` `衣` `住` `行` `娛樂` `醫療健康` `學習進修` `人情社交` `訂閱服務` `其他`<br>收入：`薪資` `獎金` `投資收益` `退款退費` `其他收入` |
| 付款方式 | Select | `現金` `刷卡` `轉帳` `悠遊卡` `儲值卡` `行動支付` |
| 備註 | Text | |
| 不計入統計 | Checkbox | 資金移轉勾選此項 |
| 記錄者 | Select | 由 Worker 自動填入，預留多人擴充 |
| 公里數 / 公升數 / 用量 | Number | 進階欄位 |

分類與付款方式的選項值同時寫在三個地方，要改就三邊一起改：Notion 的 select 選項、
`src/worker.js` 的白名單常數、`public/index.html` 的 `EXPENSE_CATS` / `INCOME_CATS` / `PAYMENTS`。

### 2. 建立 Notion integration 並取得 data source ID

1. 到 [Notion Integrations](https://www.notion.so/my-integrations) 建立一個 internal integration，複製 `ntn_` 開頭的 token
2. 打開你的 database 頁面 → 右上「⋯」→ Connections → 加入剛才那個 integration
3. 取得 **data source ID**（2025-09-03 版 API 的 database 是容器，實際資料掛在底下的 data source）：

   ```bash
   curl -H "Authorization: Bearer $NOTION_TOKEN" \
        -H "Notion-Version: 2025-09-03" \
        https://api.notion.com/v1/databases/<你的 database id>
   ```

   回應裡 `data_sources[0].id` 就是要填給 `NOTION_DS_ID` 的值。
   database id 是 database 網址上那串 32 碼英數字。

### 3. 建立 Cloudflare KV namespace

```bash
npx wrangler kv namespace create personal-expense-cache
```

把回傳的 id 填進 `wrangler.jsonc` 的 `kv_namespaces[0].id`。
（namespace id 不是憑證，沒有 Cloudflare API token 拿它做不了任何事，所以可以放在版控裡。）

### 4. 設定機密

```bash
npx wrangler secret put NOTION_TOKEN     # ntn_ 開頭的 integration token
npx wrangler secret put NOTION_DS_ID     # 上一步取得的 data source ID
npx wrangler secret put PASSCODES        # JSON：{"你的名字":"六碼通行碼"}
npx wrangler secret put GEMINI_API_KEY   # 選用，只有收據辨識需要
```

> Windows PowerShell 用管線傳值會損壞內容，請讓指令跳出提示後再貼上，
> 或改用 `npx wrangler secret bulk <json檔>`。

`GEMINI_API_KEY` 可到 [Google AI Studio](https://aistudio.google.com/apikey) 免費申請。
免費層沒有綁卡就不可能被收費，超過額度只會回 429 拒絕服務。

### 5. 本地開發

```bash
npm install
cp .dev.vars.example .dev.vars    # MOCK=1，使用內建假資料，完全不碰 Notion
npm run dev                        # http://localhost:8788
```

### 6. 部署

```bash
npm run deploy
```

## 環境變數

| 名稱 | 位置 | 說明 |
|---|---|---|
| `NOTION_TOKEN` | secret | Notion integration token |
| `NOTION_DS_ID` | secret | Notion data source ID |
| `PASSCODES` | secret | `{"名字":"通行碼"}` |
| `GEMINI_API_KEY` | secret | 收據辨識用，未設定時掃描功能會回錯誤但其他功能正常 |
| `GEMINI_MODELS` | vars | 模型鏈，逗號分隔，依序嘗試 |
| `MOCK` | .dev.vars | `1` 時使用內建假資料 |
| `CACHE` | KV binding | 月份查詢快取 |

## 實作筆記

- **Notion API 2025-09-03**：查詢端點是 `POST /v1/data_sources/{id}/query`（不是 `/databases/{id}/query`），
  建立頁面的 parent 要用 `{type:"data_source_id", data_source_id:...}`。
  database ID 與 data source ID 不能互換使用。
- **Gemini Interactions API**：2026-06 GA 後取代 `generateContent` 成為預設介面。
  端點 `POST /v1beta/interactions`，模型輸出在 `steps[].content[].text`。
  程式裡保留了模型鏈：遇 429／503／404 自動換下一個模型重打同一個請求。
  兩個容易踩錯的地方（都實測踩過）：
  - **認證用 `x-goog-api-key` 標頭**。AI Studio 的 API key 用 `Authorization: Bearer` 會被當成 OAuth token，
    回 401「Expected OAuth 2 access token」。
  - **結構化輸出是 `response_format: {type:'text', mime_type:'application/json', schema:{...}}`**，
    不是 OpenAI 風格的 `{type:'json_schema', json_schema:{...}}`。另外 `temperature` 不是這個 API 的頂層參數。
- **Cloudflare 部署後約有 10～20 秒的傳播時間**。改完馬上測會打到舊版，看起來像「改了沒效」——
  驗證腳本要留緩衝或做重試。
- **編輯與刪除前會先讀回原記錄**，這樣才知道要讓「哪一個月」的快取失效 —— 編輯有可能把日期改到別的月份。
  多一次 API 呼叫，但編輯是低頻操作，換來快取不會殘留舊值。
- **前端所有選項值都會在 Worker 端過白名單**，前端就算被改也污染不了 Notion 的 select 選項。
- **登入端點有以 IP 為單位的嘗試次數限制**（每小時 10 次），因為 Worker 網址是公開的。
- **生物辨識是本機解鎖層**：WebAuthn 平台憑證通過才解除畫面鎖定，伺服器端真正的驗證仍是通行碼。
  裝置不支援、憑證被刪或驗證失敗時一律可退回輸入通行碼。
- **改過 `public/` 底下任何檔案**，記得把 `sw.js` 的 `CACHE` 版本號 +1，否則舊用戶會拿到快取的舊版。
- **驗證觸控手勢時不要用 `elementFromPoint` 決定事件目標**。在 body 範圍外的畫布區域，
  Chrome 的 `elementFromPoint` 會回傳 `<body>`，直接對它 `dispatchEvent` 等於自己確保監聽器會被觸發，
  測起來一定會過——但真機（WebKit）那裡的目標是 `<html>`。要驗證就把目標明確指定為
  `document.documentElement`，才測得到真實情況。
- 圖表全部是手寫 SVG（環形圖用 `stroke-dasharray` 疊圈、折線用 `polyline`），沒有引入任何圖表函式庫。

## 更新日誌

### v1.1（2026-08-02）
- **主色改為藍色系**：淺色模式天藍 `#1979c5`、深色模式矢車菊藍 `#8bacf2`。
  兩者都先量過對比度才定案（白底 4.58:1、深底 7.69:1，皆通過 WCAG AA）；
  登入頁漸層與 logo 一併調整
- **修正 seg 因 CSS 類別撞名而長高**：記錄列表的類別是 `.exp`（含 `margin-bottom:8px`），
  而支出按鈕的修飾類別也叫 `exp`，害它吃到列表列的外距、把同一行另一顆按鈕撐高 8px。
  修飾類別一律改加 `is-` 前綴。同一個撞名也污染過統計頁的 `.sv.exp`
- **修正記錄頁空白處無法滑動換頁**：
  - 換頁監聽從 `main` 改掛 `document`。內容很少時 `body` 只有幾百 px 高，
    下方空白在 WebKit 的事件目標是 `<html>` 而不是 `<body>`，掛在 body 上收不到；
    掛 `document` 靠冒泡就一定收得到
  - `main` 加上 `min-height:calc(100dvh - 172px)`，空白區真的屬於版面
  - 補上**膠囊分頁列拖曳**（位移放大 2.6 倍，保留單點切換）。這條列是 `position:fixed`，
    永遠碰得到，所以內容再怎麼空也一定有辦法換頁

### v1.0（2026-08-01）
- 首次上線：記帳、記錄與篩選、統計、設定、離線佇列、通行碼登入與生物辨識鎖

## License

MIT
