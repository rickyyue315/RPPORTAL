# NDRF 申報平台

SASA RP Team 非正常補貨（NDRF）申報平台。申請端以「Site Code／使用者名稱＋密碼」進入，管理端需密碼登入，部署於 Railway（Web/API 服務 + PostgreSQL），以 Dockerfile 建置，並附 Railway Infrastructure as Code 設定。

## 功能

- 公開單筆申報（Site Code + SKU + RP Type 必填，Site Code 驗證門店主檔；RP Type 為 RF 時必須填寫 Safety stock（大於 0）及指定店舖的 Remark，為 ND 時必須填寫 ND Code）
- 公開 Excel 批量上載（固定模板 `RP Team` 工作表，整檔驗證，錯誤不寫入任何行；上載成功後可下載匯入記錄 Excel，按店舖分頁）
- Urgent Order 申報（`/urgent.html`）：網頁申報可一次填寫 1 至 5 個 SKU（`Site Code` 只填一次，每個 SKU 各填 SKU、QTY（1 至 1000 的整數）及 Urgent Reason（指定原因選項，選擇「9. 其他」時必須填寫 Other Reason）），整批 transaction 提交、任何一行錯誤整批拒絕；每個 SKU 各取得一個 `URGENT-...` 申請編號並獨立查詢／修改。另提供獨立 5 欄 Excel 批量上載（上載成功後同樣可下載匯入記錄 Excel，按店舖分頁）
- 突發性銷售申報（`/sales.html`）：只填 Site Code 及 SKU，單筆提交或獨立 2 欄 Excel 批量上載（工作表 `突發性銷售申報`）；沒有提交時間限制，成功後可下載按店舖分頁的匯入記錄
- 行貨退貨報數（`/return.html`）：填寫 Site Code、SKU、QTY（1 至 9999）、指定退貨原因、確認人姓名及電話；公開單筆或獨立 Excel 批量上載，按外部 `return-schedule.json` 的店舖申請窗口收單，同一窗口同一 Site Code + SKU 只可申請一次
- Urgent Order 提交時段為每日 00:00 至 14:30（香港時間）：14:30 後單筆提交及 Excel 批量上載均會被拒絕（管理後台不受限），翌日 14:30 前恢復；狀態可經 `GET /api/public/urgent/window` 查詢
- Urgent Order 申請編號使用 `URGENT-...` 前綴；超出 1000 件的需求改以電郵向相關 Buyer 申請，不在平台處理
- 申請編號 + Site Code 查詢／修改（匯出前可修改，每次修改新增不可變版本；Urgent Order 查詢不限時，修改限每日 14:30 前；突發性銷售申報查詢及修改均不限時）；忘記申請編號的恢復清單另外需要 Recovery Code（每組 OM 獨立，於管理後台設定；另有全平台 master code）
- 同一 Site Code + SKU 於同一日（香港日期）只可申報一次；一般 NDRF、Urgent 與突發性銷售分開計算。被拒時可用查詢／修改更正，翌日可重新申報；管理後台操作不受此限
- 管理後台：清單篩選（含申報類型；日期預設今日）、詳情編輯、版本歷史、模板下載、批量匯入、SAP 9 欄匯出、獨立 Urgent 匯出、獨立突發性銷售匯出、完整審計報表、門店主檔管理；概覽及清單每分鐘自動刷新
- 管理後台另提供行貨退貨報數清單、詳情編輯及 Buyer 8 欄 Excel 預覽／匯出鎖定；系統不記錄 Buyer 審批結果或退貨 NO.
- SAP 匯出只包含一般 NDRF，Urgent Order 使用獨立 6 欄匯出（Application No. | Site Code | SKU | QTY | Urgent Reason | Other Reason）；突發性銷售使用獨立 4 欄匯出（Application Date | Requested by | Shop Code | SKU）；匯出成功後鎖定該批申報，申請人不能再修改；匯出失敗不鎖定。管理員於 14:30 後開始匯出處理，期間 Urgent Order 申請人不可修改（查詢不受限）
- Submission、version history 及 audit event 的 IP 按 `IP_RETENTION_DAYS` 自動匿名化；login attempts、import/export batches、expired sessions 及 rate-limit counters 按各自 retention 設定清理
- 公開單筆及 Excel 提交使用 Idempotency-Key；網絡中斷或回應遺失時，店舖重試會取回原申請編號／原匯入批次，不會重複寫入；Urgent 網頁 1 至 5 SKU 批次使用同一 request key，重試會一次取回全部申請編號。匯入記錄由伺服器按 batch ID 重新產生，不再信任瀏覽器回傳整批資料
- 管理端需密碼登入：密碼存於環境變數 `ADMIN_PASSWORD`（直接常數時間比對，不需 bcrypt hash，避免 `$` 字元在部署平台被展開的問題）；登入後發 httpOnly session cookie（伺服器端 `admin_sessions` 資料表，SHA-256 hash 儲存 token），連線失敗達 `LOGIN_LOCK_THRESHOLD` 次即鎖定 `LOGIN_LOCK_MINUTES` 分鐘；另保留 CSRF 防護、PostgreSQL shared rate limit、安全 headers

