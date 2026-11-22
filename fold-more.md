# pi-bettertui 激进折叠（fold-more）设计方案

> 状态：**已实现**（第四版设计 + 第四版补订 + 实现版，实现中的取舍与差异见 §10）。本文记录用户原始想法、pi 侧调研结论与设计。
> 代码事实基于`pi` v1.5.2（`b4afdddf44`），引用写成 `pi/packages/...:行号`。
> 左栏约定（标识在第 0 列、内容从第 2 列）见 pi-shizuku 的 `README.md` 与 `DESIGN.md`，本文的所有示意图按它画。

---

## 0. 结论速览

1. **折叠单元是「阶段」（segment）**，不是单条工具、也不是单条 thinking。阶段 = 一串连续的 thinking 块与非变更类工具调用，**跨 assistant 消息合并**（§5.1）。
2. **阶段边界是硬的，按 block 切，不按消息切**：可见文本、`edit/write`、变更类 shell 命令、未托管工具、`error/aborted`、user 消息都会切断阶段。归属只追加、不回改。
3. **折叠阈值是「条目数 ≥ 2」**，不是「有没有 thinking」。单独一个 `Read (src/a.ts) · 40 lines` 照常显示。
4. **运行中展开、整轮结束收起**（第四版，§4.10）：本轮 agent 还在工作时，阶段画成紧凑列表，条目只追加、不缩回；轮次结束（`agent_settled`，与 `✻ Worked for` 同一时刻）把这一轮的所有阶段一次性收起成一行摘要。中途遇到正文、edit 等边界只关闭阶段，不收起。
5. **列表一个条目一行，中间无空行**；子项一律不带标识，连线第 2 列、内容第 4 列，最后一条 `└`、其余 `├`；已结束的 thinking 子项是一行浅色的 `Thought for 2.8s`，全文在条目的二级展开里。运行中的列表与收起后再展开的列表是同一版式。
6. **摘要行只有一行，不带标识、浅色（dim），落在第 2 列**，收起时一切都已结束，所以是过去时：`Thought for 12.4s · Ran 3 commands · Read 5 files ▸`。只有失败时第 0 列才出现 `!` / `×`。点击摘要或 `Ctrl+O` 展开回列表。
7. **「Thought for x」= 累计思考时间**：按消息去重，累加「含 thinking 块」的 assistant 消息的 `durationMs`；不含工具执行耗时。
8. **宿主 = 阶段的第一个锚点，设定后不变；宿主画全部，其余锚点恒为 0 行**。列表、live 内容、摘要都由宿主从模型推导出来（第三版改动，理由见 §2.3 推论 7）。
9. **live 内容挂在列表最后一条下面**：正在流的 thinking 是最后一条，露 3 行尾巴；正在跑的命令是它自己那一行，**跑满 1 秒**才在下面展开固定高度预览块。流完/跑完收回成该条一行。
10. **运行中的命令块固定高度**：1 行头 + 2 行脚本（仅当有 `description`）+ 3 行输出尾部，不足补空行。不满 1 秒结束的命令只占一行。多个并行命令只有最新一条给完整块，其余各 1 行。
11. **变更类 shell 命令是边界**：`isMutatingShell(command)` 保守判定，命中就像 `edit` 一样切断阶段并单独显示。`edit/write` 永远不进列表。
12. **resume 必须重建出同一套折叠**：锚点键用 `message.timestamp` 与 `toolCallId`，流式与 seed 走同一个 `ingestAssistant` 与 `classifyBlock`；seed 时历史里的轮次都已结束，全部是收起态。
13. **`thinking.lines = 0` 时 thinking 不参与折叠**，当作文本边界；fold 只折工具。

---

## 1. 用户的原始想法

逐条记录，作为本文的设计输入。

> 你来研究一下，betterTUI 如果更加激进的折叠，怎么搞？国产 thinking 模型，普遍：`thinking bash thinking bash thinking bash read` 这种。先普遍的读一些，然后上手——
>
> 我们折叠侦察情况，折叠成 `Thinking for x seconds, Execute y commands, Read z files`，然后展开是类似 subagent 的紧凑展示（中间无空行），遇到 edit/wight 才显示。
>
> 对于当前执行的 command，不仅显示一行 bash，还显示三行命令预览，完成就折叠上去。Thinking 也是，三行显示，思考完成就折叠上去。

已确认的决策（2026-11-11）：

| 决策点 | 结论 |
|---|---|
| 摘要里的「Thinking for x」 | **累计思考时间**——只算模型生成 thinking 的时间，不含命令执行 |
| 运行中命令的「三行预览」 | **两者都要**：输出 3 行 + 脚本正文 2 行 |
| 折叠阶段的边界 | **有可见文本就断开**：`thinking read bash` →「我要继续看看」→ `thinking bash bash` 渲染成「1 行折叠 + 1 行正文 + 1 行折叠」 |
| 跨 assistant 消息合并 | **保留**。agent loop 每调一次模型产出一条消息，按消息折等于没折 |
| 切分粒度 | **block 级**。流式时无法预知后面是否出文本，block 级切分只追加、不回改 |

---

## 2. 问题定义

### 2.1 输出形态

国产 thinking 模型的典型一轮是 thinking 与工具调用**交替**出现：

```text
thinking → bash → thinking → bash → thinking → read → read → bash → ...
```

每个 thinking 块在流式期间占 4 行（头 + 3 行尾巴）、结束后占 1 行；每个工具占 1 行（bash 运行中另带输出预览）；**每个可见块上方还有 pi 插的 1 行空行**（§2.3）。一段 6 步的侦察在屏幕上留下 12～20 行，其中真正需要人盯的只有 1～2 行。

### 2.2 现有 pi-bettertui 已经做到哪

| 能力 | 现状 |
|---|---|
| thinking 固定 3 行窗口 → 结束折成 `Thought for 18.3s` | ✅ 已实现（`src/thinking.ts`） |
| 运行中命令显示输出预览（默认 2 行，实现版改为 3 行） | ✅ 已实现（`src/tool-row.ts`，`shellPreviewLines`） |
| 连续只读工具合并成 `Explored 2 files, 1 search` | ✅ 已实现（`src/timeline.ts`） |
| 组头在下面露出运行中的成员 | ✅ 已实现（`renderGroup` 露出最后 2 个活跃成员）——这正是 §5.6「宿主画 live」的原型 |
| 左栏：标识第 0 列、内容第 2 列 | ✅ 已实现（`src/gutter.ts`，见 `DESIGN.md`） |
| **thinking 与工具合并成一行阶段摘要** | ❌ 设计时没有——一段侦察仍是 N 行（实现版已做，见 §10） |
| **bash 参与合并** | ❌ 设计时没有——bash 永远独立成行，且会打断只读组（实现版已做，见 §10） |

### 2.3 pi 的布局约束（代码事实）

