# NDRF 申報平台

SASA RP Team 非正常補貨（NDRF）申報平台。申請端免登入，管理端需密碼登入，部署於 Zeabur（Web/API 服務 + PostgreSQL）。

## 功能

- 公開單筆申報（Site Code + SKU + RP Type 必填，Site Code 驗證門店主檔；RP Type 為 RF 時必須填寫 Safety stock（大於 0）及指定店舖的 Remark，為 ND 時必須填寫 ND Code）
- 公開 Excel 批量上載（固定模板 `RP Team` 工作表，整檔驗證，錯誤不寫入任何行；上載成功後可下載匯入記錄 Excel，按店舖分頁）
- Urgent Order 申報（`/urgent.html`）：網頁申報可一次填寫 1 至 5 個 SKU（`Site Code` 只填一次，每個 SKU 各填 SKU、QTY（1 至 1000 的整數）及 Urgent Reason（指定原因選項，選擇「9. 其他」時必須填寫 Other Reason）），整批 transaction 提交、任何一行錯誤整批拒絕；每個 SKU 各取得一個 `URGENT-...` 申請編號並獨立查詢／修改。另提供獨立 5 欄 Excel 批量上載（上載成功後同樣可下載匯入記錄 Excel，按店舖分頁）
- 突發性銷售申報（`/sales.html`）：只填 Site Code 及 SKU，單筆提交或獨立 2 欄 Excel 批量上載（工作表 `突發性銷售申報`）；沒有提交時間限制，成功後可下載按店舖分頁的匯入記錄
- 行貨退貨報數（`/return.html`）：填寫 Site Code、SKU、QTY（1 至 9999）、指定退貨原因、確認人姓名及電話；公開單筆或獨立 Excel 批量上載，按外部 `return-schedule.json` 的店舖申請窗口收單，同一窗口同一 Site Code + SKU 只可申請一次
- Urgent Order 提交時段為每日 00:00 至 14:30（香港時間）：14:30 後單筆提交及 Excel 批量上載均會被拒絕（管理後台不受限），翌日 14:30 前恢復；狀態可經 `GET /api/public/urgent/window` 查詢
- Urgent Order 申請編號使用 `URGENT-...` 前綴；超出 1000 件的需求改以電郵向相關 Buyer 申請，不在平台處理
- 申請編號 + Site Code 查詢／修改（匯出前可修改，每次修改新增不可變版本；Urgent Order 查詢不限時，修改限每日 14:30 前；突發性銷售申報查詢及修改均不限時）；忘記申請編號的恢復清單另外需要 `PUBLIC_RECOVERY_CODE`
- 同一 Site Code + SKU 於同一日（香港日期）只可申報一次；一般 NDRF、Urgent 與突發性銷售分開計算。被拒時可用查詢／修改更正，翌日可重新申報；管理後台操作不受此限
- 管理後台：清單篩選（含申報類型；日期預設今日）、詳情編輯、版本歷史、模板下載、批量匯入、SAP 9 欄匯出、獨立 Urgent 匯出、獨立突發性銷售匯出、完整審計報表、門店主檔管理；概覽及清單每分鐘自動刷新
- 管理後台另提供行貨退貨報數清單、詳情編輯及 Buyer 8 欄 Excel 預覽／匯出鎖定；系統不記錄 Buyer 審批結果或退貨 NO.
- SAP 匯出只包含一般 NDRF，Urgent Order 使用獨立 6 欄匯出（Application No. | Site Code | SKU | QTY | Urgent Reason | Other Reason）；突發性銷售使用獨立 4 欄匯出（Application Date | Requested by | Shop Code | SKU）；匯出成功後鎖定該批申報，申請人不能再修改；匯出失敗不鎖定。管理員於 14:30 後開始匯出處理，期間 Urgent Order 申請人不可修改（查詢不受限）
- Submission、version history 及 audit event 的 IP 按 `IP_RETENTION_DAYS` 自動匿名化；login attempts、import/export batches、expired sessions 及 rate-limit counters 按各自 retention 設定清理
- 公開單筆及 Excel 提交使用 Idempotency-Key；網絡中斷或回應遺失時，店舖重試會取回原申請編號／原匯入批次，不會重複寫入；Urgent 網頁 1 至 5 SKU 批次使用同一 request key，重試會一次取回全部申請編號。匯入記錄由伺服器按 batch ID 重新產生，不再信任瀏覽器回傳整批資料
- 管理端需密碼登入：密碼存於環境變數 `ADMIN_PASSWORD`（直接常數時間比對，不需 bcrypt hash，避免 `$` 字元在部署平台被展開的問題）；登入後發 httpOnly session cookie（伺服器端 `admin_sessions` 資料表，SHA-256 hash 儲存 token），連線失敗達 `LOGIN_LOCK_THRESHOLD` 次即鎖定 `LOGIN_LOCK_MINUTES` 分鐘；另保留 CSRF 防護、PostgreSQL shared rate limit、安全 headers

