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
- 90 日零銷售：每週派發每店 Top 10 零銷售 SKU 給店舖逐條回覆原因；新一週上載即自動封存舊週次。**支援「本週無須回覆」**（銷售繁忙期）：批次照樣派發（店舖仍看見本店 Top 10 清單可搜尋／匯出），但店舖不可回覆，亦不計入待回覆／逾期／回覆率；可隨時切回需要回覆
- 後台導航收斂為 7 個分頁：總覽／申報清單／**匯出**（含匯出批次及重新下載）／零銷售／存貨 Dashboard／指定SKU回覆／**系統**（含帳戶與主檔、審批設定、系統工具）。合併頁面頂部有頁內分組導覽；舊連結 `?tab=batches|accounts|review` 及 `#sec-batches|sec-accounts|sec-review` 書籤會自動跳到對應分頁的分組，不會失效
- 指定 SKU 回覆：批次可用**Excel 上載**或**人手輸入**建立（一個批次可含多間店舖 × 多個 SKU），系統按 Site Code 建立**事項**（同一店舖的多個 SKU 歸入同一事項）；店舖為每個 SKU 的各個貨品年期 (MMYY) 回覆可調撥件數，或標示「無可調撥」，一次過提交整份事項。每個事項有獨立事項編號、批次編號及直 link（只限涉及店舖，後端強制核對）。**截止日期及時間（香港時間）到點即自動截止**，管理員可延長期限、補加／修改 SKU、代店舖補錄或更正回覆（不佔店舖修改次數，會寫入審計日誌）
- **OM（營運經理）Portal**（`/portal/om.html`）：OM 以自己名稱＋OM 專用密碼（`PORTAL_OM_PASSWORD`，預設 `SASAOM178`）登入，只會看到最新上載存貨報表 OM 等於自己名稱的店舖（從未出現在報表的店舖 fallback 到 `stores.om`）。提供管轄店舖總覽（零銷售待回覆、指定 SKU 待回事項、最新不良存貨佔比及 SKU 比率）、零銷售逐 SKU 代覆、指定 SKU 事項代覆，以及 OM 合計／單店存貨走勢（不良存貨值佔比及不良存貨 SKU ÷ Carry SKU，均含全公司加權平均對比）；所有代覆寫入審計日誌，已封存的週次／事項不可代覆
- **OM 歸屬自動更新**：存貨報表（I14 By Shop）的 OM 欄以「最後上載的報表」為準；店舖轉交新 OM 後，所有歷史期數會自動歸入最新 OM，不需逐期修改。OM Portal 的店舖範圍及存貨／零銷售／指定 SKU 畫面、後台存貨 Dashboard 的 OM Group、每期明細／匯出，以及零銷售後台的 OM 匯總／OM 下鑽／重複上榜均同步跟隨；上載新報表時會自動建立新 OM 帳戶
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
- OM 營運經理：<http://localhost:3000/portal/om.html>（OM 名稱＋`PORTAL_OM_PASSWORD`，預設 `SASAOM178`）

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

## 90日零銷售：「本週無須回覆」（銷售繁忙期）

旺季／大檔期店舖忙於銷售時，RP Team 可以把某一週設為**無須回覆**：批次照樣派發，店舖仍看到本店 **Top 10** 零銷售 SKU 清單（可搜尋、可匯出 Excel），但不需要逐條回覆。

- **開關位置**：後台「零銷售」分頁 → 批次列表每列的「**設定無須回覆**」／「**恢復需要回覆**」（只限未封存的週次）；上載新批次時亦可直接勾選「本週無須回覆」並填寫給店舖的說明（`reply_notice`，空白時店舖頁用預設文案）。
- **資料模型**：`zero_sales_batches.reply_required`（預設 `true`）＋ `reply_notice`。migration `031_zero_sales_no_reply.sql`。
- **狀態定義**（勿混淆）：
  - `closed_at IS NULL` = 未封存；`closed_at` 非 NULL = 已封存（只供查閱）。
  - `is_archived` = 是否已封存；`reply_required` = 是否需要回覆。
  - **`is_open` = 未封存 AND 需要回覆**（= 店舖現時可否回覆）。因此「無須回覆」的週次 `is_open = false` 但 `is_archived = false`。
