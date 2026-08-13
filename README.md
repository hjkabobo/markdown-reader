# Markdown 閱讀器（md-reader）

本機小工具：把散在各專案裡的 markdown 與 CSV 檔案，用漂亮排版在瀏覽器裡閱讀（CSV 以表格呈現，支援篩選與分頁）。

純 Node 內建模組寫成，**零外部依賴、不用 `npm install`**，只要電腦有 Node 就能跑。

## 安裝與啟動

1. 複製 `reader.config.example.js` 成 `reader.config.js`，把 `projectRoots` 改成你自己要掃的資料夾（見下方「要改掃描的資料夾？」）。
2. 在 md-reader 資料夾裡執行：

```
./start.sh
```

3. 開 **http://localhost:2004**（埠號 2004 = Markdown 的誕生年），關掉按 `Ctrl + C`。

`reader.config.js` 不存在時 server 會退回讀範本，不會誤掃到不該掃的資料夾，但也就看不到東西，所以第 1 步別跳過。

## 讓它開機自動啟動（選用，macOS）

想要「登入電腦後它就自己跑、當掉會自動重開」，可以掛成 launchd 背景服務：在 `~/Library/LaunchAgents/` 放一個 plist（例如 `com.you.md-reader.plist`），`ProgramArguments` 指向 `node /你的路徑/md-reader/server.js`，加上 `RunAtLoad` 與 `KeepAlive`。之後用這幾條指令管理：

```
# 看是否在跑（有列出就是在跑）
launchctl list | grep md-reader

# 啟用 / 啟動
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.md-reader.plist

# 停止並停用（之後開機不再自動啟動）
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.you.md-reader.plist

# 改過程式碼後，重啟服務讓它生效
launchctl kickstart -k gui/$(id -u)/com.you.md-reader
```

把網址加進瀏覽器書籤最順手。

## 功能

- **左側清單**：`reader.config.js` 裡設定的專案 repo，以及（若開啟）Claude memory、Codex memory 底下所有 `.md` 與 `.csv`，照資料夾分層，可展開／收合。CSV 檔會用綠色檔案圖示區分。
  - 排序：每一層都資料夾在前、檔案在後。
  - Memory root 會先包一層 `memory` / `memories` 資料夾，避免 root 一展開就直接列出所有文件；這只是閱讀器顯示用的收合層，不會搬動實際檔案。
- **排序切換**：清單上方可切「名稱／最近修改」。最近修改會把所有檔案攤平、依修改時間新到舊排，方便找剛動過的筆記。
- **釘選**：每個檔案／資料夾名稱旁有星星，點亮即釘到上方「釘選區」。點釘選的檔案直接開啟；點釘選的資料夾會展開並捲到它。
- **中間內文**：GitHub 風格排版，支援標題、表格、清單、引言、程式碼上色、核取清單。
- **CSV 表格檢視**：`.csv` 檔會以表格呈現，上方有篩選框（跨所有欄位即時篩選、顯示符合筆數），每頁 100 列、上下各一組分頁按鈕。表頭固定、滑鼠移過整列高亮。
- **右側大綱（TOC）**：自動列出本頁標題，可點擊跳轉；捲動時高亮目前章節。
- **自動更新**：正在看的檔案被修改時，內容會自動重新載入（保留捲動位置）；新增或刪除檔案時，左側清單也會自動更新，不需要手動重新整理頁面。
- **搜尋**：左上輸入框，同時搜尋「檔名」與「內文」，結果附上含關鍵字的預覽；點結果開啟檔案後，內文會高亮所有關鍵字並自動捲到第一個。
- **檔案提及自動變連結**：內文中提到帶資料夾路徑的 `.md` 檔名（例如 `budget-app/CLAUDE.md`），或既有的 `[文字](路徑.md)` 連結，都會自動變成可點連結，點下去直接切換到那個檔案的內容頁。裸檔名（沒寫路徑，如單獨的「CLAUDE.md」）因為多個專案常撞名，故不轉連結，避免點錯檔案。
- **圖片預覽**：內文中的相對路徑圖片（例如 `images/xxx.png`）會自動顯示，不用另外開檔。
- **用編輯器開啟**：開啟檔案後，內文右上角有按鈕，點了會用系統預設編輯器打開該原始檔。
- **下載 PDF**：內文右上角「下載 PDF」按鈕，開啟瀏覽器列印對話框，選「另存為 PDF」。只印中間內文（左側清單、右側大綱、編輯器都會隱藏），長文件自動分頁。
  兩個常見狀況都是**瀏覽器的列印設定**、不是閱讀器的問題，在列印對話框的「更多設定」裡調整：
  - **程式碼區塊的底色不見、只剩外框** → 勾「背景圖形」（Chrome 預設不印任何背景色）。
  - **頁面上下多出日期／檔名／網址／頁碼** → 取消「頁首及頁尾」。
- **深色／淺色**：右上角 ◐ 按鈕切換，會記住你的選擇。
- **上一頁／下一頁**：用瀏覽器原本的上一頁（`⌘[`、`⌘←`，或觸控板兩指往右滑）就能退回剛才看的檔案，且會回到你離開時捲動的位置；下一頁同理。同一份檔案再開也會停在上次讀到的地方（捲動位置記在分頁裡，關掉分頁就重來）。
- 重新整理會記得上次開的檔案。