| 事实 | 位置 |
|---|---|
| assistant 消息组件在 `message_start` 时入列；它的工具组件在 `message_update` 时**追加在后面** | `pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3643`、`:3654-3671` |
| `message_update` 中**先**调用 assistant 组件的 `updateContent`，**再**创建新的工具组件 | `interactive-mode.ts:3644`、`:3654-3671` |
| assistant 组件只渲染 `text` 与 `thinking` 两种块，`toolCall` 块被跳过；相邻 thinking 块合并成一个 run | `pi/packages/coding-agent/src/modes/interactive/components/assistant-message.ts:147-232` |
| assistant 组件的 `Spacer(1)` 是惰性加的：只在下一个可见块之前补；**它本身是一个子组件，子组件「看起来全空」时它仍然渲染 1 行** | `assistant-message.ts:133-143` |
| thinking run 被 `hideThinkingBlock` 隐藏且 `hiddenThinkingLabel` 为空时，pi **不生成**该 run 的区域，但 `runIndex` 照常递增（默认标签是 `Thinking...`，只有用户把标签设成空才会触发） | `assistant-message.ts:187-192` |
| `Container.render` 每帧都把子组件重新渲染一遍，不缓存行 | `pi/packages/tui/src/tui.ts:411-423` |
| 工具行的 call 与 result 共用一个组件，result 到达时原地重绘 | `pi/packages/coding-agent/src/modes/interactive/components/tool-execution.ts:196-209`、`:280-343` |
| `renderShell:"self"` 下，渲染结果为空时整行返回 `[]`；**不为空时 pi 在内容上方无条件插 1 行空行** | `tool-execution.ts:242-252` |
| `renderShell:"self"` 的点击坐标减去这 1 行空行后再交给插件（插件看到的 `y = 0` 是内容首行） | `tool-execution.ts:270-273` |
| `message.content` 按 provider 输出顺序 push，thinking 可以排在 toolCall 之后 | `pi/packages/ai/src/api/anthropic-messages.ts:987-1009`（其它 provider 同构） |
| 一条 assistant 消息的 `message_end` 严格早于它的工具执行开始 | `pi/packages/agent/src/agent-loop.ts:251`、`:279` |
| `AssistantMessage` 没有 id 字段，只有 `timestamp` 与可选 `durationMs` | `pi/packages/ai/src/types.ts:593-624` |

**推论：**

1. **屏幕上的顺序不是交错的。** 一条 assistant 消息的所有 thinking 挤在同一个组件里，它的所有工具行排在下面。真实交错顺序只存在于 `message.content` 数组里。
2. **摘要行只能落在已有组件的位置。** 扩展 API 不暴露 transcript 容器，无法重排组件。
3. **展开后的紧凑列表必须自己画**，按 `message.content` 顺序，不复用 pi 原生行。
4. **折叠是可以做到的**，因为工具行可以渲染 0 行；assistant 组件要额外处理 `Spacer`（§5.6 的 `GapSlot`）。
5. **渲染时判定是可行的。** `Container.render` 不缓存，组件在 `render()` 里从模型推导输出，模型变了 `requestRender()` 即可。
6. **归属登记来得及。** patch 的 `updateContent` 先于工具组件创建执行，在其中登记「toolCallId → 阶段」一定赶在 `renderCall` 之前。
7. **live 内容只能由宿主画。** 任何非宿主组件只要输出 1 行，pi 就会在它上方插 1 行空行（工具行）或补 1 个 `Spacer`（assistant 组件）。由条目自己画 live，屏幕上会是「摘要 / 空行 / 第 0 列带标识的一行」，读起来是两件事，连线也断开。宿主画全部、非宿主恒为 0 行，空行问题就不存在。

---

## 3. 评价：思路成立的部分

1. **收益点找准了。** 现有插件是「逐项折叠」，这里要的是「阶段折叠」：一段 6 步侦察从十几行降到 1 行。
2. **「edit/write 才显示」的边界正确**，与插件「只合并只读探索」的哲学一致——变更永远不该被藏起来。
3. **「完成就折叠上去」是完整的交互契约**：运行中要看得见进展，完成后要让位。
4. **展开用 subagent 的紧凑风格是对的**：一行头 + 缩进子项 + `├`/`└` 连接线，中间无空行。

---

## 4. 评价：需要修正或补齐的部分

### 4.1 「屏幕上是 thinking bash thinking 交替」——事实上不是

见 §2.3 推论 1。折叠模型的输入是 `message.content` 的块序列，输出是屏幕上的折叠摘要；不要试图还原「交错的样子」。

### 4.2 折叠之后必须有「破壳」，否则是退步

全部折成 1 行之后，`npm run build` 跑 30 秒期间屏幕完全静止，比现在的噪音更糟。所以折叠有两种形态：**静态态**（1 行摘要）与 **live 态**（摘要 + 正在发生的条目）。live 态是必须的。

第三版的 live 态是「摘要 + 正在发生的条目，完成即收回」；实测会闪，第四版改成「运行中整段是列表，整轮结束才收起」，见 §4.10。

### 4.3 「Thinking for x seconds」的 x 要定义清楚

取**累计思考时间**：

- 只累加**含 thinking 块**的消息的 `durationMs`，按消息去重；
- 纯 toolCall 的 assistant 消息不计；工具执行耗时不计；
- 流式期间用「现在 − `message.timestamp`」临时顶替，消息结束后换成真实值；旧会话没有 `durationMs` 时省略时长。

**已知偏差（接受）：** `durationMs` 是整条消息的生成时间，包含同一消息里 toolCall 参数的生成。pi 不提供 thinking 单独的时长，自己测量又无法在 resume 时重建。

### 4.4 阶段边界比「按消息分」更粗，切分粒度却要更细

阶段必须跨消息，否则对 `thinking bash thinking bash` 没有减法；切分点按 block 定，文本之前的块留在当前段，文本之后另起一段，归属只追加、不回改。

### 4.5 折叠摘要不能吃掉「哪个文件被改了」

`edit/write` 是硬边界；block 级切分保证变更行永远不被折叠段吞掉，即使它出现在一条消息的中间。

### 4.6 resume 之后必须长得一样

seed 时没有组件，模型的键只能用持久化数据里也有的 `message.timestamp` 与 `toolCallId`。

### 4.7 bash 被折叠，与「不藏变更」的原则冲突

需要保守的 `isMutatingShell(command)`，命中就作为边界单独显示（§5.2）。判错代价不对称：多判一条只是多显示一行，所以从宽。

### 4.8 「没 thinking 就不折」会漏掉一大类场景

用「条目数 ≥ 2 才折」保护「单独一个 Read 不要变成 Read 1 file」，不依赖 thinking（§5.3）。

### 4.9 大改之后：标识太多，● 的含义过载（第三版新增）

左栏落地后，正文、工具行、组头都用 `●`，thinking 用 `◇`，几乎每一行第 0 列都有符号，再加上 pi 在每个块上方插的空行，屏幕成了「符号—空行—符号」的等距栅格，失去了折叠本应带来的层次感。fold 对此的处理：