- **店舖端**：藍色資訊帶說明本週無須回覆，隱藏進度條與狀態篩選，狀態欄顯示「無須回覆」、操作欄顯示「無須回覆」（沒有回覆按鈕）；清單、搜尋、匯出 Excel 照常。直接呼叫回覆 API 會回 `409 { code: 'REPLY_NOT_REQUIRED' }`。
- **統計口徑**：無須回覆的行另計 `no_reply`，**永不計入 `pending` / `overdue` / 待回覆店舖名單**；回覆率分母 = 總行數 − `no_reply`（即只計需要回覆的行）。總覽卡下方會標示「其中 N 行屬無須回覆」。
- **自動套用**：無須回覆的週次上載時**不會**自動套用重複 SKU 上次回覆（店舖毋須逐條確認），手動按「自動套用重複回覆」亦會被拒（400）。
- **切換不回退資料**：切換只改「是否需要回覆」，不會修改任何已提交的回覆。切回需要回覆後，未回覆的行即變回待回覆（店舖可繼續回覆）；切為無須回覆後，已提交的回覆保留但不可再改。
- **匯出**：Admin 匯出的「未回覆店舖」工作表不列無須回覆的週次；`記錄狀態` 欄標示「無須回覆（只供參考）」。店舖端匯出的狀態欄為「無須回覆」／「已回覆（本週無須回覆）」。
- **API**：`PUT /api/admin/zero-sales/batches/:id/reply-required`，body `{ reply_required: boolean, notice?: string }`（省略 `notice` 時沿用原值）；上載 `POST /api/admin/zero-sales/batches` 可加 `reply_required=0` / `reply_notice`。切換會寫入審計 `zero_sales_reply_required_changed`。

## 每週店舖不良存貨 Dashboard（I14「By Shop」）

用現有 Express + PostgreSQL，把每週 I14「By Shop」報表變成可追蹤的不良存貨趨勢，**不改動 zero-sales 流程**。

- **口徑**：每店佔比 = `Excess Stock Value (P90D 0 Sales)` ÷ `Shop Stock Value (CM)`；全公司佔比 = Σ不良存貨值 ÷ Σ店舖存貨值（**加權**，不是各店比率平均）。分母為 0／缺值時比率顯示 `—`，不會當成 0%。
- **身份鍵**：`report_date`（每日只可有一批）。`report_kind`（`weekly`／`month_end`／`ad_hoc`）只作顯示。

### 管理後台（第 5 個 tab「存貨 Dashboard」）

**頁面版面（由上至下）**：上載 I14 報表 → 最新一期 KPI → **不良銷售 SKU 佔比走勢（分組小圖）** → **佔比趨勢（不良存貨 ÷ 店舖存貨）** → **每店明細（不良存貨）** → **No. of RF SKU Dashboard（自動補貨）** → 上載批次。分組小圖與佔比趨勢放在前面，RF SKU 區塊放最後；每店明細的標題與欄位已註明**不良存貨**口徑（不良存貨值 / 不良存貨佔比 / 不良存貨 SKU ÷ 店內貨品），RF SKU 兩欄僅屬參考，明確標示不代表好壞。

**不良銷售 SKU 佔比走勢（分組小圖）**：每張小圖一個分組（Grand Total ＋ 各 Shop Nature／OM），每根柱一個報表期，柱上顯示百分比；可切換兩種口徑：

- **不良 SKU ÷ SKU Carry**（件數，預設）＝ `Σ No. of Overstock SKU (P90D 0 Sales)` ÷ `Σ No. of SKU Carry`。
- **不良存貨值 ÷ 存貨值**（金額）＝ `Σ Excess Stock Value (P90D 0 Sales)` ÷ `Σ Shop Stock Value (CM)`。