## 技術

- Node.js 24 + TypeScript + Express
- PostgreSQL（pg）
- ExcelJS（xlsx 讀寫）
- helmet、express-rate-limit
- Railway 部署（Dockerfile + Infrastructure as Code `.railway/railway.ts`）

## 本機開發

需求：Node.js 24+，Docker（或本機 PostgreSQL）。

```bash
# 1. 啟動資料庫
docker compose up -d db

# 2. 設定環境變數
cp .env.example .env                   # 填入 DATABASE_URL

# 3. 執行 migration + 啟動
npm run migrate
npm run dev
```

啟動後：

- 公開申請頁（一般 NDRF）：<http://localhost:3000/>
- Urgent Order 申報：<http://localhost:3000/urgent.html>
- 突發性銷售申報：<http://localhost:3000/sales.html>
- 查詢／修改：<http://localhost:3000/lookup.html>
- 圖文使用說明：<http://localhost:3000/help.html>
- 管理後台：<http://localhost:3000/admin/login.html>（需登入，成功後進入 `/admin/index.html`）

首次啟動時若 `stores` 主檔為空，會自動載入 `stores-template.csv`（預設路徑可由 `STORES_CSV_PATH` 覆寫）。

## 測試

```bash
npm test          # 單元 + 整合 + API 測試（使用 PGlite 記憶體 Postgres）
npm run smoke     # 端到端 smoke test（真實 HTTP + PGlite，任何時間執行均確定）
npm run schedule:check  # 檢查退貨時間表是否涵蓋今年
```

Repository 已配置 GitHub Actions（`.github/workflows/ci.yml`）：push 時自動執行 `npm ci` + typecheck + build + test。

## 部署至 Railway

Railway 會自動偵測根目錄的 `Dockerfile` 建置；應用程式直接讀取 Railway 注入的 `PORT`。建議把 Web 服務及 PostgreSQL 放在新加坡區域（`asia-southeast1`），香港用戶延遲最低。

### 方式 A：用 Infrastructure as Code 建立（建議新項目）

Repository 已包含 `.railway/railway.ts`，會建立 `web` 服務、`postgres` 資料庫，並自動把 `DATABASE_URL` 連到資料庫。

Railway 需要已授權 GitHub App 讀取 `rickyyue315/RPPORTAL`（私人 repo 請先在 Railway 帳戶 Settings → Integrations 授權），否則 apply 後會拉不到程式碼。

```bash
# 安裝 Railway CLI（只需一次）
npm install -g @railway/cli

# 安裝 IaC SDK（package.json 已列為 devDependency）
npm install

railway login
railway init          # 新項目；如已有項目則改用 railway link
railway config plan   # 預覽會建立的資源，不會改動 Railway
railway config apply  # 確認後建立 Web + PostgreSQL
```

首次 apply 後，到 Railway Dashboard → `web` → **Variables** 設定以下 secrets（IaC 以 `preserve()` 保留，不會寫入 repo；如 `railway config plan` 提示這兩個變數未設定，可先在 Dashboard 建立再 apply）：

- `ADMIN_PASSWORD`
- `PORTAL_SHARED_PASSWORD`

設定後 Railway 會自動重新部署。未設定 `ADMIN_PASSWORD` 時管理員登入會停用；未設定 `PORTAL_SHARED_PASSWORD` 時會用預設 `SASA1234`，正式環境必須更改。

