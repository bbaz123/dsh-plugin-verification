# Project Instructions — dsh-plugin-verification

本文件是本项目的**项目级指令**，只描述「这个项目怎么工作」。
Agent 的通用行为规则在 `~/.dsh/AGENTS.md`；工作区级说明在上级 `../AGENTS.md`。三者叠加生效。
规范来源是《DSH Verification Gate 插件具体实现方案》（下称「方案」），本文件负责记录实现与方案的对应关系，
以及改动时不得破坏的契约。

## 项目目标

实现 DSH 的「验证门」：在 turn 关闭前运行
**Change → Memory → Regression → Assertion → Review**，确认失败时走
**Ledger → 强制检索 → RepairPacket → 注入 → 从 Regression 重跑**，
通过后把收尾交还 Agent 已有的全局复盘规则。

插件**只验证、只记录**：不修改业务代码、不修改全局 `AGENTS.md`、不写长期记忆。

## 技术栈

- Node.js ≥ 22.19.0（本机 v24.19.0），纯 ESM，零构建、零运行时依赖。
- Cordis 4 宿主平面插件；贡献到宿主注册表 `tools`、`systemPrompt`。
- `node --test` 作为测试框架；离线用例不依赖 DSH 安装。

## 目录与职责

| 路径 | 约定 |
| --- | --- |
| `lib/index.js` | **只做 Cordis 装配**：配置、效果注册、生命周期接线。不放决策逻辑 |
| `lib/config.js` | 配置 schema（扁平，供 Loader 与 Inspector）+ `normalizeConfig`（语义、钳制、嵌套兼容） |
| `lib/protocol.js` | 协议唯一事实来源：状态、证据、finding、修复包、门禁判定。**纯函数，无 I/O** |
| `lib/store.js` | EvidenceStore / TaskErrorLedger / TaskStore。**读状态失败必须 fail-closed** |
| `lib/baseline.js` | 快照采集、隔离还原、缓存键。**不得对用户工作区做 checkout/reset/stash** |
| `lib/adapters.js` | 项目检测、执行计划、Vitest JSON / JUnit XML 解析、逐项比较。纯函数 + 注入 `fsx` |
| `lib/host/dsh.js` | 插件消息构造、根会话判定、观测缓冲、项目文件读取 |
| `lib/host/execution.js` | Shell 执行封装：退出码/超时/中止/截断/沙箱分开报告 |
| `lib/host/openviking.js` | 记忆适配层：运行时发现工具 + 校验真实 schema + 受控调用 |
| `lib/modules/*.js` | 六个业务模块：change / memory / regression / assertion / review / repair |
| `lib/runtime/controller.js` | 状态机与唯一调度器：预算、轮次、阻塞、注入 |
| `lib/runtime/task-state.js` | 任务身份、持久化、再水化、状态摘要 |
| `lib/runtime/finalization.js` | 收尾交接文本 + **基于观测的记忆回读核验** |
| `lib/tools.js` | 三个工具定义（`defineTool`） |
| `lib/rules.js` | System Prompt 段落文本（软层） |
| `test/` | 行为契约用例；端到端用替身，不 spawn 进程 |
| `verify/wiring.mjs` | 真实 Cordis + 真实 `defineTool` 的装配验证 |

## 不得破坏的契约

- **`completed` 只能由 `computeGate()` 产生**，不得由工具参数或调用方提交。
- **技术验收与收尾状态必须分开报告**：不得把 `finalization: partial` 说成「代码有问题」，也不得反过来说成「全部完成」。
- **`blocking` / `authority` 由 `authorizeFinding()` 计算**。模型（或任何引擎）只能提出 finding；
  `historical_memory` / `model_inference` 不能单独支撑阻塞性结论；`advisory` 永不阻塞。
- **`empty` ≠ `failed`**（记忆检索）：无命中可以继续，未完成必须按策略阻塞。
- **修复包必须先有检索凭据**：`RepairReadTicket` 绑定 taskId + workspaceFingerprint + failureFingerprint，
  任一不匹配都不得授权自动修复。检索失败默认进入 `blocked`，降级必须记录为显式例外。