兩個口徑都是**組內加權**（先加總分子／分母再相除），不是各店比率平均。Shop Nature 會把報表原值 `Local`／`Non Tourist` 歸為「民生區」、`Mix` 歸為「混合區」、`Tourist` 歸為「遊客區」；未知值保留原字串，空白則歸「未填」。OM 以最新一期的 SKU Carry（再以 SOH）由大到小排列。某組某期沒有店舖時回 `null`，小圖留空，不會畫成 0%。顯示期間按鈕與下方「佔比趨勢」雙向同步（3 / 6 / 12 / 24 個月）。

**當月（MTD）每店排名**：同一張卡下方另有 Top 15 排名表，跟隨上面的口徑切換（不良 SKU 佔比／不良存貨值佔比），顯示 **Site、完整店舖名稱、OM、Shop Nature、比率、分子 ÷ 分母、與上期百分點**。MTD 的定義是**香港時區當前月份內最新一期快照**；本月尚未上載時回落最新資料月份，並在標題／說明標明月份。排名用每店自己的比率（不是全公司加權），新店／上期無數據與原有 Top 15 同一套規則排除，但仍計入全公司合計與走勢。按排名任何一行會切到該 MTD 期並在下方每店明細只顯示該店。

**店舖佔比（MTD 的另一個視圖）**：同一張卡的右上角可切換「排行榜／店舖佔比」（`#stk_mtd_switch`，選擇會記在 `localStorage.ndrf_admin_stock_mtd_view`）。店舖佔比照 Excel「店舖佔比」報表排版：按 Shop Nature 分成**民生區（Local／Non Tourist）／混合區（Mix）／遊客區（Tourist）**三組，每組列出**全部店舖**（不篩 Top 15），組內按比率由高至低排，柱頂顯示百分比、柱底顯示店號與店名，組標題顯示店數、**組加權比率**（Σ 分子 ÷ Σ 分母）與最高值。每組柱高獨立縮放，跨組比較只看數字；若某店遠高於同組（最大 > 次大 × 1.6），柱高改以次高值為滿格、超出的柱頂加白線標示（避免一間離群店把同組其餘店壓成貼底矮柱，柱頂數字仍是真值）。新店／上期無數據以斜紋顯示並排在百分比序列中，缺 SKU Carry／不良 SKU 數的店排最後、畫 2px 灰柱，兩者都不當 0% 參與比較。按任何一條柱與排行榜同一行為：切到該 MTD 期並在每店明細只顯示該店。

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
8. **匯出 Excel（報告／PPT 用）**：趨勢圖右上角「匯出 Excel」把**目前顯示期間**的數字匯出成三個工作表 ——
   `佔比趨勢`（一期一列：期別、週次、報表類型、店數、計入比率店數、Σ店舖存貨值、Σ不良存貨值、佔比、較上期 pp、>2 期與合計口徑、0 Sale SKU 數、RF SKU 合計／資料店數／較上期、不良存貨SKU÷RF）、
   `PPT 圖表用`（只有「期別 / 不良存貨佔比」兩欄，插入折線圖即用）、`匯出說明`（口徑、範圍、產生時間）。
   比率以小數儲存 + `0.0%` 格式，可直接在 Excel 改顯示位數；**分母 0 的期數留空**（不寫 0，避免畫出假 0% 線）。匯出為唯讀，會寫 audit event `shop_stock_trend_export`。
9. **圖表 tooltip**：滑鼠懸停／點按可看該期數值。tooltip 會自動避開左右邊界（唔會黐出圖表），長系列名（例如「不良存貨 SKU 佔店內貨品比率」）會自動換行，文字**完整顯示**、唔會被深色底框截斷。
10. **每個 Dashboard 都有 Excel 匯出**（三個按鈕，三份檔案）：