- **摘要行不带标识、整行浅色**：折叠段是「过程」，不是「事件」，不占第 0 列；正文的 `●` 与变更行的 `●` 因此重新成为屏幕上的锚点；
- 子项、live 内容一律不带标识，只用 `├ └` 连线与颜色区分；
- 独立 thinking 行同样去掉 `◇`，改成第 2 列的浅色 `Thought for 2.8s`（全局决策，见 `DESIGN.md` §2）。

折叠之后，一段「thinking + 侦察 + 正文 + edit」的第 0 列只剩正文和 edit 两个 `●`。

### 4.10 live 撑开再收回会闪（第四版新增）

**问题。** 第三版的 live 态是「摘要常驻，正在发生的条目挂在摘要下面，完成即收回、摘要计数 +1」。用户实测：

- 命令一开始，摘要下面撑开 4～6 行预览块（头 + 2 行脚本 + 3 行输出），跑完立刻缩回摘要；
- 快的 bash 几百毫秒就结束，预览一闪而过，用户看不清执行了什么，留下的痕迹只有计数 +1；
- 一串快命令时屏幕一伸一缩，下面的正文和输入框跟着上下跳。

根因在于把「已经发生的条目」藏进计数，只露「正在发生的条目」：每个条目的一生都是一次「撑开 → 收回」，一段 N 个条目的阶段在运行中要改变 2N 次高度。另一款 CLI 的做法是：两段正文之间的动作逐条列出，每条一行，中间无空行，只追加、不缩回。

**方案。**

1. **运行中展开**：阶段在本轮结束之前不画摘要，直接画列表。条目完成后留在列表里成一行；新条目追加在下面，原来的最后一条从 `└` 变成 `├`。高度只增不减，唯一的回缩是 live 部分（thinking 尾巴、命令预览块）收回成该条的一行。
2. **预览块加 1 秒门槛**：命令跑满 1 秒才展开预览块。快命令一生只占一行，不再一闪。
3. **整轮结束时收起**：本轮所有阶段一次性收起成摘要。

**取舍：什么时候收起。**

| 方案 | 好处 | 代价 |
|---|---|---|
| 每段结束（遇到正文 / edit 边界）就收起 | 屏幕最紧凑 | 收起发生在 agent 还在工作时：正文刚出来，上面的列表就缩成一行，正文跟着上跳，读到一半的位置丢了；仍是「撑开再收回」，只是粒度从条目变成阶段 |
| 整轮结束（`agent_settled`）收起 | agent 工作期间用户始终能看全过程；只在用户停下来读回复时收一次；和 `✻ Worked for` 同时出现，「这一轮结束了」本来就是视线回到顶部重读的时刻 | 很长的一轮在进行中会占很多行 |

选整轮结束收起。长的一轮占行多是可以接受的：那正是用户想盯着看的时候，结束后一次收回。

**其它决定。**

- 用户在运行中展开过条目详情的阶段，轮次结束时照样收起，详情一并关闭——规则简单一致，不需要记「谁手动动过」。
- 折叠阈值不变：条目数为 1 的阶段仍逐项渲染。单条本来就是一行，列表第一条也是一行，阈值从 1 跨到 2 时高度连续。
- 只学「紧凑列表、无空行」的排版。不加彩色小圆点、不改动词写法，保留 `├ └` 与 `Bash (…)` 写法；edit/write 仍是边界，单独成行带 `●`。

---

## 5. 设计

### 5.1 阶段（segment）模型

阶段 = **一串连续的条目**，条目有两种：thinking run 与工具调用，按 `message.content` 的真实顺序排列，直到遇到硬边界。

- **跨 assistant 消息合并**：只有 §5.2 的边界才结束阶段。
- **按 block 切**：`thinking → text → thinking → toolCall`，文本之前的 thinking 留在当前段，文本之后开启新段。
- **只追加、不回改**：每个 block 第一次被看到时分配锚点与阶段；`ingestAssistant` 必须幂等。

### 5.2 边界规则

边界判定抽成纯函数 `classifyBlock(block)`，流式与 seed 共用：

| block / 事件 | 分类 | 效果 |
|---|---|---|
| `thinking`（`thinking.lines > 0`） | fold | 加入当前段 |
| `thinking`（`thinking.lines = 0`） | 文本边界 | 关闭当前段，pi 原生思考块照常显示 |
| 托管的只读工具 `read/grep/find/ls` | fold | 加入当前段 |
| `bash/powershell` 且 `!isMutatingShell(command)` | fold | 加入当前段 |
| 非空 `text` | 文本边界 | 关闭当前段，文本正常显示 |
| `edit/write`、`isMutatingShell` 命中的命令 | 变更边界 | 关闭当前段，该行单独显示 |
| 未托管工具、MCP、读 `SKILL.md` | 不透明边界 | 关闭当前段，按现有逻辑显示 |
| 消息 `stopReason` 为 `error/aborted` | 错误边界 | 关闭当前段 |
| user 消息、非 message 类 session entry、compaction、`agent_settled` | 关闭 | 关闭当前段 |

**`isMutatingShell(command)`**：保守的纯函数，命中下列任一即视为变更。

- `git commit/push/reset/checkout/merge/rebase/stash/apply`
- `rm`、`mv`、`cp`、`mkdir`、`touch`、`chmod`
- `sed -i`、`perl -i`
- 重定向到真实文件（`>`、`>>`、`tee`，`/dev/null` 与 `2>&1` 除外）
- 包管理安装/卸载：`npm/pnpm/yarn/pip/cargo install|add|remove`

命令参数是流式到达的：参数流完前先按 fold 处理，判定为变更后从段里移出、关闭当前段（与现有 `detachSkillRead` 同一套路）。流式中的 toolCall 一定是段的最后一个条目，所以移出不会打乱其它条目。移出后段若只剩 1 条，回到逐项渲染——这是唯一一处「回改」，只发生在条目尚未完成时。

### 5.3 折叠阈值

阶段**条目数 ≥ 2** 时才折叠；条目数为 1 时，该条目按现有逐项渲染（thinking 用 `ThinkingView`，工具用 `ToolRowView`）。阈值做成配置项（默认 2）。

### 5.4 摘要行（整轮结束后）

```text
  Thought for 12.4s · Ran 3 commands · Read 5 files · 1 search ▸
! Thought for 8.1s · Ran 4 commands · Read 2 files · 1 failed ▸
  └ Bash (npm test) · Failed (exit 1) · 40 lines
```