> `.railway/railway.ts` 只由 Railway CLI 讀取，部署時不會使用。若你已在 Railway 手動建立服務，請先 `railway config pull` 匯入現有設定再修改；直接 apply 有機會建立重複資源，或刪除未列出的資源。

### 方式 B：在 Railway Dashboard 手動建立

1. **New Project → Deploy from GitHub repo**，選擇 `rickyyue315/RPPORTAL`（repo 根目錄就是 `ndrf-portal`，不需要設定 Root Directory）。Railway 會自動使用 `Dockerfile`。
2. **New → Database → PostgreSQL**。
3. 在 `web` 服務的 **Variables** 設定 `DATABASE_URL = ${{Postgres.DATABASE_URL}}`（private networking；不要用 public URL），其餘見下表。
4. **Settings → Healthcheck**：Path `/health`，Timeout `300` 秒（首次啟動要跑 migration）。
5. **Settings → Region**：選 `asia-southeast1`（新加坡）。
6. **Settings → Networking → Generate Domain**，取得 HTTPS 網域。
7. （建議）**Settings → Deploy → Restart Policy**：`On Failure`。

### 環境變數

| 變數 | 說明 |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`（Railway PostgreSQL 參考變數；用 private URL） |
| `NODE_ENV` | `production` |
| `ADMIN_USERNAME` | 管理員使用者名稱（預設 `admin`） |
| `ADMIN_PASSWORD` | 管理員密碼（重要：直接填寫密碼字串，不需要 bcrypt hash） |
| `PORTAL_SHARED_PASSWORD` | Portal（Store／Buyer／SCT）密碼（預設 `SASA1234`）：所有店舖頁面（零銷售回覆、一般 NDRF、Urgent、突發性銷售、行貨退貨）共用「Site Code＋此密碼」一次登入；Urgent／突發性銷售／行貨退貨的提交及 Excel 匯入 API 亦要求此 Store session，且只接受登入店舖自己的 Site Code |
| `SESSION_TTL_HOURS` | 登入 session 有效期（小時，預設 8） |
| `LOGIN_LOCK_THRESHOLD` | 失敗登入鎖定次數（預設 5，按 IP 計算） |
| `LOGIN_LOCK_MINUTES` | 鎖定分鐘數（預設 15） |
| `LOGIN_USERNAME_LOCK_THRESHOLD` | Portal 按使用者名稱計算的失敗登入鎖定次數（預設 50；Store 帳號名稱為公開 Site Code，故按 IP 鎖定為主，username 需更高門檻以防遠端鎖死個別帳號） |
| `TRUST_PROXY` | `true`（Railway edge 反向代理後） |
| `TRUST_PROXY_HOPS` | `1`（Railway edge 為單一 hop；如前面再加 Cloudflare 才需調整） |
| `APP_TIMEZONE` | `Asia/Hong_Kong` |
| `IP_RETENTION_DAYS` | `365` |
| `MAX_UPLOAD_MB` | `5` |
| `MAX_IMPORT_ROWS` | `1000` |
| `EXPORT_FILE_RETENTION_DAYS` | `90`（正式匯出 Excel 保存期限） |
| `AUDIT_RETENTION_DAYS` | `730`（Audit event 保存日數） |
| `LOGIN_ATTEMPT_RETENTION_DAYS` | `90` |
| `IMPORT_BATCH_RETENTION_DAYS` | `730` |
| `EXPORT_BATCH_RETENTION_DAYS` | `730` |
| `RETURN_SCHEDULE_PATH` | `./return-schedule.json` |
| `RETURN_ENFORCEMENT_START` | `2026-08-01` |
| `CORS_ORIGINS` | 留空（同源）或填允許來源，逗號分隔 |
| `PUBLIC_WRITE_SUSPENSION_ENABLED` | `true` 暫停公開提交／修改／Excel 匯入；重新開通時設 `false` |
| `PUBLIC_WRITE_SUSPENSION_AT` | 暫停生效時間（預設 `2026-08-11T23:59:59+08:00`） |
| `NORMAL_NDRF_PORTAL_ENABLED` | `true` 開放一般 NDRF Portal 新提交；Admin 管理及匯出不受影響 |
| `NDRF_REJECT_COOLDOWN_HOURS` | Reject 後重新申請冷卻時數（預設 `720`） |
| `NDRF_AUTO_APPROVE_ENABLED` | Buyer SLA 逾期自動批准開關（預設 `true`） |
| `NDRF_AUTO_APPROVE_DAYS` | Buyer 審批日數（預設 `7`） |
| `DB_STARTUP_RETRIES` | 啟動時等待 PostgreSQL 的次數（預設 `20`） |
| `DB_STARTUP_RETRY_MS` | 每次重試間隔（毫秒，預設 `2000`） |
| `SHUTDOWN_TIMEOUT_MS` | 收到 SIGTERM 後強制結束前的等待時間（毫秒，預設 `25000`） |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30`（Railway 舊部署收到 SIGTERM 後的寬限時間） |
| `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` | `10`（可選；新舊部署重疊時間，減少部署期間中斷） |

