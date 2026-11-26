# Judge

通用的個人代理人程式。透過 Telegram 對話，它會讀寫檔案、執行指令來完成工作，也能開發自己。

程式本身不綁任何身分。身分、人格、規則和記憶都放在「代理人資料夾」裡，換一個資料夾就換一個代理人：可以是像你本人的數位分身，也可以是替你做事的私人代理人。

```
你的手機 TG ──> Telegram 伺服器 <──long polling── Judge ──API──> 模型服務商
                                                      │
                                                      └── 讀寫檔案、執行指令（這台電腦）
```

## 特色

- 零執行期依賴：Node 直接執行 `.ts`，資料庫用內建的 `node:sqlite`
- 一個資料夾一個代理人，可以同時跑好幾個，各用自己的 TG bot
- 對話紀錄存在本機 SQLite，重啟可以接回，模型服務商隨時可以換
- 長期記憶：模型自己判斷什麼值得記，也可以設定成每筆都先經過你核准
- 為 prompt caching 設計：每段對話凍結 system prompt 和工具清單，快取不會因為改了記憶或程式而失效

## 需求

- Node 23.6 以上
- 相容 Anthropic Messages API 的模型服務（目前內建 mixroute 閘道，可以自己加）
- Telegram bot token（在 Telegram 找 @BotFather 建立）
- 自己的 TG user ID（傳訊息給 @userinfobot 查詢）

## 開始使用

```sh
npm install                        # 只裝型別檢查用的工具，執行時不需要
npm link                           # 建立 judge 指令（只要做一次）
judge setup my-agent               # 互動式初始設定
cd ~/要工作的資料夾
judge my-agent                     # 啟動
```

工作目錄就是啟動時的目錄：它讀寫檔案、執行指令都從這裡開始，啟動時會印出來。

也可以在專案目錄用 `npm start -- <名字>`、`npm run setup -- <名字>`。npm 會先切到專案目錄，所以工作目錄一定是 Judge 專案本身，適合開發 Judge。

不帶名字執行會列出現有的代理人。名字只能用小寫英文、數字、連字號。

`judge setup <名字>` 會依序問：

1. 模型服務商，以及它的 API key、網址、模型
2. 通訊軟體（目前是 Telegram），以及 bot token、允許的 TG user ID

## 代理人資料夾

預設在 `~/.judge/agents/<名字>/`：

| 檔案 | 內容 |
|---|---|
| `IDENTITY.md` | 三段：身份（扮演誰）、人格（怎麼說話）、規則（要守什麼）。第一次會寫入預設身分，之後在對話中請它改 |
| `MEMORY.md` | 長期記憶，一行一條，每條有分類（偏好、知識、經驗） |
| `config.json` | 服務商、模型、白名單、記憶設定 |
| `.env` | 機密（API key、bot token） |
| `judge.db` | 對話紀錄（SQLite） |
| `judge.pid` | 執行中自動產生，同一個代理人不能同時跑兩個 |

judge 資料夾（放代理人的地方）依序找：

1. 執行的資料夾裡的 `judge.config.json`
2. `~/.judge/config.json`
3. 預設 `~/.judge`

設定檔內容是 `{ "home": "路徑" }`，相對路徑從設定檔所在的資料夾算，啟動時會印出用的是哪一個。例如在專案目錄放一份 `{ "home": ".judge" }`，資料就會放在專案裡的 `.judge`（已經在 `.gitignore` 裡）。

每個代理人要有自己的 TG bot，同一個 token 不能被兩個程式同時接收。

## 在 Telegram 上使用

- 直接傳訊息給 bot，它會自己決定要不要讀檔或執行指令。
- 只處理白名單帳號的私訊，群組訊息一律忽略。
- 單則訊息最多跑 30 步（模型 → 工具 → 模型…）。
- 處理超過 1 分鐘，每分鐘會靜音傳一則「⏳ 處理中」。
- 處理中可以繼續傳訊息：正在等模型就中止重來，新訊息一起帶進去；正在執行工具就等它跑完再帶進去。

### 指令

| 指令 | 作用 |
|---|---|
| `/stop` | 停止目前正在做的事（包括執行中的指令） |
| `/new` | 開新的對話，舊的留著 |
| `/resume` | 列出最近 10 段對話，點按鈕切換；也可以打 `/resume 編號` |
| `/rename 名稱` | 幫目前的對話取名稱，不帶名稱就由模型取 |
| `/model` | 看目前的模型，或換一個：先選廠商再選模型，可翻頁和返回 |
| `/reload_prompt` | 目前的對話改用最新的 system prompt |

對話紀錄存在 `judge.db`，重啟後會自動接回每個聊天室最近的那段。沒取名的對話用第一句話的前 30 字當名稱。

`/model` 的清單來自服務商的 `GET /v1/models`，依模型名稱分成 Anthropic、OpenAI、Google 等廠商。`/model 關鍵字` 可以先篩選，`/model 完整名稱` 直接換。換掉之後所有對話都用新模型，並寫回 `config.json`，重啟後繼續用。

### 記憶