| 位置 | 匯出內容 | 工作表 |
|---|---|---|
| 佔比趨勢卡右上 | 走勢數字（PPT 用） | 佔比趨勢 / PPT 圖表用 / 匯出說明 |
| 每店明細卡右上 | 該期每店一行，**跟住畫面嘅搜尋／排序／只顯示**（即「匯出 = 畫面所見」） | 每店明細 / 匯出說明 |
| RF SKU Dashboard 卡右上 | RF SKU 走勢 ＋ 兩張店舖排名（畫面只顯示頭 15 名，Excel 列出全部） | RF SKU 走勢 / RF SKU 店舖排名 / 不良÷店內貨品 排名 / 匯出說明 |

   - 篩選／排序規則由 `filterAndSortWeekRows()` 實作，**必須同 `public/js/admin-stock.js` 的 `filteredWeekRows()` 保持一致**（改一邊就要改兩邊）。
   - 缺值一律留空（分母 0／無效值唔會當 0）；新店／上期無數據照列但唔佔名次，並在「狀態」欄標明。
   - 匯出為唯讀，會寫 audit event `shop_stock_detail_export` / `shop_stock_rf_export` / `shop_stock_store_export`。

### No. of RF SKU Dashboard（自動補貨）與「不良存貨 SKU 佔店內貨品比率」

同一份 I14 資料、同一個 tab 內另有 RF 區塊（**無需重上載**：`No. of RF SKU`／`No. of SKU Carry` 直接取自每期快照 payload；空白／非法值 → null，絕不當 0）：

- **口徑**：`不良存貨 SKU 佔店內貨品比率 = No. of Overstock SKU (P90D 0 Sales) ÷ No. of SKU Carry`，全公司用加權合計（Σ分子 ÷ Σ分母，不是各店平均）。分母 `No. of SKU Carry` = 店內貨品 SKU 總數（報表定義 = RF SKU + ND with Stock，**已對真實報表 93 店逐店核實**）。分子**包含 ND 貨**，但必為分母子集，**比率結構上不超過 100%**，不需要最低分母門檻（RF=2 的 HA43 在新分母下是正常數字）。
- **為何分母不用 RF SKU**：分母用 RF 時，店舖照建議把 RF 轉 ND 而貨未清走，分子不變、分母縮小，比率反而爆升（模擬實測：60.6% → 62.7%）——等於懲罰正確行為。改用 SKU Carry 後，轉 ND 本身不影響比率，**只有實際賣出或轉走滯銷貨才會改善**，誘因與「降低 90 日 0 銷售」一致。
- **KPI 卡**：最新 RF SKU 合計、RF SKU 較上期、資料覆蓋店數、不良存貨 SKU 佔店內貨品比率（含 WoW 百分點，上升＝轉差）。
- **走勢圖**：可切換「RF SKU 數」／「不良÷SKU Carry」兩個口徑，顯示期間與佔比趨勢圖同步（3/6/12/24 個月，缺值斷線）。
- **Top 15**：「RF SKU 數量」排名**不排除新店**（絕對數有效）；「不良÷SKU Carry」排名**與價值比率 Top 15 同一套新店排除規則**（`is_new`），無其他排除。
- **比率 ≥ 20% 紅色顯示**（全公司加權約 11–12%，≥20% 視為明顯偏高）；RF 增減本身**不套紅綠好壞色**。

