'use strict';

// 範本：本機掃描範圍設定。
//
// 使用方式：複製本檔成 reader.config.js（同資料夾），再改成「這台電腦」要掃的範圍。
// reader.config.js 被 .gitignore 排除、不參與同步；每台電腦各自維護一份。
// 若某台還沒建 reader.config.js，server 會退回讀本範本；本範本刻意留成空／示意值，
// 沒配置前不會誤掃到不該掃的資料夾（靠 existsSync 只掃實際存在的目錄）。
//
// 資料隔離提醒：每個環境只列「該環境該看的 repo」，不要把別環境的 repo 也列進來。

const os = require('os');
const path = require('path');
const HOME = os.homedir();

module.exports = {
  // 這台要掃描的專案 repo，改成這台實際要看的資料夾。
  // editable: true 的才允許在閱讀器內編輯；
  // wrapDirName 會把該目錄包一層同名資料夾顯示（memory / memories 類用）。
  projectRoots: [
    { id: 'my-repo', label: '我的專案', dir: path.join(HOME, 'Documents/my-repo'), editable: true },
    // 需要更多就再加幾列，例如唯讀的 memory 目錄：
    // { id: 'codex-memories', label: 'Codex Memory', dir: path.join(HOME, '.codex/memories'), wrapDirName: 'memories' },
  ],

  // 是否自動掃描 ~/.claude/projects 與 ~/.claude-client/projects 底下的 memory 目錄。
  // 若這台可能殘留別環境的 memory，設 false 最保險。
  scanClaudeMemory: false,

  // （選用）Claude memory 的目錄名不好讀（例如 -Users-you-Documents-my-repo），
  // 可在這裡指定要顯示成什麼；沒列的就直接用原始目錄名。
  memoryLabels: {
    // '-Users-you-Documents-my-repo': '我的專案',
  },

  // （選用）上面那些顯示名稱的排列順序，沒列到的排在後面、依名稱排序。
  memoryLabelOrder: [
    // '我的專案',
  ],
};