- **只在收起后出现**：运行中阶段是列表（§5.5），没有摘要行；轮次结束时整轮的阶段一起换成摘要（§4.10）。
- **无标识、浅色**：正常情况下第 0 列留空，整行 `dim`，文字从第 2 列开始。
- **时态**：收起时一切都已结束，所以是过去时。时态按类别（哪一类还有条目在进行就用进行时）的规则保留，只在中断的会话里有条目永远没等到结果时才会露出进行时。
- **分隔符** `·`，与仓库现有紧凑行一致。
- **段落的取舍**：思考时长只在有时长时出现；命令段只在有 bash/powershell 时出现；`Read N file(s)` 按去重后的文件数计（沿用 `targetKey`）；`N search(es)`、`N dir(s)` 复用 `groupCounts`。
- **失败才有标识**：`!` warning（部分失败）/ `×` error（全部失败）落在第 0 列，`· N failed` 用 error 色——异常是唯一需要从浅色里跳出来的东西。运行中失败条目本来就在列表里，用 error 色。
- **收起后露出全部失败条目**，每条 1 行，最多 3 条（取最新的）；更早的折成一行浅色 `├ … N more failed`，点它展开整个列表。不照搬只读组「只露最后一条」：只读组的最后一条代表进度、取代了前面的，失败则各自独立，露出的行数要和 `N failed` 对得上。
- **点露出的失败行**：原地展开 / 收起该条详情（命令 + 输出），列表保持收起——点它的意图是「看一眼这个错」，不是展开整轮。点摘要行才开合列表。

```text
! Thought for 2.3s · Ran 3 commands · 2 failed ▸
  ├ Bash (npm test) · failed
  └ Bash (npm run lint) · failed
     $ npm run lint
     error  'x' is defined but never used
```
- **展开指示**：`▸` / `▾`，dim。
- **fold 关闭时的只读组组头**（`Explored 2 files, 1 search`）同样改成无标识浅色，两种模式下「过程行」长得一样。

### 5.5 列表（运行中，以及收起后再展开）

列位按 `DESIGN.md` §2：标识第 0 列，连线第 2 列，子项内容第 4 列，详情第 5 列（`  │  ` 之后）。

运行中，宿主直接画列表，上面没有摘要行：

```text
● 我先看参数解析。

  ├ Thought for 2.8s
  ├ Bash (rg -n parseArgs src) · Done · 3 lines
  ├ Read (src/index.ts:1-80) · 40 lines
  └ Thought for 1.5s
```

收起后点击摘要或 `Ctrl+O`，摘要变成 `▾`，下面是同一版式的列表：

```text
  Thought for 12.4s · Ran 2 commands · Read 1 file ▾
  ├ Thought for 2.8s
  ├ Bash (npm run build) · Done · 12 lines
  ├ Read (src/index.ts:1-80) · 40 lines
  ├ Thought
  └ Bash (npm test) · Failed (exit 1) · 40 lines
```

- **只追加**：新条目追加在最后，原来的最后一条从 `└` 变成 `├`；条目完成后留在列表里成一行，不消失。
- **子项不带标识**。已结束的 thinking 子项是一行 `Thought for 2.8s`，整行浅色（dim），与独立思考块的头行同一个文案函数：没有时长时写 `Thought`；一分钟内保留一位小数；工具子项复用现有的一行摘要（`childLine` / `summarizeResult`）。
- **thinking 子项显示时长而不是首行**（第四版补订）：首行是长句，铺满整行、与工具行交替，整屏没有呼吸感，读起来像一面文字墙；短的浅色 `Thought for 2.8s` 让工具行重新成为列表里可扫读的主体。思考内容不丢：点击条目（二级展开）或 `Ctrl+T` 显示全文。
- **每个 run 的时长**：运行中每个 thinking run 自己测——从它第一次被看到（消息的第一个块是它时，从消息的 `timestamp` 起，与 `durationMs` 同一起点）到它停止增长（同一消息的下一个 block 第一次出现，或消息结束）。没测到时（seed / resume、配置切换后重 seed、消息结束才第一次看到）退回消息的 `durationMs`，但只在该消息只有一个 thinking run 时用；一条消息有多个 run 时无法拆分，写不带时长的 `Thought`。所以运行中与 resume 的数字可能略有出入，条目与切段不受影响。
- 顺序严格按 `message.content` 的真实输出顺序。
- **edit/write 不进列表**：它们是边界，单独成行带 `●`，前后的列表是两个阶段。
- **条目二级展开**：点击某个条目展开它的详情（thinking 全文 Markdown、工具输出），详情落在第 5 列，条目自己那一行不变。运行中的列表和收起后再展开的列表都可以。默认只展开到条目一行，控制长阶段的高度。

### 5.6 宿主：第一个锚点，画全部

**锚点**是条目在屏幕上的落点：

- thinking run → 所在 assistant 组件里的那个 thinking 区域，键 `msg:<timestamp>#<runIndex>`；
- 工具调用 → 它的工具行，键 `toolCallId`。

**宿主 = 阶段的第一个锚点，设定后不变。** 屏幕顺序与阶段顺序一致，第一个锚点就是视觉上的第一行。

**每个槽位只有三种输出：**

```text
段未达折叠阈值？ → 原样渲染（逐项）
我是宿主？       → 未收起：列表（§5.5）+ live 内容（§5.7）
                   已收起：摘要行（§5.4）；展开时摘要行 + 列表
其它             → []
```

- 「其它 → `[]`」不随时间变化，工具侧可以像现有只读组一样在 `renderCall` 时直接返回 `EMPTY_COMPONENT`；阈值从 1 跨到 2 时，pi 会因为参数/结果更新重新调用 `renderCall`，同时宿主的 `render()` 每帧从模型推导，两边自然切换。
- 宿主需要的数据都在 timeline 里：命令的 `partialText`、`startedAt`、结果；thinking 的文本由 `ingestAssistant` 每次刷新到 `SegItem.text`。宿主不读别的组件。
- 宿主可以是工具行：例如段从一条消息里 `edit` 之后的 `read` 开始。现有只读组本来就由 `members[0]` 画组头和活跃成员，这里是同一机制的推广。

**assistant 组件侧**：patch 后的 `updateContent` 先跑 pi 原版，再按下列顺序处理：

1. 调 `ingestAssistant(message, streaming)` 登记锚点、刷新 thinking 文本；
2. 把每个 thinking 区域换成 `ThinkingSlot(anchor)`；区域到 run 的对应按 pi 的规则重算 `runIndex`（含「隐藏且标签为空则无区域」这一条，§2.3），不再用 `runs[Math.min(index, …)]` 兜底；
3. 把 `Spacer` 换成 `GapSlot`：仅当其后同组件内还有可见输出时才渲染 1 行空行，避免全空的组件留下孤立空行；
4. **最后**才跑 `applyAssistantGutter`。`ThinkingSlot` / `GapSlot` 不能带数值型 `paddingX` 字段，否则会被 gutter 当成 Text 改边距。

### 5.7 live 内容

live 内容挂在列表里它所属的那一条下面；正在发生的条目几乎总是最后一条。

正在跑的命令（已跑满 1 秒）：

```text
  ├ Thought for 2.8s
  ├ Read (src/index.ts:1-80) · 40 lines
  └ Bash (构建所有包) · Running… 12s
     $ npm run build --if-present
       cd packages/core && yarn build
     compiling src/…
     Building…
     ✓ built in 3.2s
```

