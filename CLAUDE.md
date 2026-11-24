# Judge

通用的個人代理人程式：透過 Telegram 對話，讀寫檔案、執行指令來完成工作。一個資料夾就是一個代理人，換檔案就能換身份（數位分身或私人代理人）。使用方式見 README.md。

## 給 Claude 的指示

- 一律用繁體中文回覆（程式碼、指令、專有名詞維持原文）。
- 解釋要簡單直接，選項一題一題問，不要一次丟很多。
- `.env`（包括代理人資料夾裡的）含機密，不要讀取、輸出或提交。

## 開發

- Node 23.6 以上，直接執行 `.ts`，不用編譯。型別檢查 `npm run typecheck`，測試 `npm test`，commit 前兩個都要過。
- 測試用 Node 內建的 `node:test`，放在 `test/`，對應 `src` 的結構（`src/store.ts` → `test/store.test.ts`），不裝額外套件。改了邏輯要補或更新測試。
- 啟動：`judge <名字>`（工作目錄 = 啟動時的目錄），或在專案目錄 `npm start -- <名字>`。設定：`judge setup <名字>`。
- 代理人資料夾在 `<judge 資料夾>/agents/<名字>/`（judge 資料夾：執行的資料夾的 `judge.config.json` → `~/.judge/config.json` → `~/.judge`）：IDENTITY.md、MEMORY.md、config.json、.env、judge.db。
- 新增服務商或通訊軟體：在對應資料夾加一個檔案，再登記到該資料夾的 `index.ts`。