對應 API（全部須管理員登入；只有上載用 `excelImportLimiter`，其餘用 `adminActionLimiter`）：

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/admin/stock/batches` | multipart：`file`、`report_date`、`report_kind`、`note` |
| GET | `/api/admin/stock/batches?page=&size=` | 批次列表（按 `report_date` 新到舊） |
| PUT | `/api/admin/stock/batches/:id` | 改 `report_date` / `note` |
| DELETE | `/api/admin/stock/batches/:id` | 刪除整批（回 `deleted_rows`、`deleted_stores`） |
| GET | `/api/admin/stock/summary?from=&to=` | 趨勢序列 + 最新 KPI（加權比率、WoW 百分點）＋ `group_trend`（Grand Total／Shop Nature／OM 的分組加權走勢） |
| GET | `/api/admin/stock/summary/export?months=3\|6\|12\|24` | 匯出趨勢圖數字成 xlsx（3 張工作表；`months` 上限 24，預設 12） |
| GET | `/api/admin/stock/weeks/:reportDate` | 某一期每店明細（含與上一期的百分點差 `delta_pt`／`ovs_carry_delta_pt`、`rank`、`is_new`、`is_new_store`、`new_reason`） |
| GET | `/api/admin/stock/weeks/:reportDate/export?q=&sort=&only=` | 該期每店明細匯出 xlsx（篩選／排序同畫面一致） |
| GET | `/api/admin/stock/rf/export?months=3\|6\|12\|24&report_date=` | RF SKU Dashboard 匯出 xlsx（走勢＋兩張排名；`report_date` 指定排名期別，預設最新一期） |

### 店舖端

店舖用原本的 Site Code 登入後，`/portal/zero-sales.html` 有兩個分頁籤：**零銷售回覆**（預設）與 **存貨走勢**。存貨走勢顯示**自己店**的每週佔比趨勢、全公司加權平均線（虛線）及最新四個 KPI（店舖存貨值、不良存貨值、不良存貨佔比、不良存貨 SKU ÷ 店內貨品 SKU——最後一張卡附全公司同日加權對比；RF 轉 ND 而貨未清走時這個數字不變，實際清貨才會下降）。

- 分頁由 `public/portal/js/portal-tabs.js` 控制（`aria-selected` + `hidden` + 網址 hash `#stock`），並廣播 `portal:tab` 事件；`dashboard.js` 收到事件才首次載入，確保面板可見、圖表量得到闊度。
- 舊網址 `/portal/dashboard.html` **已移除**（該頁只在分頁整合當日短暫存在，從未對外通知，故不留跳轉頁）。入口一律是 `/portal/zero-sales.html`，需要直接開存貨分頁時用 `/portal/zero-sales.html#stock`。
- API：`GET /api/portal/stock/summary`（`requirePortalUser` + `requireStoreSite`）。
- **店舖端亦可以匯出 Excel**：走勢卡右上角「匯出 Excel」→ `GET /api/portal/stock/summary/export`（`excelExportLimiter`），工作表「本店走勢」＋「匯出說明」，只含**本店**每期數字同全公司加權平均線；冇數據時回 404。audit event `shop_stock_store_export`。
- **店舖端匯出刻意唔含金額（資安）**：Excel 好容易轉發（業主、供應商、跨部門），所以「本店走勢」**不包含**「店舖存貨值（CM）」同「不良存貨值（P90D 0 Sales）」兩欄，只提供比率（不良存貨佔比、較上期 pp、不良存貨 SKU ÷ 店內貨品、全公司加權佔比、差距 pp）；「匯出說明」頁會寫明口徑同刻意不包含嘅項目。⚠️ 後台（admin）嘅匯出**照舊**保留金額，因為管理員本身就有權看。
- **數據隔離**：`site_code` 一律取自登入 session，**不接受** query／body 傳入；回應只含本店數字與全公司加權比率，不含任何其他店數據。
- 未有數據時回 `200 { has_data: false }`（不是 404），前端顯示空狀態。

### 相關檔案

- `src/lib/shopStockXlsx.ts`：解析器。上游檔的 XML 帶 `x:` 命名空間前綴、`row`/`cell` 無 `r` 座標，ExcelJS 直接讀會失敗；會先試直接讀，失敗才用 `jszip` 正規化（去前綴、補座標、重新打包）再交 ExcelJS。解壓總量上限 20MB。
- `src/services/shopStock.ts`：上載／取代／刪除批次、加權比率、WoW、每店明細、店舖端視圖。
- `src/services/shopStockExport.ts`：Excel 匯出產生器（佔比趨勢、每店明細、RF SKU Dashboard、店舖端本店走勢）＋每店明細的篩選／排序規則 `filterAndSortWeekRows()`。
- `src/db/migrations/026_shop_stock_snapshots.sql`：`shop_stock_batches`、`shop_stock_snapshots`、view `v_shop_weekly_deadstock`（純 CREATE，不影響既有表）。
- `test/shopStock.test.ts`：解析（Total／空白／頁腳／重複）、同日取代、`content_hash` 冪等、加權比率數學、除零 → null、admin／portal 未登入 401、跨店隔離。

## 指定 SKU 回覆（一個事項可包含多個 SKU）

