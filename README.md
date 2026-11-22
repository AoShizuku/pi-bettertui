# pi-bettertui

给 [Pi](https://pi.dev) 的上半部分做减法的 TUI 插件：**工具行压成一行；「思考 + 侦察」在 agent 工作时逐条列出、每条一行、只追加不缩回，本轮结束后整段折成一行摘要**。下半部分不碰 footer，继续交给 `pi-hud` 之类的 statusline。

```text
❯ 给 CLI 加 --json，补测试和文档

● 我会先看参数解析，再加 flag，最后补测试。

  ├ Thought for 2.8s
  ├ Bash (rg -n parseArgs src) · Done · 3 lines
  ├ Read (src/index.ts:1-80) · 40 lines
  ├ Grep (/flag/ in src) · 5 matches
  └ Bash (构建所有包) · Running… 12s
     $ npm run build --if-present
       cd packages/core && yarn build
     compiling src/…
     Building…
     ✓ built in 3.2s
```

本轮结束后：

```text
  Thought for 18.3s · Ran 2 commands · Read 1 file · 1 search ▸

● 入口在 src/index.ts，flag 加在 parseArgs 里。

● Edit (src/index.ts) · +1 −1
● Bash (npm test) · Done · 4 lines · 2.0s

✻ Worked for 2m 5s · 7 tools
```

所有行共用一条 2 列左栏：标识（`● ✻ ❯`，正文的 `●` 用浅色）在第 0 列，内容从第 2 列开始，和 `pi-editor` 的输入框、`pi-hud` 的 footer 对齐（约定见 pi-shizuku 的 `README.md`，取舍见 `DESIGN.md`）。
用户消息里的图片（`pi-editor` 粘贴的）不进色块，每张一行挂在下面：`├ Image #1 · 2328×1692 → 2000×1454`，Ctrl+点击编号打开原图。
第 0 列只给「事件」（正文、单条工具、变更、用户消息）；思考块、阶段摘要、只读组组头这类「过程行」不带标识，整行浅色，从第 2 列开始，出错时才在第 0 列放 `!` / `×`。

## 做什么

### 1. 工具行不再是一大块

Pi 原生给每条工具套 `Box` + 背景 + `Spacer(1)`，bash 还默认展示 5 行输出。`pi-bettertui` 用 `renderShell: "self"` 重画：

- `read/grep/find/ls`：一行 `Read(path:range) · N lines` / `Grep(pattern in path) · N matches`。
- `edit`：`Edit(path) · +N −M`。
- `write`：`Write(path) · N lines`。
- `bash/powershell`：`Bash(描述) · Done · N lines · 2.0s`；失败时显示最后 2 行错误。展开后先列出完整命令（`$ cmd`，自动换行，最多 12 行），再列输出。
- 运行中的命令（fold 开启时）先只有头行 `Running…`；**跑满 1 秒**才展开成**固定高度**的块：模型填了 `description` 时第 5 列再列脚本前 2 行，最后是输出尾部 3 行（`shellPreviewLines`），不足补空行，不随输出抖动。不满 1 秒结束的命令始终只占一行，不会一闪。fold 关闭时沿用旧画法：头行下面露出最后 `shellPreviewLines` 行输出。
- 不再给每条命令加背景框；只有代码块和展开详情才需要额外空间。

### 1.1 shell 命令的 `description`

Pi 原生 `bash`/`powershell` 只有 `command` 参数，长命令会占满整行再被截断。插件默认用同名工具覆盖这两个内置工具，在 `command` 后加一个**可选**的 `description` 参数（做法同 Claude Code / MiniMax Code），执行逻辑仍调用 Pi 自己的实现（沿用 `shellPath`、`shellCommandPrefix` 设置），激活状态也和内置工具一致。

- 模型填了 `description`：工具行显示描述（用户的语言），完整命令放在展开详情里。
- 没填，或关掉了这个开关：命令最多显示 72 列，超出部分从**中间**省略，开头的程序名和结尾的 `| head -20` 之类都保留。
- 开销：工具定义每个约多 50 token（可被 prompt cache 命中）；每次调用多输出约 10–20 token。
- 它改的是工具 schema，所以开关在 `/reload` 后生效；`enabled` 或 `tools.compact` 关闭时也不会注册覆盖。若别的扩展也覆盖了 `bash`，按 Pi 的规则后注册的生效。

### 2. 阶段折叠（fold）

国产 thinking 模型的一轮常是 `thinking → bash → thinking → read → read → bash …`。插件把一段**连续的思考与不改东西的工具调用**（一个「阶段」）跨 assistant 消息合并起来：agent 工作时画成紧凑列表，**本轮结束时**（`✻ Worked for` 出现的同一时刻）整轮的阶段一起折成一行摘要：

```text
  ├ Thought for 2.8s
  ├ Bash (npm run build) · Done · 12 lines
  ├ Read (src/index.ts:1-80) · 40 lines
  └ … build 过了，再跑一遍测试看失败点
    先看 parse 的单测
    再看 cli 的集成测试
```

```text
  Thought for 12.4s · Ran 3 commands · Read 5 files · 1 search ▸
```

- **运行中是列表**：一个条目一行、中间无空行，条目只追加不缩回；新条目追加时，原来的最后一条从 `└` 变成 `├`。中途遇到正文或 edit 只是结束这个阶段，列表留在屏幕上，直到本轮结束才收起。
- **边界**：可见正文、`edit/write`、会改东西的命令、SKILL.md 读取、未接管的工具（MCP 等）、出错/中止、user 消息、压缩都会结束阶段。切分按 block，不按消息：同一条消息里正文之前的思考留在上一段，之后的另起一段。
- **会改东西的命令单独显示**：`git commit/push/reset/checkout/…`、`rm/mv/cp/mkdir/touch/chmod`、`sed -i`、重定向到文件（`>`、`>>`、`tee`；`/dev/null` 和 `2>&1` 除外）、`npm/pnpm/yarn/pip/cargo install|add|remove` 等。判定从宽：多判一条只是多显示一行。命令参数还在流式时先算作折叠，参数流完判定为变更就移出阶段、单独成行。
- **阈值**：阶段里至少 2 个条目才合并（`fold.minItems`）；单独一个 `Read` 或一段孤立的思考照常显示。单条本来就是一行，变成列表时第一条也是一行，不会跳。
- **live**：正在发生的条目挂在列表最后——流式中的思考是最后一条，露 3 行尾巴（第 4 列，思考色斜体），流完收成一行浅色的 `Thought for 2.8s`（这个 run 自己流了多久，一分钟内保留一位小数）；运行中的命令是它自己那一行 `Running… 4s`，跑满 1 秒才在下面展开上面那种固定高度块，跑完收回成一行。并行的多条命令只有最新一条给完整块，其余各 1 行。
- **摘要行**：本轮结束后才出现。过程行，无标识、整行浅色、第 2 列起，过去时（`Thought for 12.4s · Ran 2 commands · Read 5 files`）。`Thought for` 累加含思考的消息的生成时长，每条消息只算一次；旧会话没有时长时省略。有失败时第 0 列出现 `!`（部分）/ `×`（全部），`· N failed` 用错误色，下面露出全部失败条目（最多 3 条，更早的折成 `… N more failed`）；点失败行原地展开它的输出，不展开整个列表。
- **展开**：点击摘要（或 `Ctrl+O`）展开回列表，版式与运行中相同，顺序是模型真实的输出顺序；思考条目是一行浅色 `Thought for 2.8s`（恢复的会话里取所在消息的生成时长，一条消息有多段思考时分不开，只写 `Thought`），工具条目同组子项。点击条目再展开它的详情（思考全文 / 命令与输出），详情在第 5 列；`Ctrl+T` 让列表里的思考条目都显示全文；运行中的列表同样可以点条目：

```text
  Thought for 12.4s · Ran 2 commands · Read 1 file ▾
  ├ Thought for 2.8s
  ├ Bash (npm run build) · Done · 12 lines
  │  $ npm run build
  │  …
  ├ Read (src/index.ts:1-80) · 40 lines
  └ Bash (npm test) · Failed (exit 1) · 40 lines
```

- 本轮里手动展开过的阶段，本轮结束时同样收起。
- **画在哪**：阶段的第一个条目（一个思考块或一行工具）画全部内容，其余条目一行不占，所以阶段内部没有空行；阶段与正文、变更行之间仍是 Pi 原有的 1 行空行。整条消息的内容都被折进上面的阶段时，这条消息不留空行。
- `thinking 0`（原生思考块）时思考不参与折叠，只折工具。
- 恢复会话（resume）后折叠结果与当时一致：历史里的轮次都已结束，全部是收起的摘要。

### 2.1 fold 关闭时：只合并只读探索

`/bettertui fold off` 后回到原来的画法：连续的同 turn `read/grep/find/ls` 会变成一条活动组：

```text
  Explored 2 files, 1 search · 1.2s ▸
```

- 组头是过程行：第 0 列留空，整行浅色；进行中与已结束靠时态区分（`Exploring` / `Explored`），不靠颜色。
- 组头显示**名词**，不是 `3 tool calls`。
- 运行中最多露出最后 2 个子项。
- `Ctrl+O` 或点击组头展开；展开后显示每个成员和结果预览（组内每个成员最多 8 行，单条工具最多 14 行）。
- `edit/write/bash`、未知工具、MCP 副作用工具**永远不合并**，避免把变更藏起来。
- 组内错误会保留：组头第 0 列出现 `!`（部分失败）/ `×`（全部失败），`· N failed` 用错误色，并自动露出失败成员：

```text
! Read 2 files · 1 failed · 0.8s ▾
  └ Read (src/missing.ts) · failed
```

### 2.2 skill 一行

`/skill:name` 调用和模型读取 `…/<name>/SKILL.md` 都画成同一种紫色行，与工具行左对齐，不再是带背景的整块：

```text
● [Skill] (code-review) ▸
```

- 从 `●` 到 `]` 用主题的 `customMessageLabel` 色，skill 名放括号里。
- `Ctrl+O` 或点击展开 skill 正文（`▾`）。
- 读 `SKILL.md` 不并入只读组或折叠阶段，前后的读取各自成组；读取失败时标记变成红色 `×`。
- `/skill:name` 的行由 Pi 内置组件绘制，插件给它的 `updateDisplay` 打补丁；`/bettertui off` 后恢复 Pi 原样。

### 3. 思考固定 3 行

- 流式中：`Thinking… 12s` + 最后 3 个逻辑行，固定高度，不随 token 换行抖动。
- 正文开始或消息结束：折成 `Thought for 18.3s`。
- 思考块是过程行：不带标识，整行浅色，从第 2 列开始；流式尾巴和展开后的全文缩到第 4 列，表示从属。
- 思考块和前后的正文之间保持 Pi 原有的空行。
- `Ctrl+T` 或点击思考行展开完整 Markdown。
- 如果没有 `durationMs`（例如旧会话），只显示 `Thought`，不会用“现在 - 消息时间”伪造一个巨大的时长。
- 默认折叠，避免完整 CoT 占满滚动区；完整内容仍在 session 里，可随时展开。

### 4. 轮次结束一行

`agent_settled` 后追加一条 TUI-only entry：

```text
✻ Worked for 2m 5s · 7 tools
```

不会进入 LLM 上下文，也不会改 footer。

按 Esc 中断时，这一行改成 `✻ Interrupted after 12s · 3 tools`（`Interrupted` 是 warning 色），pi 原来那行红色 `Operation aborted` 不再画。
被中断的工具行是 warning 色的 `●` 加 `interrupted`，不算失败：组头和阶段摘要只写 `· N interrupted`，不出现 `!` / `×`。取舍见 `DESIGN.md` §9。

### 4.1 新会话一条分段线

`/new` 和 `/clear` 之后，对话区顶部是一条分段线，代替 pi 的 `✓ New session started` 和 pi-clear 的提示：

```text
─ New session · 14:32 ───────────────────────────────────
```

只画在屏幕上，不写进会话；恢复会话时不出现。取舍见 `DESIGN.md` §10。

### 5. 顶部 header：一行版本 + 一张资源表

Pi 原来的顶部是 logo + 欢迎区，上下各留一行空白，下面的 `[Context]` / `[Skills]` / `[Extensions]` 每段之间再空一行。
现在压成：

```text
pi v1.5.2   esc interrupt · / commands · ! bash · ctrl+o expand

[Context]     AGENTS.md
[Skills]      feishu-doc, feishu-im, feishu-project, gitee-cli, teambition-cli,
              tsubasa-log, tsubasa-mysql, tsubasa-redis, tsubasa-ssh
[Extensions]  pi-ask-user, pi-autotitle, pi-background-shell, pi-bettertui,
              pi-clear, pi-dsweb, pi-editor, pi-effort, pi-hud
```

标签对齐到最宽的一个，名单只在名字之间折行，续行挂在名单列下；终端太窄时标签单独一行。
本地扩展名后面的 `/src` 去掉。`ctrl+o` 展开时仍是 Pi 自己的完整路径列表。
`/bettertui header off` 去掉版本行，资源表照旧。

## 安装

安装：

```bash
pi install npm:@aoshizuku/pi-bettertui                # 从 npm 安装
pi install git:github.com/AoShizuku/pi-bettertui     # 或从 GitHub 安装
```

本地路径安装（clone 之后）：

```bash
pi install ./pi-bettertui
```

只试一次：

```bash
pi -e ./pi-bettertui/src/index.ts
```

要求和 Pi 1.5.2 对齐。插件不调用 `setFooter`，可以和 `pi-hud` 共存；但不要同时启用 `pi-open-tui` 或 `pi-pretty-tui`，它们会抢同一个 header/transcript 组件。

## 配置

配置文件：`~/.pi/agent/better-tui.json`（受 `PI_CODING_AGENT_DIR` 影响）。

```json
{
  "enabled": true,
  "header": "compact",
  "thinking": {
    "lines": 3
  },
  "tools": {
    "compact": true,
    "groupReadOnly": true,
    "shellPreviewLines": 3,
    "shellDescription": true
  },
  "userShell": {
    "foldAnswered": true
  },
  "turnSummary": true,
  "fold": {
    "enabled": true,
    "minItems": 2
  }
}
```

| 字段 | 默认 | 说明 |
|---|---:|---|
| `enabled` | `true` | 关闭后新工具行回到 Pi 原生渲染 |
| `header` | `"compact"` | `"compact"` 显示版本行；`"off"` 不显示（资源表照旧） |
| `thinking.lines` | `3` | 流式窗口行数；`0` 表示完全交回 Pi 原生思考块 |
| `tools.compact` | `true` | 紧凑工具行 |
| `tools.groupReadOnly` | `true` | 合并连续只读探索 |
| `tools.shellPreviewLines` | `3` | 运行中的 shell 输出预览行数（0–4） |
| `tools.shellDescription` | `true` | 给 `bash`/`powershell` 加可选 `description` 参数并在工具行显示；`/reload` 后生效 |
| `userShell.foldAnswered` | `true` | `!` / `!!` 方框下面出现用户消息后折成三行（命令 + 输出行数），点击展开 |
| `turnSummary` | `true` | 轮次结束追加 `Worked for` / `Interrupted after`；关闭后中断提示改成第 2 列的 `Interrupted` |
| `fold.enabled` | `true` | 阶段折叠；关闭后行为与旧版一致（只读组照旧）。需要 `enabled` 与 `tools.compact` 同时开启 |
| `fold.minItems` | `2` | 阶段至少几个条目才折叠（1–99） |

## 命令

```text
/bettertui                     status
/bettertui on | off            启用/停用
/bettertui header off|compact  顶部 header
/bettertui thinking 0-5        思考窗口行数；0 = 原生
/bettertui group on|off        只读活动组
/bettertui tools on|off        紧凑工具行
/bettertui describe on|off     shell 命令的 description 参数（/reload 后生效）
/bettertui shellfold on|off    `!` 方框被提问「用过」后折成三行
/bettertui summary on|off      轮次结束摘要
/bettertui fold on|off         阶段折叠
/bettertui reset               恢复默认
```

`group` 和 `tools` 的切换对**已渲染的旧工具行**不会追溯重画；需要重建整个 transcript 时执行 `/reload`。思考块、header 和后续新行会立即生效。
影响折叠的切换（`fold`、`on/off`、`tools`、`thinking` 在 0 与非 0 之间）会按新配置重建折叠并让已渲染的工具行重画；运行中切换时，这一步等本轮结束再做。

## 交互

- `Ctrl+O`：展开/折叠所有工具（组和已收起的阶段会一并展开成列表；运行中的阶段本来就是列表）。
- 点击阶段摘要/组头/单条工具头：局部展开或折叠；阶段是列表时（运行中或展开后）点击条目展开它的详情。
- 点击已折成三行的 `!` / `!!` 方框：展开输出；再点收起。`Ctrl+O` 会清掉各块的点击结果。
- `Ctrl+T`：展开/折叠思考块（复用 Pi 的 thinking toggle）；阶段列表里的思考条目同时显示全文。
- 鼠标点击只在 fullscreen 模式可靠；regular 模式请用键盘。

## 限制

- **只折叠不改东西的调用**：`read/grep/find/ls` 与判定为只读的 `bash/powershell`。`edit/write` 永远独立成行；命令是否「会改东西」靠启发式判定（见 §2），漏判的命令会进摘要，但展开列表里每条命令仍可见。
- **隐藏思考标签为空**：如果把 Pi 的 hidden thinking label 设成空串又按了 `Ctrl+T`，Pi 不再给思考块生成区域；以这样一个思考块开头的阶段画不出摘要。
- **展开详情有上限**：组内每成员 8 行、单条工具 14 行，超出显示 `… N more lines`。完整原始输出仍在 session/HTML export 里。
- **regular 模式**：Pi 的终端滚动区归终端所有，插件只做追加式紧凑行，不保证历史行可以重排；推荐 fullscreen。
- **不替代 Pi 的 `Ctrl+T` 语义**：它仍然切换 Pi 的 thinking 可见性；插件把它映射成“展开/折叠详情”。Pi 自己的 toast 仍可能显示 `Thinking blocks: hidden`，以插件视图为准。
- 没有改 footer、model、cost、context 的统计；这些继续由 `pi-hud` 负责。
- **左栏只覆盖插件管到的组件**：`thinking 0`（原生思考块）和插件没接管的 pi 原生消息（压缩摘要等）仍按 `outputPad` 画在第 1 列。

## 开发

```bash
cd pi-bettertui
npm install
npm run check     # typecheck + vitest
```

主要文件：

- `src/timeline.ts` — 纯分组状态机与折叠阶段（live + resume seed，共用 `ingestAssistant`）
- `src/segment.ts` — 折叠的纯函数：`classifyBlock`、`isMutatingShell`、摘要文案
- `src/fold-view.ts` — 阶段宿主的绘制：运行中的列表与 live、收起后的摘要
- `src/tool-lines.ts` — 工具子项、详情、运行中命令块（含 1 秒门槛）的行构造
- `src/tool-row.ts` — 工具行/组头/展开详情
- `src/thinking.ts` — 3 行窗口 + 真实 `AssistantMessageComponent` patch（折叠时的 `ThinkingSlot` / `GapSlot`）
- `src/skill.ts` — `/skill:name` 消息的紧凑行 patch
- `src/gutter.ts` — 左栏：assistant 正文的浅色 `●`、用户消息的 `❯`
- `src/user-images.ts` — 用户消息里的图片：把引用行和 pi 的图片说明移出色块，每张图挂一行 `├ / └`
- `src/shell-description.ts` — 给 `bash`/`powershell` 加 `description` 参数的工具覆盖
- `src/index.ts` — Pi 事件接线、命令、轮次摘要
- `src/config.ts` — 配置读写

## 致谢

设计参考了（折叠的完整设计见 `fold-more.md`）：

- `pi-open-tui` 的 compact tool row / thinking peek
- `pi-pretty-tui` 的 activity timeline / progressive disclosure
- Codex 的 `Explored` / `Ran` 树形活动组
- Claude Code 的“只折叠只读探索”边界
- MiniMax Code 的 3 行 thinking preview → `Thought for Xs`

## License

MIT

---

本插件属于 Shizuku 系列 pi 插件（[pi-shizuku](https://github.com/AoShizuku/pi-shizuku)）：共用的左栏、设计语言与跨插件约定见总仓库。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