**不要設定 `PORT`**：Railway 會自動注入，應用程式會直接使用；手動設定反而可能與 Railway 的 healthcheck／路由不一致。

### 部署行為

- 容器啟動時會先等待 PostgreSQL 可用（最多 `DB_STARTUP_RETRIES × DB_STARTUP_RETRY_MS`），再自動執行 migration；migration 使用 PostgreSQL advisory lock，多個 replica 同時啟動也安全。
- 門店主檔為空時會自動載入內建 `stores-template.csv`。
- 匯出 Excel 原檔存於 PostgreSQL（`export_batch_files`），不依賴 Railway volume；容器重啟或重新部署不會遺失。
- 應用程式處理 `SIGTERM`，並在 `SHUTDOWN_TIMEOUT_MS` 內完成關閉；配合 Railway draining 可減少部署期間中斷。
- 健康檢查路徑：`/health`（會檢查資料庫，正常回 `200`，資料庫不可用回 `503`）。
- 預設 1 個 replica 已足夠；如要水平擴展，session、rate limit 及 migration lock 都在 PostgreSQL，可直接增加 replica。

### 由 Zeabur 搬遷資料

1. 在可連到 Zeabur PostgreSQL 的機器匯出（用 Zeabur 的 public／external connection string）：

```bash
pg_dump "$ZEABUR_DATABASE_URL" \
  --no-owner --no-privileges --format=custom \
  --file=ndrf.dump
```

2. 在 Railway PostgreSQL → **Connect** 取得 **Public Network** URL，匯入：

```bash
pg_restore --no-owner --no-privileges --clean --if-exists \
  --dbname "$RAILWAY_PUBLIC_DATABASE_URL" ndrf.dump
```

3. 部署新版本。應用程式啟動時會比對 `schema_migrations`，只補跑未套用的 migration。
4. 核對 `stores`、`submissions`、`portal_users` 等資料表筆數，再切換 DNS／網域。
5. 搬遷後立即在管理後台檢查 Recovery Code、Return Schedule 及 `PUBLIC_WRITE_SUSPENSION_*` 設定。

> `pg_dump`／`pg_restore` 版本建議與來源 PostgreSQL 16 相同或更新。Railway 的 public URL 需要 TLS；連線字串已包含 `sslmode=require` 時可直接使用。

## 資料模型

- `stores`：門店主檔（Site Code 唯一）
- `submissions`：申報主表（`application_no` 唯一、`submission_type` 分 `normal`／`urgent`／`sales`／`return`；`return_qty`、`return_reason`、確認人資料及 `return_window_key` 供行貨退貨報數使用；狀態固定 `received`（由應用層保證）、匯出鎖定欄位；舊版 `supply_source`／`rp_parameters_change_request` 欄位已由 migration 011 在確認無資料後移除）
- `submission_versions`：不可變版本歷史（前後資料快照、操作者角色、IP、時間）
- `import_batches`：Excel 匯入批次、伺服器匯入記錄、申報類型及重試鍵
- `idempotency_key`：單筆及 Excel 重試對應鍵，避免提交成功但 HTTP 回應遺失時重複寫入
- `export_batches`：SAP／Urgent／銷售／退貨匯出批次（建立即鎖定該批申報）
- `export_batch_files`：正式匯出 Excel 原檔，保存 90 日後自動清理；`export_batches` metadata 按 `EXPORT_BATCH_RETENTION_DAYS` 清理
- `admin_sessions`：管理員登入 session（token 以 SHA-256 hash 儲存，過期自動清理）
- `admin_login_attempts`：登入嘗試紀錄（失敗鎖定用）
- `om_recovery_codes`：每組 OM（及 master）嘅「搵返申請編號」Recovery Code；`code` 明文（僅管理後台顯示原碼）＋ `code_hash`（SHA-256，公開查詢常數時間比對用），管理後台設定（migration 012/013）
- `audit_events`：提交／查詢／修改／匯入／匯出／鎖定／登入／Recovery Code 管理／IP 清理審計；管理員 Audit Report 同時包含版本歷史及 audit events