RP Team 指定個別 SKU 要求店舖回報「每個貨品年期可調撥幾件」。批次可以由 **Excel 上載**或**人手輸入**建立，建立後仍可在後台補加／修改 SKU 及延長截止時間。沿用現有 Express + PostgreSQL，**不改動 zero-sales / 存貨 Dashboard 流程**。

### 資料模型與編號

- 上載一次（或人手輸入一次）= 一個**批次**，自動取得 `batch_code`：`DSKU-YYMMDD-NNNN`（例 `DSKU-261026-0001`；`NNNN` 來自 PostgreSQL sequence，同日併發上載不會撞號）。**一個批次可同時包含多間店舖 × 多個 SKU**。
- **一個事項 = 一批次內同一店舖**（`designated_sku_matters`）。同一份 Excel 內，同一 Site Code 的多個 SKU 會歸入同一個事項；不同店舖各自一個事項。
- 事項編號：`<batch_code>-NN`（例 `DSKU-261026-0001-03`，`NN` 為該批次內店舖序號）。店舖、管理員日後都用這個編號查閱及直 link。
- 事項內每個 SKU 一行（`designated_sku_items`），各有自己的回覆明細：一個**貨品年期 (MMYY)** 一行 + 可調撥件數（`designated_sku_reply_lines`）。同一 SKU 有多個年期可分多行。
- 店舖可為某個 SKU 勾選**「無可調撥件數」**（`no_transfer = true`），與「未回覆」區分；事項要**全部 SKU 已回覆或標示無可調撥**才算完成（狀態由 SKU 狀態推導，不另存欄位）。
- 驗證：年期必須 4 位 `MMYY`（月份 01–12；亦接受 `8/27`、`827`）；同一 SKU 不可重複年期；件數為 1–9999 整數；**每個 SKU 的合計不可多於該 SKU 存貨**（存貨留空／非數字時不設上限，但不會當 0）。允許少於存貨（部分可調撥）。
- 存貨欄 `stock_qty` 可為 `NULL`（缺值／非數字），**不代表 0**；匯入時會產生 warning，事項照樣建立。
- 截止時間 `due_at`（`TIMESTAMPTZ`）：前台以**香港時間**輸入及顯示（例 `2026-11-10 18:00`），DB 存 UTC 時刻。**`is_open` 一律由 `closed_at IS NULL AND (due_at IS NULL OR due_at > now())` 推導** —— 過期即視為截止，店舖提交回 `409 MATTER_CLOSED`，但無需任何排程。管理員仍可代回覆；重開舊批次時若 `due_at` 已過，畫面會提示要先延長期限。

### 管理後台（tab「指定SKU回覆」）

0. **兩種建立方式**（同一張卡切換）：
   - **上載 Excel**：填好欄位後選檔上載，適合大批派發。
   - **人手輸入**：直接逐行填 Site / SKU / 描述 / 存貨，可「＋新增一行」，或按「從 Excel 貼上」把多行（Tab 分隔）一次貼入；存貨留空代表「未提供」。