## 技術

- Node.js + TypeScript + Express
- PostgreSQL（pg）
- ExcelJS（xlsx 讀寫）
- helmet、express-rate-limit

## 本機開發

需求：Node.js 20+，Docker（或本機 PostgreSQL）。

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

## 部署至 Zeabur

1. 建立 **PostgreSQL** 服務，取得 `DATABASE_URL`。
2. 建立 **Web 服務**，以 Git 或直接上載本目錄部署。Zeabur 會自動偵測 `Dockerfile` 並建置。
3. 在 Web 服務的環境變數設定（全部放入 Zeabur Secrets，不寫入程式碼）：

| 變數 | 說明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 連線字串（Zeabur PostgreSQL 提供） |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `ADMIN_USERNAME` | 管理員使用者名稱（預設 `admin`） |
| `ADMIN_PASSWORD` | 管理員密碼（重要：於 Zeabur Secrets 直接填寫密碼字串，不需要 bcrypt hash） |
| `SESSION_TTL_HOURS` | 登入 session 有效期（小時，預設 8） |
| `LOGIN_LOCK_THRESHOLD` | 失敗登入鎖定次數（預設 5） |
| `LOGIN_LOCK_MINUTES` | 鎖定分鐘數（預設 15） |
| `TRUST_PROXY` | `true`（Zeabur 反向代理後） |
| `TRUST_PROXY_HOPS` | `1`（可信 reverse proxy hop 數） |
| `APP_TIMEZONE` | `Asia/Hong_Kong` |
| `IP_RETENTION_DAYS` | `365` |
| `MAX_UPLOAD_MB` | `5` |
| `MAX_IMPORT_ROWS` | `1000` |
| `EXPORT_FILE_RETENTION_DAYS` | `90`（正式匯出 Excel 保存期限） |
| `AUDIT_RETENTION_DAYS` | `730`（Audit event 保存日數） |
| `LOGIN_ATTEMPT_RETENTION_DAYS` | `90` |
| `IMPORT_BATCH_RETENTION_DAYS` | `730` |
| `EXPORT_BATCH_RETENTION_DAYS` | `730` |
| `PUBLIC_RECOVERY_CODE` | 公開恢復申請編號的共享 Recovery Code |
| `RETURN_SCHEDULE_PATH` | `./return-schedule.json` |
| `RETURN_ENFORCEMENT_START` | `2026-08-01` |
| `CORS_ORIGINS` | 留空（同源）或填允許來源，逗號分隔 |

4. 容器啟動時會自動執行 migration，並在門店主檔為空時載入內建 `stores-template.csv`；migration 使用 PostgreSQL advisory lock，避免多個 replica 同時套用 schema。
5. 在 Zeabur 設定網域並啟用 HTTPS。健康檢查路徑：`/health`。

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
- `audit_events`：提交／查詢／修改／匯入／匯出／鎖定／登入／IP 清理審計；管理員 Audit Report 同時包含版本歷史及 audit events