正在流的 thinking：

```text
  ├ Bash (npm run build) · Done · 12 lines
  ├ Read (src/args.ts) · 40 lines
  └ … 先确认 parseArgs 的入口
    flag 应该集中校验，不要在每处判断
    最后更新 README 和 help
```

- **正在跑的命令**：它自己那一行 `Bash (…) · Running… 4s`；跑满 1 秒后，下面展开 §5.8 的固定高度预览块。不满 1 秒结束的命令始终只有一行。跑完后预览收回，只剩该条一行。
- **正在流的 thinking**：列表最后一条，3 行尾巴从第 4 列起，思考色斜体，按屏幕行折行后取最后 3 行（DESIGN.md §2.1）。第 2 列被连线占着，`… ` 没处挂，出现后占正文前两列，其余行同步右移两列对齐；折行宽度始终留出这两列，所以它出现时不会重新折行。不另画「Thinking…」头（尾巴上方没有头行，所以也不加 `Thinking… 3s`）。流完收成一行浅色 `Thought for 2.8s`（§5.5），时长就是它流的这段时间；通常同一快照里下一个工具条目就追加上来，它从 `└` 变成 `├`。
- **并行**：多个命令同时在跑时，最新一条给完整预览块，其余各 1 行（`├ Bash (…) · Running… 3s`）。
- 所有 live 内容都在宿主组件内部，与列表之间没有空行，连线连续。

### 5.8 命令预览细节

运行中命令块**固定高度**：

| 行 | 内容 | 列 |
|---|---|---|
| 1 | 工具头：`Bash (描述或截断命令) · Running… 12s` | 单独时标识第 0 列；作为子项时 `├`/`└` 第 2 列、名字第 4 列 |
| 2–3 | 脚本正文前 2 行，`$ ` 首行 + 缩进续行（复用 `renderCommand` 的画法）；**仅当模型填了 `description`** 时显示 | 第 5 列 |
| 4–6 | 输出尾部 3 行 | 第 5 列 |

- **1 秒门槛**（第四版）：第 2～6 行只在命令开始执行满 1 秒后才出现（常量 `RUNNING_BLOCK_DELAY_MS = 1000`）。计时从执行开始算，不从参数开始流式算。快命令一生只占第 1 行。
- 不足的行补空行，固定高度，不随输出抖动。没有脚本行时块高 4 行，同样固定。
- 单独一行时（未折叠的单条命令）用同一套行与同一个 1 秒门槛，详情列也是第 5 列，与现有 `shellPreviewLines` 预览统一；`shellPreviewLines` 默认从 2 改为 3。

### 5.9 数据结构

不另起状态机，扩展现有 `ActivityTimeline`：fold 关闭时沿用现有 rows/groups；fold 开启时由 segments 取代只读组。

```ts
type SegItem =
  | {
      kind: "thinking"; anchor: string; msgTs: number; run: number; text: string; streaming: boolean;
      /** 运行中实测：第一次看到 / 停止增长的时刻；seed 时不填（第四版补订） */
      startedAt?: number; endedAt?: number;
      /** 没测到时的退路：消息里的 run 数与消息的 durationMs */
      messageRuns: number; messageDurationMs?: number;
    }
  | { kind: "tool"; toolCallId: string };

interface Segment {
  id: string;
  /** 模型真实输出顺序 */
  items: SegItem[];
  /** 第一个锚点，设定后不变 */
  host: string;
  /** 遇到边界，不再追加；仍画成列表 */
  closed: boolean;
  /** 整轮结束时置位：画摘要行而不是列表（第四版） */
  collapsed: boolean;
  /** 收起后又被点开 */
  expanded: boolean;
  /** 二级展开的条目 */
  expandedItems: Set<string>;
  /** msgTs → durationMs，按消息去重后累加 */
  thinkingMs: Map<number, number>;
}

class ActivityTimeline {
  // 现有 rows / groups ...
  segments: Map<string, Segment>;
  /** "msg:<ts>#<run>" | toolCallId → 阶段 */
  anchorOf: Map<string, Segment>;
  /** Ctrl+O 的全局展开态，由 renderCall 从 context.expanded 记下，供 assistant 侧宿主读取 */
  globalExpanded: boolean;

  ingestAssistant(message: unknown, streaming: boolean): void; // 幂等，只给新 block 分配锚点，刷新 thinking 文本
  settle(): void; // 轮次结束：关闭当前段，把所有未收起的段收起
}
```

- 工具 → 阶段的归属在 `ingestAssistant` 里由 toolCall 块的 `id` 登记，早于 `renderCall`。
- 托管工具的行数据仍由现有 `ToolRow` 承载，Segment 只持有 `toolCallId`。

### 5.10 seed / resume

- seed 遍历 session entries 时，对 assistant 消息调用**同一个** `ingestAssistant(message, false)`，对 toolResult 调用现有 `end()`。
- 锚点键只用 `timestamp` 与 `toolCallId`，seed 时没有组件也能建好。
- 现有 `scheduleSeed` 的延迟重 seed 照用：槽位在渲染时读模型，seed 晚到时下一帧自动更正。
- **收起态（第四版）**：seed 结束时调用与 `agent_settled` 相同的 `settle()`，所有阶段都是收起态。seed 只在没有轮次进行时发生（启动、切换分支、本轮结束后的配置切换），这时历史里的轮次都已结束，与流式在 `agent_settled` 之后的状态一致。最后一轮如果是被中断的（进程退出，没等到 `agent_settled`），同样收起。

### 5.11 交互

| 操作 | 效果 |
|---|---|
| 点击运行中列表的条目 | 展开 / 折叠该条目的详情；宿主按自己画出的行号映射到条目 |
| 点击收起后的摘要行 | 展开成列表（摘要变 `▾`）/ 再收起 |
| 点击展开后列表中的条目 | 展开 / 折叠该条目的详情 |
| 轮次结束 | 本轮所有阶段收起，包括用户展开过条目详情的阶段，详情一并关闭 |
| `Ctrl+O` | 收起的阶段全部展开成列表；运行中的列表不受影响。工具侧走 `context.expanded`；assistant 侧宿主读 `timeline.globalExpanded` |
| `Ctrl+T` | 保持现状：映射成「展开思考详情」；列表里的思考条目同时显示全文 |
| `/bettertui fold on\|off` | 切换后对所有 assistant 组件重放一遍 `updateContent`，并让工具行重新 `renderCall`（与 `/bettertui on\|off` 同一条刷新路径） |

### 5.12 空行

- pi 在每个可见工具行上方、每个 assistant 组件的首个可见块前、思考块之后的下一个可见块前都插 1 行空行（§2.3）。fold 不去改这条节奏：段与段、段与正文、段与 edit 行之间仍各隔 1 行。
- 思考块与后面的正文之间也是 pi 原有的 1 行空行。曾经试过把它去掉、让思考块贴住正文，实测效果不好，第四版撤掉。
- 段**内部**（列表、live、摘要）全部画在宿主一个组件里，没有空行。
- `GapSlot` 只负责「同组件内后面没东西就不出空行」：被并进上方阶段、画成 0 行的思考块不会留下孤立空行，整条消息都被并走时也不留。