1. 填**事項主題**（必填）、事項類型、可選的**截止日期及時間**（`datetime-local`，香港時間）、**參考編號**、**事項說明**、**內部備註**。後三者與截止時間屬**預留欄位：空白時店舖端／明細自動隱藏**，將來新增事項類型毋須改 schema（另有 `settings JSONB`）。
2. Excel 欄位對應（可容忍欄名大小寫／空白差異）：`Site`（或 Site Code）＋ `Article`（或 SKU）必填，另有 `Product Hierarchy`、`Article Long Text (60 Chars)`、`SaSa Net Stock`；最後兩欄「店舖回覆可調撥件數 / 貨品年期 (MMYY)」由店舖填寫，上載時可留空。原始整列會存 `payload`。
3. `Total`／頁腳列會靜靜剔除；Site 不存在的行、檔案內重複（Site + SKU）會擋下整批（回傳逐行錯誤）。同一檔案再上載會回 `409 DUPLICATE_FILE`，需勾選「仍要重新上載」才可重新派發。
4. 批次列表顯示**事項數 / SKU 行數 / 店數 / 已回覆 / 未回覆**，可**封存**（店舖只可查閱，提交回 `409 MATTER_CLOSED`）、**重開**（讓店舖補答）、**刪除**（連回覆紀錄）。
5. 批次明細**一個事項一行**，列出該事項內每個 SKU、存貨、年期回覆／無可調撥／未回覆；可按 Site／狀態篩選，逐個事項**複製直 link**，或一次複製全部未回覆事項的直 link（Site / 事項編號 / 網址，方便貼 WhatsApp 或 email）。
6. **管理員代店舖回覆**：未回覆的事項按「代回覆」補錄（常見：店舖截單後 email 補交），已回覆的按「編輯回覆」更正該事項內所有 SKU 的年期／件數。管理員操作**不受封存限制**、**不佔用店舖修改次數**；代填的 SKU 會將回覆人記為「管理員代填（帳號）」、`reply_count = 1`，編輯既有回覆則保留店舖原本的回覆人、時間及次數。每次修改另記錄 `admin_edited_at` / `admin_edited_by`（畫面顯示「管理員 X 於 Y 修改」），並寫入審計日誌 `designated_sku_reply_admin_edited`；店舖之後再自行提交時會清空該標記。
7. **補加／修改 SKU**（明細頁）：每個 SKU 有「編輯」「移除」；頂部「＋加入 SKU」可在既有批次補加（新店會自動建立事項）。可改 Site Code（等於把 SKU 搬到該店的事項，舊事項空了自動移除）、SKU 編號、描述、存貨。**新存貨不可低於已回覆合計**（否則要先更正回覆）；批次封存後需先「重開」才可增刪改。
8. **編輯批次資料**：可隨時改事項主題、**截止日期及時間**、參考編號、說明、內部備註；延長截止後店舖可繼續回覆（清除截止時間 = 無限期，直至手動封存）。
9. 匯出 Excel 三張工作表：`事項回覆`（每個 SKU 一行：事項編號、批次、主題、Site、SKU、存貨、事項狀態、SKU 狀態、無可調撥、回覆合計、年期明細、備註、回覆人、時間、提交次數、管理員修改）、`年期明細`（每個年期一行）、`未回覆事項`（只列未回覆的 SKU）。

### 店舖端

- 入口：`/portal/designated-sku.html`；零銷售頁導覽列有「指定SKU回覆」連結及待回覆事項數字，頁頂亦有提示橫幅。
- **圖文使用說明：`/help.html#designated-sku`（第 2 章）**，店舖端頁腳亦有連結。新增或調整 `help.html` 章節時，要同步 TOC、章節編號，以及內文「第 N 章」的交叉引用與 `/help.html#…` 外部連結。
- **一張卡 = 一個事項**，卡內列出該事項所有 SKU；店舖在**同一個彈窗**內逐個 SKU 填年期（可「新增年期」），或勾選「此 SKU 無可調撥件數」，一次過提交整份事項。
- **只會顯示屬於登入 Site Code 的事項**；`site_code` 一律取自 portal session，不接受 query／body 傳入。
- **直 link**：`/portal/designated-sku.html?matter=<事項編號>`（舊 `?task=` 會自動轉換）。未登入會先過 Site Code + 密碼閘；登入後自動開啟該事項。若事項不屬於該店舖，API 回 `403 MATTER_FORBIDDEN`；不存在回 `404`。
- **截止時間以香港時間顯示**（例 `2026-11-10 18:00`）；時間一到，事項變唯讀並標示「已過截止」，提交回 `409 MATTER_CLOSED`。逾期事項不會計入導覽列待回覆數字。
- 回覆後仍可在事項截止前修改；每次儲存會遞增每個 SKU 的 `reply_count` 並寫入 audit event `designated_sku_replied`。
- 事項已封存時彈窗變唯讀（顯示「已截止」，不可再提交）。