- **阶段产物按轮次追加，不原地覆盖**；证据在被新指纹取代时标记为 `stale`，**不删除**。
- **`exitCode === 0` 不能单独构成 PASS**：报告缺失/不可解析、超时、中止、输出截断都必须使证据变为 `incomplete`。
- **工具返回值必须满足该工具自己声明的 `output.schema`**：可选字段"这次没有值"用**省略**表达，不得用 `null` 顶替
  `string`/`number`；跨工具共享的失败载荷只带该工具声明过的键（三份 schema 都是 `additionalProperties: false`）。
  回归门是 `test/tool-schema.test.mjs`（按声明 schema 校验三个工具的全部分支，含错误/不适用/无会话分支）。
  对应经验：`viking://~/memories/experiences/工具返回形状与声明输出schema不一致.md`
  （2026-10-10 实测：`verification_run` 在 `not_applicable` 分支返回 `gate:null`/`detail:null`，被宿主拒收）。
- **删除/跳过的测试不算通过**；`fixedFailures` 只认 `passed`。
- **状态文件损坏时必须 fail-closed**：`TaskStore.loadTask()` 返回 `ok:false` 时不得创建新任务、
  不得视为「没有问题」（对应经验：`viking://~/memories/experiences/安全状态读取失败被当成空导致fail-open.md`）。
- **任务阻塞期间修改类工具被拒绝**；解除阻塞只能由用户明确要求后调用 `verification_run(release=true)`。
- **不递归**：`agent/turn-stopping` 只在根会话运行（`ctx.agents.roots()`）；读不到根信息时跳过门，而不是判断子会话。
- **插件不得把状态写进被验证的项目目录**；证据、快照、报告只落在 `storageDir`。
- **非 git 项目默认 fail-closed**：`currentFacts` 读不到 HEAD 时必须报
  `FINGERPRINT_UNAVAILABLE`，不得把“没有 git”当成“没有改动”。只有显式
  `allowNonGitBaseline: true` 才允许回退到有界全树哈希；回退必须使用与基线相同的
  文件枚举/排除规则（`.git`、`node_modules`、`artifacts`、构建产物等），且 lazy baseline
  的隔离工作树仍缺 HEAD 时如实报“基线不可用”，不得伪造。

## 修改原则

- 改决策行为前先改 `test/`：先让用例表达方案里的预期，再改实现。
- `lib/protocol.js` 保持纯函数；任何 I/O、宿主对象、计时器都不得进入。
- `lib/host/*` 是唯一允许 import `@deepseek-ai/*` 的位置之一（另有 `lib/tools.js` 的 `defineTool`、
  `lib/config.js` 的 `schemastery`）。其余模块必须可在没有 DSH 安装的情况下单测。
- 输出字段名（`taskId`、`gate`、`technicalAcceptance`、`finalizationStatus`、finding 的
  `kind`/`action`/`blocking`）属于对外契约，改动视为破坏性变更。
- 扩大插件作用域（例如让它接管普通任务、常见问答）会破坏方案 §1.1 的边界，禁止。
- 新增配置键必须同时更新：`DEFAULTS`、扁平 `Config` schema、`normalizeConfig` 钳制逻辑、
  `cordis.patch.yml` 注释、README 配置表。

## 构建 / 测试 / 检查命令

```powershell
npm test              # 137 个用例（离线，不需要 DSH）
npm run test:offline  # 显式子集；完整门禁以 npm test 为准
node --check lib/index.js
npm run check         # 语法检查 + 全部用例
npm run verify        # 装配验证：真实 Cordis + 真实 defineTool（需要 DSH 安装）
```

本项目**没有**编译、打包、lint、type check 步骤；`npm test` 即完整离线门禁。

依赖解析：`node_modules/@deepseek-ai/{cordis,dsh-tools,dsh-llm,schemastery}` 是指向
DSH 安装内同名包的目录链接（与 `dsh-confirmation-resolution` 同样的做法）。这些链接的目标在工作区之外，
在当前文件沙箱下需要用一次 `danger-full-access` 才能创建；**不要**改成把包复制进项目。

