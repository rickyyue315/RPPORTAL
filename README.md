# NDRF 申報平台

SASA RP Team 非正常補貨（NDRF）申報平台。申請端與管理端均免登入，部署於 Zeabur（Web/API 服務 + PostgreSQL）。

## 功能

- 公開單筆申報（Site Code + SKU + RP Type 必填，Site Code 驗證門店主檔；RP Type 為 RF 時必須填寫 Safety stock（大於 0）及指定店舖的 Remark，為 ND 時必須填寫 ND Code）
- 公開 Excel 批量上載（固定模板 `RP Team` 工作表，整檔驗證，錯誤不寫入任何行）
- Urgent Order 申報（`/urgent.html`）：只需 Site Code、SKU、QTY（1 至 1000 的整數），單筆提交或獨立 3 欄 Excel 批量上載
- Urgent Order 申請編號使用 `URGENT-...` 前綴；超出 1000 件的需求改以電郵向相關 Buyer 申請，不在平台處理
- 申請編號 + Site Code 查詢／修改（匯出前可修改，每次修改新增不可變版本；Urgent 不提供申請人查詢／修改）
- 管理後台：清單篩選（含申報類型）、詳情編輯、版本歷史、模板下載、批量匯入、SAP 12 欄匯出、獨立 Urgent 匯出、完整審計報表、門店主檔管理
- SAP 匯出只包含一般 NDRF，Urgent Order 使用獨立 4 欄匯出；匯出成功後鎖定該批申報，申請人不能再修改；匯出失敗不鎖定
- IP 審計保留 12 個月後自動匿名化
- 管理端免登入（已取消密碼登入），仍保留 CSRF 防護、速率限制、安全 headers

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
- 查詢／修改：<http://localhost:3000/lookup.html>
- 管理後台：<http://localhost:3000/admin/index.html>（免登入）

首次啟動時若 `stores` 主檔為空，會自動載入 `stores-template.csv`（預設路徑可由 `STORES_CSV_PATH` 覆寫）。

## 測試

```bash
npm test          # 單元 + 整合 + API 測試（使用 PGlite 記憶體 Postgres）
npm run smoke     # 端到端 smoke test（真實 HTTP + PGlite）
```

## 部署至 Zeabur

1. 建立 **PostgreSQL** 服務，取得 `DATABASE_URL`。
2. 建立 **Web 服務**，以 Git 或直接上載本目錄部署。Zeabur 會自動偵測 `Dockerfile` 並建置。
3. 在 Web 服務的環境變數設定（全部放入 Zeabur Secrets，不寫入程式碼）：

| 變數 | 說明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 連線字串（Zeabur PostgreSQL 提供） |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `TRUST_PROXY` | `true`（Zeabur 反向代理後） |
| `APP_TIMEZONE` | `Asia/Hong_Kong` |
| `IP_RETENTION_DAYS` | `365` |
| `MAX_UPLOAD_MB` | `5` |
| `MAX_IMPORT_ROWS` | `1000` |
| `CORS_ORIGINS` | 留空（同源）或填允許來源，逗號分隔 |

4. 容器啟動時會自動執行 migration，並在門店主檔為空時載入內建 `stores-template.csv`。
5. 在 Zeabur 設定網域並啟用 HTTPS。健康檢查路徑：`/health`。

## 資料模型

- `stores`：門店主檔（Site Code 唯一）
- `submissions`：申報主表（`application_no` 唯一、`submission_type` 分 `normal`／`urgent`、`qty` 供 Urgent 使用、狀態固定 `received`、匯出鎖定欄位）
- `submission_versions`：不可變版本歷史（前後資料快照、操作者角色、IP、時間）
- `import_batches`：Excel 匯入批次
- `export_batches`：SAP／Urgent 匯出批次（建立即鎖定該批申報）
- `audit_events`：提交／查詢／修改／匯入／匯出／鎖定／IP 清理審計

## 注意事項

- 申請編號為不可猜測隨機值（`NDRF-XXXXXXXX-XXXXXXXX` 或 `URGENT-XXXXXXXX-XXXXXXXX`），查詢必須同時提供 Site Code。
- Urgent Order 的 QTY 必須為 1 至 1000 的整數；單筆表單、Excel 模板及管理員修改共用相同驗證規則。
- Urgent Order Excel 模板使用獨立 `Urgent Order` 工作表（欄位：Site Code、SKU、QTY），與 Page 1 的 `RP Team` 12 欄模板完全分開。
- 上載檔內的 `Application Date` 及 `Requested by` 不可信，系統一律以伺服器值及 Site Code 產生值覆蓋。
- 錯誤訊息不包含資料庫或內部設定資訊。
- 一般日誌不記錄申報內容、密碼或完整 IP。