## 版本管理

- 系統版本以 `Ver x.y.z` 格式顯示於每頁底部（`Developed by RP Team - Ricky Yue · Ver x.y.z`）。
- 版本號的單一維護點是 `public/js/version.js` 的 `NDRF_APP_VERSION`；每次更新須同步修改 `package.json` 的 `version`（`test/version.test.ts` 會自動檢查兩者一致，以及每頁都顯示版本）。
- 版本規則（Semantic Versioning）：`x`（major）重大改動／不相容更新；`y`（minor）新增功能；`z`（patch）修正及微調。每次部署更新請遞增對應數字。

## 年度維護

- **行貨退貨時間表**：每年更新 `return-schedule.json`（加入新年度的窗口），並視需要調整 `RETURN_ENFORCEMENT_START`。應用程式啟動時若目前年度沒有配置窗口會直接拒絕啟動（fail-fast），不會靜默關閉功能；可用 `npm run schedule:check` 預先檢查。
- **Recovery Code**：於管理後台「Recovery Code 管理」逐組設定／輪換（每組 OM 一個，另有 master code 適用全平台）。輪換後即時生效，無需重新部署，但需通知相關 OM 組店舖；master code 洩漏影響全平台，須妥善保管。

## 已知限制

- `npm audit --omit=dev`（正式依賴）報告 2 個 moderate 漏洞（`uuid`，經 `exceljs` 傳遞）。目前**沒有非破壞性修復版本**（`npm audit fix --force` 會把 exceljs 降級到 3.4.0，屬 breaking change）。實際風險低：該漏洞只影響 uuid v3/v5/v6 並傳入 `buf` 的用法，本平台經 exceljs 使用 uuid v4 且不傳 `buf`。建議在 exceljs 釋出修復版後升級，或日後評估替換 Excel 函示庫。
- 其餘 audit 報告來自 devDependencies（`vitest`／`vite` 測試工具鏈），不進入正式 Docker image，亦不影響 Railway 部署；待升級 vitest 5（breaking change）時一併處理。

## 注意事項