模型會自己判斷什麼值得長期記住（你的偏好、糾正過它的事、專案慣例），用 memory 工具寫進 `MEMORY.md`，寫完會在回覆裡告訴你。你說「記住…」「忘掉…」也可以。講它扮演誰、怎麼說話、要守什麼規則的不算記憶，它會改 `IDENTITY.md`。

- 上限 2,200 字，滿了它會先合併或刪掉舊的。
- 想每筆都先看過再存，在 `config.json` 加上：

```json
"memory": { "approval": true, "charLimit": 2200 }
```

重啟後，每次要寫入都會跳出「✅ 核准」「❌ 拒絕」按鈕。

### system prompt 和快取

每段對話第一次推論時產生 system prompt（IDENTITY.md + 通用規則 + MEMORY.md），存進 DB 凍結，之後都用同一份，工具清單也一樣。這樣 prompt caching 才不會因為中途寫了記憶或改了程式而失效。

- 同一段對話裡改了 IDENTITY.md 或 MEMORY.md，模型從工具紀錄就知道，不用另外處理。
- 要讓目前的對話用最新的版本（例如改了程式重啟後），打 `/reload_prompt`，那一輪會付一次沒有快取的全額。
- 設定環境變數 `PROMPT_CACHE=off` 可以關掉快取標記。

### 上下文上限

對話用掉超過 80% 時會提醒你開新的一段，超過上限就無法繼續。上限依模型名稱推斷（`claude-opus-5` 系列 100 萬，其他 Claude 20 萬），推斷錯了可以在 `config.json` 的 `provider.settings` 加上 `"contextWindow": "200000"`。

## 讓它開發自己

建一個開發用的代理人，在專案目錄啟動，工作目錄就是它自己的原始碼，可以在 TG 上請它改自己：

```sh
judge setup judge-dev
npm start -- judge-dev
```

IDENTITY.md 可以這樣寫（在對話中請它改也行）：

```markdown
## 身份
你是 judge-dev，用戶開發 Judge 時用的代理人。Judge 是你自己正在跑的程式，用戶透過你在 Telegram 上改進它。

## 人格

## 規則
- 工作目錄就是你自己的原始碼，改動要等用戶重新啟動後才會生效。
- 改了邏輯就要補或更新測試（test/，用 node:test）。
- commit 前一定要跑 npm test 和 npm run typecheck，兩個都要過。
- 不要執行 git push。
- 不要讀取或輸出 .env。
```

改動要重啟才會生效：按 `Ctrl+C`，再執行一次。改壞了就回到上一版：

```sh
git log --oneline
git reset --hard <編號>
```

## 開發

```sh
npm test                              # 全部測試
node --test test/store.test.ts        # 單一檔
npm run typecheck                     # 型別檢查
```

- 測試用 Node 內建的 `node:test`，不裝額外套件，放在 `test/`，對應 `src` 的結構。
- 碰外部服務（Telegram、模型 API）的部分用假物件測，不會真的連網。
- VS Code 可以直接用 `.vscode/launch.json` 下中斷點。

### 專案結構

```
src/
├── main.ts          入口：選代理人、讀設定，把零件組起來
├── agent.ts         迴圈：問模型 → 執行工具 → 再問，直到完成；Telegram 指令
├── tools.ts         工具：read_file、write_file、edit_file、run_command、ask_user
├── models.ts        /model 選單：模型清單依廠商分組、關鍵字篩選
├── memory.ts        記憶工具：MEMORY.md 的新增、修改、刪除
├── prompt.ts        system prompt 的通用部分
├── store.ts         對話紀錄（SQLite）
├── context.ts       上下文上限
├── profile.ts       代理人資料夾：位置、名稱、IDENTITY.md、防止重複啟動
├── config.ts        讀寫代理人的 .env 和 config.json
├── setup.ts         互動式初始設定
├── providers/       模型服務商
├── channels/        通訊軟體
├── types.ts         共用型別
└── util.ts
```

新增服務商或通訊軟體：在 `src/providers/` 或 `src/channels/` 加一個檔案，再登記到該資料夾的 `index.ts`。相容 Anthropic Messages API 的服務可以直接用 `providers/anthropic-messages.ts`。

### 除錯

完整的對話（包括工具呼叫和結果）都在資料庫裡：

```sh
sqlite3 ~/.judge/agents/<名字>/judge.db "SELECT id, title, message_count, last_input_tokens FROM sessions ORDER BY updated_at DESC"
sqlite3 ~/.judge/agents/<名字>/judge.db "SELECT role, content FROM messages WHERE session_id = '<id>' ORDER BY id"
```

每次推論的 token 用量（快取讀、寫、未快取、輸出）會印在終端機。

## 安全

- `run_command` 等於把這台電腦的 shell 交給模型，白名單是唯一的門，一定要設對。
- 執行指令時，API key 和 bot token 不會傳給子程序。但它還是能用指令讀代理人資料夾的 `.env`，這只靠 system prompt 要求，不是硬性限制。
- 所有訊息都會經過 Telegram 的伺服器。