## 編輯（直接在閱讀器裡改，僅限 `reader.config.js` 裡設為 editable 的 repo）

Claude memory 與 Codex memory 目錄維持唯讀（避免閱讀器誤改索引格式），設為 editable 的 repo 底下的 markdown 可以直接改：

- **勾待辦**：閱讀模式下，`- [ ]` 的方框可以直接點，點下去就存檔，不用進編輯模式。
- **編輯模式**：內文右上角「編輯」按鈕（或按 `⌘E`）。左邊打字、右邊即時預覽，`⌘S` 存檔、`Esc` 離開。打字時有兩個順手的小東西：在清單或待辦那一行按 Enter 會自動接下一個項目（連按兩次結束清單）、`Tab` 縮排。
- **新增檔案**：左側清單上方「＋ 新增檔案」。輸入 `資料夾/檔名.md` 即可，資料夾不存在會自動建立，沒打 `.md` 會自動補上。建好直接進編輯模式。
- **改檔名**：內文右上角「編輯」進去後，上方那格檔名欄本身就是輸入框，改完跟著存檔一起生效；連路徑一起改就等於換資料夾（撞到同名檔會擋下來）。這個檔案若有被釘選，釘選會自動跟著換路徑。

安全與防呆：

- **只能改 markdown**。CSV 屬於資料檔，閱讀器一律不給編輯，避免弄壞來源資料。
- **只能改設為 editable 的 repo**。Claude memory、Codex memory 目錄一律唯讀，不會出現編輯／新增／改檔名的按鈕，後端也會擋下對這些目錄的寫入請求。
- **每次存檔前自動備份**舊版到 `md-reader/.backups/`，同一個檔案留最近 10 份（不納入 git）。
- **擋掉覆蓋衝突**：如果檔案在你編輯期間被 Claude 或其他程式改過，存檔會被擋下來並提示，不會默默蓋掉對方的修改。編輯模式中若偵測到檔案被改動，畫面右下角會先跳提示。
- 寫入 API 一樣受路徑白名單保護；並且只接受閱讀器自己送出的請求（擋掉其他網頁偷偷對 localhost 送改檔請求）。

## 你的設定存在哪

- **釘選、排序**：存在 `md-reader/.reader-state.json`（硬碟檔，清瀏覽器也不會掉）。
- **深色／淺色**：存在瀏覽器（localStorage）。

## 掃描範圍 / 安全性

- 掃哪些資料夾由**本機設定檔 `reader.config.js`** 決定（見下方「多台電腦同步」）：裡面列的專案 repo，加上（若 `scanClaudeMemory` 開啟）`~/.claude/projects/*/memory`、`~/.claude-client/projects/*/memory`、`~/.codex/memories` 底下的 markdown 與 `.csv`。清單裡實際不存在的資料夾會自動略過。
- Codex 的 `~/.codex/memories_1.sqlite` 是 SQLite 資料庫，不是 markdown，md-reader 目前不直接顯示。
- 自動略過 `node_modules`、`.git`、`.next`、`dist` 等資料夾。
- 後端有路徑白名單檢查，無法讀到白名單（即 `reader.config.js` 的範圍）以外、或非 `.md`／`.csv` 的檔案。
- **編輯／新增／改檔名只開放設為 `editable` 的 repo**，memory 目錄唯讀，見上方「編輯」章節。

## 要改掃描的資料夾？

編輯 md-reader 資料夾裡的 **`reader.config.js`**（不是 `server.js`）。在 `projectRoots` 陣列加一行即可，例如：

```js
{ id: 'desktop', label: '桌面筆記', dir: path.join(HOME, 'Desktop/notes'), editable: true },
```

`reader.config.js` 是**各台電腦自己的設定**，已被 `.gitignore` 排除，不會進版控；範本見 `reader.config.example.js`。

Claude memory 目錄名（`-Users-you-Documents-my-repo` 這種）不好讀，可在同一份設定檔用 `memoryLabels` 指定顯示名稱、`memoryLabelOrder` 指定排序，沒設定就直接顯示原始目錄名。

## 多台電腦同步（選用）

想在多台電腦上用同一份程式碼，就把整包放進自己的 git repo 同步：程式碼保持一致，只有「這台掃哪些資料夾」因機器而異，各台自己維護 `reader.config.js`（已被 `.gitignore` 排除、不同步）。

- 改東西前先 `git pull`，改完 `git commit` + `git push`，別台才 pull 得到。
- 不要 commit 本機／執行期檔：`reader.config.js`、`.backups/`、`.reader-state.json`、log 等都已在 `.gitignore` 裡，別硬加進版控。
- 新的一台：clone 下來、複製 `reader.config.example.js` 成 `reader.config.js` 改成這台要掃的資料夾、啟動、確認 `http://localhost:2004` 回 200。

## 技術

純 Node 內建模組，**零外部依賴**（不用 `npm install`）。前端渲染用 marked + DOMPurify + highlight.js，已內建在 `public/vendor/`，離線可用。

## 作者與授權

設計與規格：[Jenny Lu](https://github.com/hjkabobo)；實作由 Claude Code 協助完成。

功能取捨、安全邊界（路徑白名單、Origin 檢查、唯讀／可編輯目錄分界、存檔前自動備份與覆蓋衝突防護）與使用流程都是先定規格再實作的結果。

授權：[MIT](LICENSE)，可自由使用與修改，請保留原始著作權聲明。