组合层验证：

```powershell
dsh --profile web --dump-config   # 退出码 0 且包含 id: verification-gate
```

## 需要谨慎修改的区域

- `cordis.patch.yml` 的 `name`：写错会让该行无法解析，DSH 启动时的 `assertEntriesActivated`
  会让**整个 profile 启动失败**（不是静默跳过）。
- `lib/index.js` 的 `inject` 是 `['tools', 'systemPrompt', 'shell']`，**三个都不能删**：
  - `shell` 是**必需依赖**，必须留在 `inject` 里。DSH **并发**启动组合里的各个行，
    用 `ctx.get('shell')` 去"可选读取"会输给提供该服务的行，拿到 `undefined`；
    而"拿不到就 log 一下然后 return"是一条**静默路径**——行激活了、却什么都没注册，
    启动时没有 `did not activate` 诊断，重启后表现为"插件装了但三个工具不存在"（**实测踩过**，见
    `viking://~/memories/experiences/宿主插件可选服务直接访问导致整行未激活.md`）。
    本 profile 里 `dsh-budget` 行对 `storageDomain` 用的是同一种修法（profile 的 `cordis.patch.yml`
    里那条注释就是先例）。
  - 缺少 Shell 的组合里，本行会保持 **INACTIVE**（而不是半加载），这是正确的取舍：没有 Shell 就无从执行任何检查。
- **只有"每次调用时读取"的可选服务**才用 `ctx.get(name)`（本插件是 `agents` / `fs` / `sandboxPolicy`），
  禁止 `ctx.name` 属性访问——Cordis 对未写进 `inject` 的服务属性访问会**抛错**
  （`cannot get property "x" without inject`），而不是返回 undefined。
  但**不得**用 `ctx.get` 在 `apply()` 里读取真正必需、且由并发行提供的服务（见上一条）。
- **验证"缺少必需服务时会怎样"必须走真实 loader**：用 `ctx.plugin(plugin, config)` 装载并故意不提供该服务，
  断言行保持 INACTIVE 且**零注册**；裸 `new Context()` 没有 fiber、没有 inject 校验，会给出假绿
  （`verify/wiring.mjs` 里正向与反向两条用例就是干这个的）。
- **代码改了但正在运行的宿主没变**：Node 的 ESM 缓存以文件 URL 为键，`set_bundle` 禁用/启用只会重跑旧模块；
  判断是否真的生效只看 Inspector（`Config.listConfigs` / `Tool.listTools`），换一代 JS 需要重启 DSH。
- **per-agent 接线必须覆盖「加载前就存在的 agent」**：`agent/created` 只对**之后**创建的 agent 触发；
  重启时被恢复的会话，其 agent 可能在插件行加载之前就已存在，于是拿不到 `agent/pre-step` 钩子
  → 基线永远不冻结 → 每个任务都被判 `baseline_never_established`（2026-10-18 实测：门自身跑出 66/66 全绿仍无法验收）。
  修法是在 `apply()` 里通过 `ctx.inject(['agents'])` 对 `roots()` 已有的 agent 也调用同一个**幂等**接线函数；
  不得改为「事后补建基线」——那等于制造 2026-10-12 那种假绿。按 agent 身份幂等，重复 announce 不得挂第二个监听。
- `lib/runtime/controller.js` 的早退分支：`applicable === false`（没有可支持的项目）除了**每个任务告知一次**之外必须真的什么都不做
  （不冻结基线、不跑检查、不产生 finding、不阻塞）。本项目所在工作区（`C:\Users\a1941\Desktop\DeepSeek`）就是这种「容器目录」：
  根目录没有 manifest，下辖 9 个可识别子项目（实测 2026-10-10）。
- **聚合工作区的识别顺序是契约，不得扩展成猜测**：会话已有绑定 → 消息中提到、且经文件系统确认只属于唯一子项目的路径 →
  消息中以**独立词**点名、且只命中唯一子项目目录名 → 只有一个子项目；任何一级出现多义都返回「未介入」。
  **禁止**用「最近修改的」「看起来最像的」等启发式顶上。目录名匹配必须是独立词（`dsh-tools` 不得命中 `novel-dsh-tools`），
  且只在没有任何路径命中时才启用（2026-10-18 实测：用户只写「在 dsh-auto-plan-executor 目录下执行 npm run check」时，
  旧实现因无路径 token 直接退化为「未介入」）。
