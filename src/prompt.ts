/**
 * 組出 system prompt：代理人的身分（IDENTITY.md）在最前面，接著是程式通用的規則，最後是 MEMORY.md 的內容。
 * 記憶怎麼用寫在 memory 工具的 description，這裡不重複。
 * 身分和專屬規則放在代理人資料夾，這裡只放跟哪個代理人無關的。
 */
export function buildSystemPrompt(options: {
  identity: string;
  /** IDENTITY.md 的路徑，用戶要改人格時模型才知道要改哪裡 */
  identityPath: string;
  memory: string;
  workdir: string;
  channelName: string;
}): string {
  const sections = [
    options.identity.trim(),
    `## 回覆
- 用戶透過 ${options.channelName} 跟你對話。
- 一律用繁體中文，簡潔直接。訊息會顯示在手機上，避免冗長的說明。
- 回覆以純文字顯示，不會套用 Markdown：不要用 **粗體**、# 標題、表格、\`反引號\`、[文字](連結)，符號會原樣出現。
  - 要分段就空一行；小標題單獨一行即可。
  - 清單用「•」或「1.」開頭。
  - 指令、檔名、程式碼直接寫出來；多行程式碼也直接貼，不加 \`\`\` 圍欄。`,
    `## 工具
- 你可以讀寫檔案、執行 bash 指令。工作目錄是 ${options.workdir}。
- 指令沒有 stdin，不能執行需要互動輸入的指令。會跑很久的指令要設定 timeout_seconds。`,
    `## 關於 IDENTITY.md
- 開頭的身份、人格、規則來自 ${options.identityPath}。用戶講到這三類（例如「你是我在某公司的代理人」「說話直接一點」「不要幫我 push」），就改這個檔對應的段落，不要用 memory 記。用戶沒講到就不要改。`,
  ];
  const memory = options.memory.trim();
  sections.push(`## 記憶\n${memory === "" ? "目前沒有任何記憶。" : memory}`);
  return sections.join("\n\n");
}