- 申請編號為不可猜測隨機值（`NDRF-XXXXXXXX-XXXXXXXX`、`URGENT-XXXXXXXX-XXXXXXXX` 或 `SALES-XXXXXXXX-XXXXXXXX`），查詢必須同時提供 Site Code；使用「搵返申請編號」清單則必須另提供 Recovery Code（每組 OM 獨立，或全平台 master code），且只經 HTTP header 傳送，不放入 URL。未設定 code 嘅 OM 會被拒絕（403「此 OM 未設定 Recovery Code」）；全表未有 code 時功能回 503。
- Urgent Order 的 QTY 必須為 1 至 1000 的整數；網頁單筆／1 至 5 SKU 批次、Excel 模板、申請人修改及管理員修改共用相同驗證規則。網頁批次以單一 transaction 提交，任何一行失敗整批 rollback；每個 SKU 各產生一個申請編號。Urgent Order 必須選擇指定原因（1 至 9）；選擇「9. 其他」時必須填寫 Other Reason，其他選項不得填寫補充原因。
- Urgent Order Excel 模板使用獨立 `Urgent Order` 工作表（欄位：Site Code、SKU、QTY、Urgent Reason、Other Reason），與 Page 1 的 `RP Team` 9 欄模板完全分開。舊版 3 欄模板不再接受，避免產生無原因的申報。
- 突發性銷售申報 Excel 模板使用獨立 `突發性銷售申報` 工作表（欄位：Site Code、SKU），只接受這兩個欄名；同一日同一 Site Code + SKU 在同一申報類型內只能提交一次，一般／Urgent／突發性銷售三種類型互不阻擋。
- Excel 批量上載只接受 Excel 活頁簿 `.xlsx` 格式，支援 Excel 2007 或更新版本（包括 Excel 2019、Excel 2021、Excel 2024 及 Microsoft 365）；舊式 `.xls` 檔案請先另存為 `.xlsx`。`.xlsx` 是檔案格式，不是特定 Excel 版本名稱。
- 舊有（加入原因欄位前）的 Urgent Order 原因欄位為空，可於管理後台編輯時補回；匯出時空白原因會以空白顯示。
- 上載檔內的 `Application Date` 及 `Requested by` 不可信，系統一律以伺服器值及 Site Code 產生值覆蓋。
- Admin 編輯一般 NDRF 若令申請由非 Pending（如 Ready for RP）重新進入 Pending 審批，系統會自動開啟新審批回合（`review_round + 1`、重設 `round_started_at`、清除舊 Review Remark 並記錄一條 override 事件），確保同一回合不會已有決定、Buyer SLA 時鐘由新回合重新起算。
- 「同一 Site Code + SKU 每日只可申報一次」以 `application_date`（香港當日日期）計算，申請人修改時若把 SKU 改成同日已存在的組合亦會被拒；管理員匯入／編輯不受限制。
- 管理員匯入無 Idempotency-Key 需求（與公開匯入不同），但相同內容的檔案（`content_hash`）重複上載會被拒絕（409），避免誤按或網路重試造成重複寫入；修改過內容的檔案不受影響。
- 錯誤訊息不包含資料庫或內部設定資訊。
- 一般日誌不記錄申報內容、密碼或完整 IP。

## 每週店舖不良存貨 Dashboard（I14「By Shop」）

用現有 Express + PostgreSQL，把每週 I14「By Shop」報表變成可追蹤的不良存貨趨勢，**不改動 zero-sales 流程**。

- **口徑**：每店佔比 = `Excess Stock Value (P90D 0 Sales)` ÷ `Shop Stock Value (CM)`；全公司佔比 = Σ不良存貨值 ÷ Σ店舖存貨值（**加權**，不是各店比率平均）。分母為 0／缺值時比率顯示 `—`，不會當成 0%。
- **身份鍵**：`report_date`（每日只可有一批）。`report_kind`（`weekly`／`month_end`／`ad_hoc`）只作顯示。

### 管理後台（第 9 個 tab「存貨 Dashboard」）

1. 選報表日期（可從檔名 `25Oct2026` 類格式自動填入）、報表類型、備註，再選 `.xlsx` 上載。
2. **同一日期重上 = 整批取代**：同一 transaction 內先 `DELETE FROM shop_stock_batches WHERE report_date = $1`（FK CASCADE 清走明細），再建立新批次（**新批次有新 id**，不會出現「同一 id 先後代表兩份檔案」）；audit 會記下舊 batch id、行數與 `content_hash`。內容完全相同（`content_hash` 一致）則視為重複上載，不做任何寫入。
3. 匯入清洗順序：①剔除 Column A = `Total` 的全公司合計列 → ②跳過全空白列 → ③跳過頁腳列（`Applied filters: …`）→ ④重複 Site Code 才報錯。`Total` 列的 Site Code 會撞真店（例：HA02），所以必須先整列剔除。
4. 上載結果會顯示「N 間店 / N 行 / 略過 N 列（Total、空白、頁腳）」；對不到門店主檔的店號會列為 warning，**不阻塞**上載。
5. 批次管理：可改報表日期／備註（該日期已有批次會回 `409 DATE_CONFLICT`），或整批刪除（hard delete，會寫 audit event 記錄 `report_date`、`deleted_rows`、`deleted_stores`、`content_hash`）。
6. **新店不參與排名**（`is_new = true`、`rank = null`），判斷只用系統自己儲存的資料，並按以下優先次序：
   - **上期沒有此店**（`new_reason = 'no_prev_data'`）：系統內有更早一期批次，但該店不在其中。這是最可靠的訊號，補上載舊期後即生效。
   - **新店觀察期內**（`new_reason = 'new_store'`）：報表 `Shop Type = NEW STORE`，且由**系統首次見到該店**（`first_seen`）起計未滿 **90 天**（`NEW_STORE_GRACE_DAYS`，API 回傳 `new_store_grace_days`）。
     上游的 `Shop Type` 是人工維護、開業後往往不更新，所以它只在觀察期內有效；一過 90 天就完全由系統歷史決定，不再受旗標影響。旗標本身仍保留在 `is_new_store` 供審計。
   - 兩者皆不成立 → 正常參與排名。
   這類店在明細標示「新店」／「上期無數據」、Top-15 排除，但**仍計入全公司合計與趨勢**。