## 年度維護

- **行貨退貨時間表**：每年更新 `return-schedule.json`（加入新年度的窗口），並視需要調整 `RETURN_ENFORCEMENT_START`。應用程式啟動時若目前年度沒有配置窗口會直接拒絕啟動（fail-fast），不會靜默關閉功能；可用 `npm run schedule:check` 預先檢查。
- **Recovery Code**：定期輪換 `PUBLIC_RECOVERY_CODE`，輪換後需重新部署並通知店舖。

## 已知限制

- `npm audit` 報告 2 個 moderate 漏洞（`uuid`，經 `exceljs` 傳遞）。目前**沒有非破壞性修復版本**（`npm audit fix --force` 會把 exceljs 降級到 3.4.0，屬 breaking change）。實際風險低：該漏洞只影響 uuid v3/v5/v6 並傳入 `buf` 的用法，本平台經 exceljs 使用 uuid v4 且不傳 `buf`。建議在 exceljs 釋出修復版後升級，或日後評估替換 Excel 函示庫。

## 注意事項

- 申請編號為不可猜測隨機值（`NDRF-XXXXXXXX-XXXXXXXX`、`URGENT-XXXXXXXX-XXXXXXXX` 或 `SALES-XXXXXXXX-XXXXXXXX`），查詢必須同時提供 Site Code；使用「搵返申請編號」清單則必須另提供 Recovery Code，且只經 HTTP header 傳送，不放入 URL。
- Urgent Order 的 QTY 必須為 1 至 1000 的整數；網頁單筆／1 至 5 SKU 批次、Excel 模板、申請人修改及管理員修改共用相同驗證規則。網頁批次以單一 transaction 提交，任何一行失敗整批 rollback；每個 SKU 各產生一個申請編號。Urgent Order 必須選擇指定原因（1 至 9）；選擇「9. 其他」時必須填寫 Other Reason，其他選項不得填寫補充原因。
- Urgent Order Excel 模板使用獨立 `Urgent Order` 工作表（欄位：Site Code、SKU、QTY、Urgent Reason、Other Reason），與 Page 1 的 `RP Team` 9 欄模板完全分開。舊版 3 欄模板不再接受，避免產生無原因的申報。
- 突發性銷售申報 Excel 模板使用獨立 `突發性銷售申報` 工作表（欄位：Site Code、SKU），只接受這兩個欄名；同一日同一 Site Code + SKU 在同一申報類型內只能提交一次，一般／Urgent／突發性銷售三種類型互不阻擋。
- Excel 批量上載只接受 Excel 活頁簿 `.xlsx` 格式，支援 Excel 2007 或更新版本（包括 Excel 2019、Excel 2021、Excel 2024 及 Microsoft 365）；舊式 `.xls` 檔案請先另存為 `.xlsx`。`.xlsx` 是檔案格式，不是特定 Excel 版本名稱。
- 舊有（加入原因欄位前）的 Urgent Order 原因欄位為空，可於管理後台編輯時補回；匯出時空白原因會以空白顯示。
- 上載檔內的 `Application Date` 及 `Requested by` 不可信，系統一律以伺服器值及 Site Code 產生值覆蓋。
- 「同一 Site Code + SKU 每日只可申報一次」以 `application_date`（香港當日日期）計算，申請人修改時若把 SKU 改成同日已存在的組合亦會被拒；管理員匯入／編輯不受限制。
- 管理員匯入無 Idempotency-Key 需求（與公開匯入不同），但相同內容的檔案（`content_hash`）重複上載會被拒絕（409），避免誤按或網路重試造成重複寫入；修改過內容的檔案不受影響。
- 錯誤訊息不包含資料庫或內部設定資訊。
- 一般日誌不記錄申報內容、密碼或完整 IP。