### API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/designated-sku/template` | 下載上載模板（含填寫說明） |
| POST | `/api/admin/designated-sku/batches` | multipart：`file`、`subject`（必填）、`matter_type`、`due_at`、`reference`、`instructions`、`note`、`force` |
| POST | `/api/admin/designated-sku/batches/manual` | JSON 人手建立：`subject`、`rows: [{ site_code, sku, description, stock_qty }]`、`due_at`、`force` |
| PUT | `/api/admin/designated-sku/batches/:id` | 修改批次資料（主題／`due_at`／參考／說明／備註），用於延長截止 |
| POST | `/api/admin/designated-sku/batches/:id/items` | 補加 SKU：`{ site_code, sku, description, stock_qty }`（新店自動建立事項） |
| PUT | `/api/admin/designated-sku/batches/:id/items/:itemId` | 修改 SKU：店舖／編號／描述／存貨（存貨不可低於已回覆合計） |
| DELETE | `/api/admin/designated-sku/batches/:id/items/:itemId` | 移除 SKU（事項再無 SKU 時連事項刪除） |
| GET | `/api/admin/designated-sku/batches?page=&page_size=` | 批次列表（含事項／SKU 進度及下拉選項） |
| GET | `/api/admin/designated-sku/summary` | KPI 總覽（批次／事項／SKU／已回覆／未回覆／店數） |
| GET | `/api/admin/designated-sku/batches/:id/matters?site_code=&status=` | 批次內事項明細（每事項含所有 SKU 及年期） |
| GET | `/api/admin/designated-sku/export?batch_id=&site_code=&status=` | 匯出三張工作表 xlsx（每 SKU 一行） |
| PUT | `/api/admin/designated-sku/batches/:id/close` / `reopen` | 封存／重開 |
| DELETE | `/api/admin/designated-sku/batches/:id` | 刪除整個批次（含回覆） |
| DELETE | `/api/admin/designated-sku/batches/:id/matters/:matterId` | 刪除單一事項（含所有 SKU） |
| PUT | `/api/admin/designated-sku/batches/:id/matters/:matterId/reply` | 管理員代填／更正整個事項：`{ items: [{ item_id, lines, note, no_transfer }] }` |
| GET | `/api/portal/designated-sku/pending-count` | 待回覆事項數（導覽列徽章用） |
| GET | `/api/portal/designated-sku/matters?status=` | 本店事項（未回覆排先）＋待回覆數 |
| GET | `/api/portal/designated-sku/matters/:code` | 單一事項（直 link；只限涉及店舖） |
| PUT | `/api/portal/designated-sku/matters/:code/reply` | 提交／更新整份事項：`{ items: [{ item_id, lines, note, no_transfer }] }` |

### 相關檔案

- `src/db/migrations/027_designated_sku_tasks.sql`：初版批次／SKU 明細／年期明細（歷史 migration，已被 029 取代部分結構）。
- `src/db/migrations/028_designated_sku_admin_edit.sql`：`admin_edited_at` / `admin_edited_by`。
- `src/db/migrations/029_designated_sku_matters.sql`：新增 `designated_sku_matters`、把既有資料回填為「每店一事項」、`matter_id`、`no_transfer`，並移除逐 SKU 的 `task_code`。
- `src/db/migrations/030_designated_sku_due_at.sql`：`due_date`（DATE）→ `due_at`（TIMESTAMPTZ），舊值回填為當日 23:59（HKT）。
- `src/lib/designatedSku.ts`：Excel 解析（表頭自動偵測、Total 列剔除、存貨缺值 → `null`）、模板、匯出；`normalizeYearCode()` 亦在此。
- `src/services/designatedSku.ts`：建立批次／事項、店舖端查詢與隔離、整份事項回覆 validation + transaction、管理員代填、封存／重開／刪除、KPI。
- `public/portal/designated-sku.html`、`public/portal/js/designated-sku.js`：事項卡（多個 SKU）、多 SKU 年期編輯器、直 link。
- `public/js/admin-designated-sku.js`、`public/admin/index.html`（`panel-designated-sku`）：後台上載、批次、事項明細、多 SKU 代回覆、直 link、匯出。
- `test/designatedSku.test.ts`：年期正規化、解析、上載／重複檔案、同店多 SKU 合併事項、跨店隔離（列表及直 link 403）、一次過回覆多個 SKU、無可調撥、年期／存貨驗證、管理員代填／更正、封存後 409、匯出三張工作表、刪除事項同步計數。