7. **趨勢圖顯示期間**：後台可切 **3 / 6 / 12 / 24 個月**，預設 12，**上限 24**；店舖端固定 12 個月。
   資料永久保留（每期 93 行、約 100KB，5 年約 25MB），切換只影響畫幾多點，不會刪任何資料。
   選 24 個月時，**12 個月之前那一段（去年）用淺灰藍 `#b9c6d4` 畫**，最近 12 個月維持主色 `#0f5c9c`，圖例分開標示；分段點同時屬於兩段，線不會斷開。

對應 API（全部須管理員登入；只有上載用 `excelImportLimiter`，其餘用 `adminActionLimiter`）：

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/admin/stock/batches` | multipart：`file`、`report_date`、`report_kind`、`note` |
| GET | `/api/admin/stock/batches?page=&size=` | 批次列表（按 `report_date` 新到舊） |
| PUT | `/api/admin/stock/batches/:id` | 改 `report_date` / `note` |
| DELETE | `/api/admin/stock/batches/:id` | 刪除整批（回 `deleted_rows`、`deleted_stores`） |
| GET | `/api/admin/stock/summary?from=&to=` | 趨勢序列 + 最新 KPI（加權比率、WoW 百分點） |
| GET | `/api/admin/stock/weeks/:reportDate` | 某一期每店明細（含與上一期的百分點差、`rank`、`is_new`、`is_new_store`、`new_reason`） |

### 店舖端

店舖用原本的 Site Code 登入後，`/portal/zero-sales.html` 有兩個分頁籤：**零銷售回覆**（預設）與 **存貨走勢**。存貨走勢顯示**自己店**的每週佔比趨勢、全公司加權平均線（虛線）及最新三個 KPI。

- 分頁由 `public/portal/js/portal-tabs.js` 控制（`aria-selected` + `hidden` + 網址 hash `#stock`），並廣播 `portal:tab` 事件；`dashboard.js` 收到事件才首次載入，確保面板可見、圖表量得到闊度。
- 舊網址 `/portal/dashboard.html` **已移除**（該頁只在分頁整合當日短暫存在，從未對外通知，故不留跳轉頁）。入口一律是 `/portal/zero-sales.html`，需要直接開存貨分頁時用 `/portal/zero-sales.html#stock`。
- API：`GET /api/portal/stock/summary`（`requirePortalUser` + `requireStoreSite`）。
- **數據隔離**：`site_code` 一律取自登入 session，**不接受** query／body 傳入；回應只含本店數字與全公司加權比率，不含任何其他店數據。
- 未有數據時回 `200 { has_data: false }`（不是 404），前端顯示空狀態。

### 相關檔案

- `src/lib/shopStockXlsx.ts`：解析器。上游檔的 XML 帶 `x:` 命名空間前綴、`row`/`cell` 無 `r` 座標，ExcelJS 直接讀會失敗；會先試直接讀，失敗才用 `jszip` 正規化（去前綴、補座標、重新打包）再交 ExcelJS。解壓總量上限 20MB。
- `src/services/shopStock.ts`：上載／取代／刪除批次、加權比率、WoW、每店明細、店舖端視圖。
- `src/db/migrations/026_shop_stock_snapshots.sql`：`shop_stock_batches`、`shop_stock_snapshots`、view `v_shop_weekly_deadstock`（純 CREATE，不影響既有表）。
- `test/shopStock.test.ts`：解析（Total／空白／頁腳／重複）、同日取代、`content_hash` 冪等、加權比率數學、除零 → null、admin／portal 未登入 401、跨店隔離。