- **门禁自己注入的通报不是用户需求**：`textsOf()` 必须跳过 `source.kind === 'verification-gate'` 的消息。
  2026-10-12、2026-10-17 两次实测：通报正文里的示例路径被当成用户提到的路径，门把**自己建议里的项目**绑定成验证对象。
- **profile 不得钉死 `config.projectRoot`**：该行是 profile 级、一个实例服务所有会话，钉死会让每个会话都去验同一个项目。
  2026-10-18 实测代价：一个改 `dsh-auto-plan-executor` 的会话被绑到 `novel-studio`，连续 4 轮跑别人的 66 项套件后
  `BUDGET_EXHAUSTED`，该会话的代码一行都没被验。项目根必须每轮重新解析（见上一条顺序）。
- **tokenizer 必须剥掉路径引用的前导 `@`**（`@novel-studio/x.json` → `novel-studio/x.json`）。
  2026-10-10 实测残留缺陷：提示文案自己推荐 `@…` 写法，而 token 带着 `@`，首段永远不等于子项目名、存在性判据也永远不成立
  ——**给用户的建议必须能被自己的解析器读懂**，文案与解析器要一起测。
- **「未介入」不得整代次钉住**：`applicable === false` 的任务在**后续每一轮**都要重新判定（用户可能已经写对路径、工作区可能多了 manifest）。
  2026-10-10 实测残留缺陷：`initializeTask` 的 `initialized` 早退把 N/A 固化在整代次内，用户「下一轮把路径写对」也毫无反应。
  同理，新一轮的需求文本必须走 `openRequirementsRevision`（§4.2：只换需求、不重采基线），不得让 `requirements` 停在建档那一轮。
- **声明了 0 个检查的项目不得报 `verified`**：`acceptance` 必须是 `not_applicable` 并写明原因。
  2026-10-10 实测缺陷：修复前，子项目 `novel-studio`（`checks: []`）在有真实改动时被报成 `acceptance: verified`，而一个检查都没跑。
- **不许静默降级**（同类错误本插件犯过两次：启动竞态导致整行未激活、容器根导致永久 `not_applicable`）：
  任何「装了但不介入」的路径都必须留下可见理由——`verification_status` 的 `reason` + 每任务一次的告知。
- **npm 的命令前缀必须是「脚本名」或 `npx`**：`npm run` 只接受 package.json 里的脚本名，既不接受脚本正文，也没有 `exec` 子命令。
  2026-10-18 实测两种错法：`npm run node --import ./test/host-hooks.mjs --test …`（`Missing script: "node"`）与
  `npm run exec vitest …`。正确形式：manifest 脚本 → `npm run <scripts 键>`（`scriptCommand`），
  本地二进制 → `npx <bin>`（`execPrefix`）。pnpm/yarn/bun 接受命令正文，保持不变。
- `lib/modules/regression.js` 的基线路径：`reportPath` 必须与命令里 `--outputFile` 指向同一路径，
  否则重跑会被解析成「失败消失了」（曾实测踩过）。
- `lib/host/openviking.js` 的参数发现：只能按真实 schema 识别 query/limit 字段，禁止硬编码参数名或盲调。
- System Prompt 段落名 `verification:policy` 与 `order`：预设同名注册会遮蔽全局段落（属预期）。

## 验证要求

- 任何 `lib/` 改动后必须运行 `npm test` 并在汇报中给出实际输出。
- 改动宿主行、包名、`inject`、工具定义或配置 schema 后，必须额外运行 `npm run verify`，
  并执行一次 `dsh --profile web --dump-config` 确认退出码为 0。
- 涉及真实会话行为的结论，必须有可复现证据（用例输出、Inspector 查询结果、dump-config 输出）；
  未能执行的验证必须明确标注为「未验证」。