---

## 6. 实现落点

| 文件 | 改动 |
|---|---|
| `src/segment.ts`（新增） | `classifyBlock`、`isMutatingShell`、摘要文案与计数（纯函数，可单测） |
| `src/timeline.ts` | `segments` / `anchorOf` / `ingestAssistant`；seed 接入 `ingestAssistant`；fold 开启时停用只读组 |
| `src/thinking.ts` | `updateContent` patch：`ingestAssistant` → `ThinkingSlot` / `GapSlot` → `applyAssistantGutter`；区域到 run 的映射按 pi 规则重算 |
| `src/tool-row.ts` | `ToolRowView` 增加宿主态（列表 + live / 摘要）；非宿主在 `renderCall` 返回空；固定高度命令块；记录 `globalExpanded` |
| `src/config.ts` | `fold.enabled`、`fold.minItems`（默认 2）；`shellPreviewLines` 默认 3 |
| `src/index.ts` | `/bettertui fold on\|off` 与刷新路径；关闭段的事件（`agent_settled`、compaction 等）接入 |
| `src/fold-view.ts`（实现版新增） | 宿主的绘制：列表、live、摘要、点击映射；工具宿主与思考宿主共用 |
| `src/tool-lines.ts`（实现版新增） | 从 `ToolRowView` 抽出的子项、详情、命令与固定高度命令块的行构造 |

---

## 7. 实现步骤（每步可单独上线）

1. **模型**：`classifyBlock` + `isMutatingShell` + Segment + `ingestAssistant` + seed。核心用例：把流式过程中每次 `updateContent` 的 `content` 快照依次喂入，最终切分与 seed 结果一致；文本边界、变更边界、跨消息合并、阈值、`lines = 0`。
2. **工具侧折叠**：宿主落在工具行时的摘要与非宿主空行。做完即可看到 `Ran 3 commands · Read 5 files`。
3. **assistant 侧**：`ThinkingSlot` / `GapSlot`，thinking 计入摘要，宿主可落在 thinking 区域；验证全空 assistant 组件不留空行。
4. **live 块**：宿主画 thinking 尾巴与固定高度命令块、并行规则、`isMutatingShell` 参数流完后的移出。
5. **收尾**：展开列表与条目二级展开、`Ctrl+O`、配置项与 `/bettertui fold`、README。

每步提交前跑 `npm run typecheck` 与 `npm test`；本插件动到 pi 核心交互，改动后额外跑一遍 typecheck。

---

## 8. 风险与未决问题

### 已定案

1. **跨 assistant 消息合并**：保留。
2. **一条消息里同时有变更和后续探索**：按 block 切。
3. **阶段之间的空行**：沿用 pi 的节奏，段内无空行（§5.12）。
4. **阶段大小**：不设条目上限，展开长度由条目二级展开控制。
5. **宿主切换**：取消，宿主固定为第一个锚点。
6. **live 由谁画**：宿主（第三版改定，§2.3 推论 7）。
7. **摘要行无标识、浅色**；只读组组头同样处理（§5.4）。
8. **独立 thinking 行去掉 `◇`**，改成第 2 列浅色（`DESIGN.md` §2）。
9. **运行中展开、整轮结束收起**（第四版，§4.10）：运行中宿主画列表，`agent_settled` 时整轮一次性收起；中途边界不收起；用户展开过的阶段照样收起。
10. **命令预览 1 秒门槛**（第四版，§5.8）：不满 1 秒结束的命令只占一行。
11. **撤掉「思考块贴住后面的正文」**（第四版）：思考块与正文之间恢复 pi 原有的空行（§5.12）。
12. **列表里已结束的思考条目画成浅色 `Thought for 2.8s`**（第四版补订，§5.5）：不再显示思考首行；时长运行中逐 run 实测，resume 时单 run 消息用 `durationMs`、多 run 消息写 `Thought`；全文在二级展开与 `Ctrl+T` 里。

### 待讨论

1. **块间空行是否收紧**（2026-11-11：暂不定，后续一定要做）。 pi 的「每块上方 1 行空行」是标识过密之外另一个让屏幕显得平铺的原因。曾先做过一个局部的「思考块贴住后面的正文」，实测效果不好，第四版已撤掉。收紧需要在 transcript 容器层面统一处理，超出 fold 的范围，单独讨论。

### 风险

1. **折叠模型与 timeline 模型不同步。** 缓解：Segment 放进 `ActivityTimeline`；边界判定只有 `classifyBlock` 一份；用「流式快照序列 = seed」的测试锁住。
2. **`isMutatingShell` 的误判。** 漏判会把变更藏进摘要。缓解：规则从宽；展开列表里每条命令仍可见。
3. **`durationMs` 偏高。** 已接受（§4.3）。
4. **宿主在视口之上时的重绘。** 宿主画列表与 live 意味着它的高度随运行状态变化；第四版之后运行中只增不减，整轮结束时一次性收起，长的一轮收起时宿主可能已在视口之上，暂不处理。
5. **pi 版本的兼容性。** 依赖的内部行为：空组件 → 整行不渲染、self 渲染上方固定 1 行空行、`Container.render` 不缓存、`updateContent` 先于工具组件创建、thinking 区域与 `runIndex` 的对应规则。`pi` 已钉死在 v1.5.2，bump 前必须复查这五条。

   > **v1.5.0 → v1.5.2 复查结果：五条全部成立。** 空组件与 self 空行在 `tool-execution.ts`（两版未改动）；`Container.render` 在 `tui/src/tui.ts` 两版逐字相同（该文件只改了光标标记处理）；`updateContent`（`interactive-mode.ts:3644`）仍早于工具组件创建循环（`:3654`）；thinking 与 `runIndex` 在 `assistant-message.ts`（两版未改动）。

---

## 9. 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-11 | 第一版 | 用户原始想法、pi 调研、初步设计 |
| 2026-11-11 | 第二版 | 评审修订：宿主改为「第一个锚点 + 渲染时判定」；按 block 切分；跨消息合并定案；锚点键改用 `timestamp`/`toolCallId`；折叠阈值改为条目数 ≥ 2；`isMutatingShell`；命令块固定高度；展开列表 thinking 显示首行；`Ctrl+O` 走 `globalExpanded`；实现拆成 5 步 |
| 2026-11-11 | 第三版 | 适配左栏约定：所有示意图按「标识 0 / 连线 2 / 子项 4 / 详情 5」重画，子项去掉标识；补 pi 事实「self 渲染上方固定 1 行空行」「隐藏且无标签的 thinking 不生成区域」；live 改由宿主绘制，非宿主恒为 0 行；摘要时态改为按类别；`thinking.lines = 0` 时 thinking 作文本边界；明确 patch 顺序（gutter 最后跑）与 fold 开关的刷新路径；新增 §4.9 与待讨论两项 |
| 2026-11-11 | 第三版补订 | 定案：摘要行与只读组组头去掉 `●`、整行浅色、第 2 列起，只有失败时第 0 列出现 `!`/`×`；独立 thinking 行去掉 `◇` |
| 2026-11-11 | 实现版 | 按 §7 五步落地；状态改为已实现；§2.3 逐条核对；新增 §10 记录实现中的取舍与和设计的差异（渲染时判定连非宿主工具行也覆盖、扩展事件先行登记、SKILL.md 读取同样走流式移出、阶段关闭事件的口径、计数口径、fold 关闭时命令预览保持旧画法等） |
| 2026-11-11 | 第四版 | 实测反馈「live 撑开再收回会闪」：改成运行中展开（宿主直接画只追加的列表，live 挂在最后一条下面）、整轮结束（`agent_settled` / seed 结束）一次性收起成摘要；命令预览加 1 秒门槛；撤掉「思考块贴住正文」（`DESIGN.md` 原 §2.2），恢复 pi 的空行；新增 §4.10，改写 §0、§5.4、§5.5、§5.7、§5.8、§5.10、§5.11、§5.12，§8、§10 同步 |
| 2026-11-11 | 第四版补订 | 实测反馈「运行中列表里思考首行铺满整行、与工具行交替，没有呼吸感」：已结束的思考条目改成一行浅色 `Thought for 2.8s`（与独立思考块共用文案函数），全文留在二级展开与 `Ctrl+T`；每个 thinking run 运行中自己测时长，resume 时单 run 消息用 `durationMs`、多 run 消息写 `Thought`；改写 §0 第 5 条、§5.5、§5.7、§5.9，§8、§10 同步 |
| 2026-11-12 | 第四版补订二 | 实测反馈「点露出的失败行却展开了整个列表」「2 failed 只露出 1 条」：收起后露出全部失败条目（最多 3 条，其余折成 `… N more failed`），点失败行原地展开该条详情、不开列表；改写 §5.4 |

---

## 10. 实现版说明

### 10.1 问题：设计稿没有落到的细节

第三版定了模型、宿主和版式，实现时还要回答几件设计稿没写死的事：非宿主工具行在阈值跨越或 seed 晚到时怎么跟上；扩展的补丁还没装到 pi 真实原型上时，归属由谁登记；流式期间「参数还没流完」的读取是否也要移出；哪些事件关闭阶段才能让 live 与 seed 一致；摘要计数的口径。

第四版又带来几件：「轮次结束」挂在哪个事件上、seed 怎么判定一轮已结束；1 秒门槛从哪一刻计时、门槛到点时谁触发重绘；`└` 变 `├` 由谁处理；运行中的列表与 `Ctrl+O`、`Ctrl+T` 怎么配合。

### 10.2 pi 事实核对（v1.5.2）

§2.3 各条逐一核对成立。补充三点：

- `message_update` 里 `updateContent` 实际在 `interactive-mode.ts:3644`，创建工具组件的循环从 `:3654` 开始（表中两处行号已按 v1.5.2 校准，先后顺序的结论不变）。
- **扩展先于界面收到事件**：`agent-session.ts:1207-1209` 先 `_emitExtensionEvent` 再通知界面监听者。所以扩展在 `message_start/update/end` 里登记归属，一定早于 pi 为同一条消息创建工具组件，即使 assistant 补丁还没装到 pi 的原型上。
- pi 运行期间的 working 状态指示器持续请求重绘，宿主里 `Running… 12s` 的秒数靠这些帧走动，插件不另起走秒计时器。1 秒门槛另有一次性的补帧，见 §10.3。

### 10.3 取舍

| 问题 | 选择 | 理由 |
|---|---|---|
| 非宿主工具行返回什么 | fold 开启时 `renderCall` 一律返回视图，视图在 `render()` 里按 `foldRole` 决定「逐项 / 宿主 / 空」 | 设计稿允许直接返回 `EMPTY_COMPONENT`，但那是静态的：seed 晚到或配置切换后，pi 不会再调 `renderCall`，空组件就永远空着。视图渲染成 `[]` 与空组件在 pi 里效果相同（整行不渲染、不插空行） |
| 归属在哪登记 | 补丁的 `updateContent` 与扩展的 `message_start/update/end` 都调 `ingestAssistant`；它幂等 | 只靠补丁时，本会话第一条消息可能在补丁装上之前就流完了 |
| 旧消息被重放 | 未见过、且时间戳早于已见最新消息的消息只刷新、不追加；seed 不受此限 | `Ctrl+T`、invalidate 会对所有 assistant 组件重放 `updateContent`；追加会把旧块排到新块后面。seed 按会话顺序遍历，不看时间戳先后 |
| 参数流式中的读取 | `read` 指向 `SKILL.md` 与 `isMutatingShell` 走同一套「先折叠、参数完整后移出」 | 原来只读组的 `detachSkillRead` 是同一问题，合成一条规则。参数是否完整按快照判定：不是最后一个块，或消息已结束 |
| 什么关闭阶段 | 文本、变更、不透明工具、`error/aborted`、user 消息、自定义消息、`agent_settled`、压缩；seed 里对应 `compaction` / `branch_summary` / `custom_message` 条目 | 其它扩展在运行中写入的状态条目（`custom`）、模型切换不关闭阶段：live 没有对应事件，关了就和 seed 不一致。未接管工具的 `tool_execution_start` 也不再关闭阶段，归属只看 `message.content` |
| 摘要计数 | 每类计数是阶段内该类的全部条目（含进行中的），时态看是否还有进行中的条目 | 第四版之后摘要只在收起后出现，正常都是过去时；规则保留给中断会话里永远没有结果的条目 |
| 没有时长的思考 | 旧会话没有 `durationMs` 时省略思考段；摘要只剩思考时写 `Thought` | 不用「现在 − 时间戳」伪造时长，与单独的思考块一致 |
| 搜索与目录的措辞 | 有读取时 `Read 5 files · 1 search · 2 dirs`；没有读取时 `Searched 2 patterns` / `Listed 2 dirs` | 时态需要一个动词承载 |
| fold 关闭时的命令预览 | 保持旧画法（头行下 `└` 露出输出尾部）；固定高度块只在 fold 开启时用 | fold 关闭须与旧版完全一致；`shellPreviewLines` 默认值改 3 对两种模式都生效 |
| 运行时长从何时算 | fold 开启时，`tool_execution_start` 经 `startExecution` 把行的开始时间重设为执行开始，并记下 `execStartedAt` | 行在参数流式时就已创建；并行命令并排显示时，等待时间不该算进 `Running…` |
| 轮次结束挂在哪（第四版） | `agent_settled`：先 `closeCurrent`，再 `timeline.settle()`——关闭当前段，把所有 `collapsed = false` 的段置为收起、清掉 `expanded` 与条目详情，逐个通知宿主重绘；同一个处理函数里随后追加 `✻ Worked for` | 与 `Worked for` 同一时刻；之前的轮次早已收起，「所有未收起的段」就是本轮的段，不需要另记轮次编号 |
| seed 怎么判定轮次（第四版） | seed 结束时调用同一个 `settle()`，全部收起 | seed 只在没有轮次进行时发生（`session_start`、`session_tree`、延迟重 seed 与配置切换都在 `runStartedAt` 为空时才跑），所以历史里每一轮都已结束。不按 user 消息或 `better-tui-turn` 条目切轮次：后者只在开了 `turnSummary` 的 TUI 模式才写入，靠不住。边界情况——被中断、没等到 `agent_settled` 的最后一轮——也收起 |
| 1 秒门槛的计时（第四版） | 从 `execStartedAt` 算；`renderCall` 在 `context.executionStarted` 时兜底补记。参数还在流式、未开始执行的命令只画一行 | 参数流式可能超过 1 秒，那段时间命令并没有在跑 |
| 1 秒门槛到点的重绘（第四版） | 渲染时按时钟判定；另外 fold 开启时每条 shell 命令在 `tool_execution_start` 排一个 1016ms 的一次性定时器，到点仍在跑就 `timeline.refresh(id)`（宿主失效）并 `requestRender()`；`agent_settled` 与关闭会话时清掉 | working 指示器的帧通常已经够用；补一帧让预览块不必等下一段输出才出现 |
| `└` → `├`（第四版） | 不存状态：宿主每帧按条目在列表里的位置决定连线，最后一条 `└`、其余 `├`，详情列相应用 `     ` / `  │  ` | 新条目登记时 `placeItem` 已经通知宿主重绘，下一帧自然换线 |
| 运行中列表与 `Ctrl+O`（第四版） | `Ctrl+O` 只影响已收起的段；运行中的列表本来就全展开 | 运行中没有摘要可展开 |
| `Ctrl+T` | 仍映射为「展开思考详情」；另外记到 timeline，列表里（运行中或展开后）的思考条目同时显示全文 | 折叠后思考块不再独立成行，原来的展开动作在阶段里没有落点；第四版的运行中列表同样响应，和独立思考块的行为一致 |
| 单条命令的 1 秒门槛（第四版） | 条目数为 1、逐项渲染的运行中命令也遵守 1 秒门槛 | 否则单独一条快命令仍会一闪；fold 关闭时的旧预览不变 |
| 运行中的失败（第四版） | 运行中没有摘要行，失败条目在列表里以 error 色的 `· failed` 出现，第 0 列不放标识；收起后摘要第 0 列出现 `!`/`×`，并露出全部失败条目（最多 3 条，§5.4） | 子项一律无标识；失败条目本来就在眼前 |
| 列表里思考条目的时长（第四版补订） | `ingestAssistant` 在流式快照里给每个 run 记 `startedAt`（首次看到；run 是消息第一个块时取消息 `timestamp`）与 `endedAt`（第一次不再是快照最后一个块，或收到 `streaming = false` 的整条消息）；seed 中不记。渲染时有实测用实测，否则消息只有一个 run 时用 `durationMs`，否则无时长。文案与独立思考块共用 `thoughtLabel`（一分钟内保留一位小数，如 `Thought for 1.5s`，一分钟以上沿用 `formatDuration`；没有时长写 `Thought`。摘要行的累计时长同样用它，与条目同一写法） | 实测只能在运行中拿到，resume 只有整条消息的 `durationMs`；单 run 消息两者口径相近（同一起点），多 run 消息宁可不写也不平均分摊。重 seed（配置切换）会丢掉实测、退回 resume 口径，可以接受。摘要行的累计 `Thought for` 仍按消息 `durationMs` 累加，不用实测 |
| 区域到 run 的映射 | fold 开关都按 pi 规则重算（含「隐藏且标签为空则无区域」），不再用 `runs[Math.min(index, …)]` 兜底 | 默认标签非空时与旧逻辑结果相同 |
| 配置切换 | 只有影响阶段的切换（fold 开关、`enabled`、`tools.compact`、`thinking` 0 ↔ 非 0、`minItems`）才重新 seed，并逐个 invalidate 已有工具行让 pi 重调 `renderCall`；运行中延到 `agent_settled` | 其它切换不重建模型，保住已展开的行 |

### 10.4 已知限制

1. 宿主是一个「隐藏且标签为空」的思考 run 时，它没有区域，整个阶段画不出摘要（要求用户把 hidden thinking label 设成空串并按下 `Ctrl+T`）。
2. 锚点键用 `message.timestamp`，两条 assistant 消息时间戳相同（毫秒级）时 thinking 锚点会相撞。
3. 阶段在运行中切换配置时，折叠等本轮结束才按新配置重建；这期间 assistant 侧已按新开关重画，工具侧仍是旧模型。
4. 中断的会话（进程退出时有命令没等到结果）resume 后收起，但那条命令没有结果，摘要里那一类仍是进行时（`Running 1 command`）。
5. 很长的一轮在运行中会占很多行；收起发生时宿主可能已滚出视口（§8 风险 4）。

### 10.5 结论

1. 渲染时判定覆盖到工具行：fold 开启时非宿主工具行也返回视图、渲染为 `[]`，seed 晚到、阈值跨越、配置切换都不依赖 pi 重调 `renderCall`。
2. 归属双路登记（补丁 + 扩展消息事件），`ingestAssistant` 幂等，旧消息只刷新不追加；「流式快照序列 = seed」有单测锁住。
3. 流式中参数未完成的 `bash/powershell` 与 `read` 先折叠，参数完整后判为变更或 skill 读取就移出并关闭阶段；这是唯一的回改，且只动最后一个条目。
4. 阶段只在 live 与 seed 都能观察到的事件上关闭。
5. 计数是全量、时态看进行中；思考时长按消息去重累加，缺失时省略。
6. fold 关闭时一切照旧，包括命令预览的旧画法与只读组；`shellPreviewLines` 默认 3。
7. 第四版：段多了 `collapsed`；运行中宿主画只追加的列表，连线按位置每帧推导；`agent_settled` 与 seed 结束共用 `settle()` 一次性收起，流式与 resume 在收起态上一致。
8. 第四版：命令预览从 `execStartedAt` 起满 1 秒才出现，渲染时判定，另有一次性定时器补一帧；单条命令同样适用。
9. 第四版：撤掉思考块贴正文，思考块与正文之间恢复 pi 的空行；`GapSlot` 仍保证画成 0 行的思考块不留孤立空行。
10. 第四版补订：列表里已结束的思考条目是一行浅色 `Thought for 1.5s`（`thoughtLabel`，一分钟内一位小数）；时长运行中逐 run 实测，没测到时只对单 run 消息用 `durationMs`，否则写 `Thought`；结构不受影响，「流式快照 = seed」仍成立。全文在二级展开与 `Ctrl+T`。
