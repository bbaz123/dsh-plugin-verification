# dsh-plugin-verification — DSH 验证门

> 把「Agent 说自己完成了」换成「当前项目状态的有效证据说它完成了」。

本插件是《DSH Verification Gate 插件具体实现方案》的可运行实现：一个只服务于 DSH 的宿主平面
Cordis 插件，在 turn 真正关闭之前执行 **变化分析 → 经验检索 → 回归 → 断言 → 只读审查**，
发现证据支持的问题后先检索 OpenViking，再把当前错误、本任务错误记录与相关历史经验一起交回 Agent。

它不修改业务代码、不修改全局规则、不写长期记忆——只验证、记录，并把收尾交还给 Agent 已有的
全局复盘规则。

---

## 一、它做什么

| 阶段 | 行为 | 产物 |
| --- | --- | --- |
| 变化分析 Change | 确定性文件比较（基线 vs 当前）、组件映射、风险信号 | `ChangeAnalysis` |
| 经验检索 Memory | 四个强制检查点：change / regression / assertion / repair | `RetrievalReceipt` |
| 回归 Regression | 按模式执行项目自身声明的检查，逐**测试项**比较基线 | `RegressionResult` + 证据 |
| 断言 Assertion | 复用回归证据，补齐仍缺的机器检查 | `AssertionStageResult` |
| 只读审查 Review | 基于证据生成 finding，并做第二轮校验 | `ReviewResult` |
| 修复调度 Repair | 账本 → 强制检索 → 凭据 → 修复包 → 注入 | `RepairPacket` + `RepairReadTicket` |
| 收尾交接 Finalization | 把验证结果交回 Agent 的全局规则，并核验记忆回读 | 收尾状态 |

状态机（`working / analyzing / regression / assertion / reviewing / retrieving_for_repair /
repairing / finalizing / completed / blocked / cancelled`）由单一控制器调度：
**一套修复循环、一份预算、一组计数器**，不是每个阶段各自重试。

`completed` 不接受调用方提交，只能由 `computeGate()` 在必要条件满足后产生；并且始终分开报告
两个轴：

- `Technical Acceptance`: `verified / not_verified / not_applicable`
- `Finalization Status`: `complete / partial / pending / not_required`

所以「代码验证通过，但记忆回读失败」不会被说成「代码没修好」。

## 二、三条硬性质

1. **每一次通过都追溯到当前项目状态的有效证据。** 证据必须回答：谁产生的、执行了什么、
   对应哪个工作区指纹、结果是否完整、原始材料在哪。`historical_memory` 与 `model_inference`
   可以登记，但不能单独支撑任何阻塞性结论。
2. **每一次打回都先完成经验检索。** `retrieving_for_repair` 阶段先查任务账本、再查 OpenViking，
   生成与「任务 + 工作区指纹 + 失败指纹」绑定的回执。检索失败/超时/被拒 = 阻塞，
   **绝不悄悄按空结果放行**。`empty`（查询成功但无命中）与 `failed` 是两个不同状态。
3. **每一次修复都重新验证。** 修复后从回归阶段重跑；同一失败指纹重复出现且没有进展时提前停止；
   循环预算用尽后保存并展示阻塞报告，而不是继续解释。

附加约束：修改类工具在任务阻塞期间会被单调守卫拒绝；`blocking` / `authority` 由插件策略引擎计算，
模型无法用 JSON 自己授予。

## 三、三个工具

| 工具 | 用途 |
| --- | --- |
| `verification_run` | 主动执行 `quick` / `regression` / `full`；`release=true` 在用户明确要求继续时解除阻塞；`requirements` 开启新的需求版本 |
| `verification_status` | 只读查询阶段、轮次、门禁判定、未解决问题、证据索引与四次检索记录 |
| `verification_finalize` | 提交最终复盘报告与**真实**的记忆收尾结果（`written` / `none`） |

三者都不能提交 PASS，也不接受任意 shell 字符串替换必测计划。

`verification_finalize` 不接受 `{"memorySaved": true}` 作为证明：插件会用本会话实际观察到的
`tools/result` 核验「是否真的调用了写入工具、写入后是否真的回读、回读结果是否匹配写入返回的
记录标识或内容」。只搜到一条相似旧记忆不算本次写入成功。

## 四、配置

`cordis.patch.yml` 已给出全部键（扁平，一行一键），默认值与方案 §10.1 一致。常用项：

```yaml
enabled: true            # 总开关
mode: enforce            # enforce | observe（只收集证据、不干预 turn）| off
defaultMode: regression   # quick | regression | full
maxRepairCycles: 3       # 整个门共享的修复预算
unknownRequiredCheck: block  # 必测项缺证据时：block | warn
sameFailureNoProgressLimit: 2
executionAutoInstallDependencies: false   # 不静默联网安装
memoryRequiredBeforeRepair: true
memoryOnReadFailure: block                # 检索失败即阻塞
memoryToolPattern: openviking             # 用于在运行时发现 OpenViking 工具
memorySearchTool: ''                      # 精确指定工具名（留空则按 pattern + search 语义发现）
allowNonGitBaseline: false                # 非 git 项目是否允许有界全树哈希回退（默认 fail-closed）
storageDir: ''           # 留空 -> $DSH_HOME/storages/verification-gate
requireDetectedProject: true              # 检测不到支持的项目就不介入（聚合工作区先尝试识别唯一子项目）
blockMutatingToolsWhileBlocked: true
```

嵌套写法（把方案里的 `verification:` / `memory:` 等分组直接抄进 `config`）也会被归一化接受。

**非 git 项目**：默认仍是 fail-closed——`currentFacts` 读不到 `git rev-parse HEAD` 就报
`FINGERPRINT_UNAVAILABLE`，不会把“没有 git”当成“没有改动”。如果项目本身**有意不使用 git**，
显式设 `allowNonGitBaseline: true`：门会扫描并哈希有界的工作区文件树（跳过 `.git`、`node_modules`、
`artifacts`、构建产物等），用同一份全树哈希做基线/当前对比。注意此时 lazy baseline 的隔离工作树
仍需要 git HEAD，只有在当前检查失败、需要构建基线侧时才会退化为“基线不可用”的如实报告。

### 工作区根是「容器」时（聚合工作区）

一个工作区可以不是项目，而是**装着若干项目的目录**（例如 `C:\work` 下有 `app/`、`lib/`、`tools/`，根目录自己没有 manifest）。
基线必须在 turn 改动之前冻结，所以「这轮属于哪个子项目」不能用「这轮改了什么」来事后决定，只能由 turn 开始前就存在的信号决定，顺序固定为：

1. 本会话此前已经识别出的项目（延续，不是猜测）；
2. 用户消息里提到的路径**在真实文件系统上**只存在于唯一一个子项目中（支持 `ai/policy.mjs` 与 `novel-studio/ai/policy.mjs` 两种写法）；
3. 工作区里只有一个项目。

三者都不成立时返回「没有可支持的项目」并**明确告知未介入**（每个任务一次），**绝不用「最像的那个」顶上**——挑错会冻结错的基线、跑去跑错项目的检查，比拒绝介入更糟。子项目识别结果绑定在**任务**上并落盘，宿主重启后由它恢复。

两个必须同时成立的前提（都实测踩过）：消息里的路径引用**前导 `@` 与 `./` 都会被剥掉**后再匹配（否则提示自己推荐的写法读不懂，`@novel-studio/package.json` 得 0 分）；**「未介入」不整代次钉住**——`applicable === false` 的任务在后续每一轮都会重新判定，所以「这一轮把路径写对」当场生效、不必重启；每轮的新需求走 `openRequirementsRevision` 开新修订（只换需求，不重采基线）。

同一规则的另一面：**被识别出的项目如果自己没声明任何检查**（没 test/typecheck/build/lint 脚本，也没 vitest/pytest 配置），技术验收一律为 `not_applicable` 并写明原因，**不得**因为「没有检查失败」而报 `verified`——一个检查都没跑，就不是通过。

### 状态存放在哪里

`storageDir`（默认 `$DSH_HOME/storages/verification-gate`）下的 `tasks/`、`reports/`、`snapshots/`。
**绝不写进被验证的项目目录**：项目的构建、测试或 Agent 的编辑不能覆盖用来判断它们的证据。

### OpenViking 绑定方式

宿主**没有**提供公开的记忆检索服务（`openvikingMemory` 负责采集/召回，记忆读取以 MCP 工具形态到达模型）。
因此适配层走方案 §7.2 指定的方式：**受控工具执行入口**（`ctx.tools.execute`）调用运行时**真实注册**的
OpenViking 工具。调用前会检查该工具的真实 schema：

- 找不到可识别 query 参数的工具 → 报 `unavailable`，**不会盲调**；
- 查询无命中 → `empty`；查询未完成 → `failed`；被策略拒绝 → `denied`。

## 五、安装

```text
plugin_manager install_bundle   target = 本目录绝对路径
```

安装后验证（返回的 `application` 字段才是判据）：

```powershell
node verify/wiring.mjs                 # 真实 Cordis + 真实 defineTool + 真实 loader 的装配验证
dsh --profile web --dump-config        # 退出码 0，且包含 id: verification-gate
```

运行时自检：`Config.listConfigs` 能看到本行，`Tool.listTools` 能列出三个 `verification_*` 工具。

> **首次安装或替换已装包之后，需要重启 DSH 才会加载新的模块代次。**
> 宿主进程按文件 URL 缓存 ESM 模块，反复禁用/启用同一个 bundle 只会重跑旧模块
> （表现为同一个错误一直复现，而磁盘上的代码早已改过）。判据是 Inspector 里是否真的出现三个工具，
> 不是安装命令返回了什么。

本行声明 `inject: ['tools', 'systemPrompt', 'shell']`。宿主**并发**启动组合里的各个行，
因此必需依赖必须靠 `inject` 让 Cordis 等待，不能在 `apply()` 里"可选读取"——
那会输给提供该服务的行、拿到 `undefined`；若再"拿不到就静默返回"，就会出现
**行已激活却什么都没注册**（重启后表现为"插件装了但三个工具不存在"，且启动没有失败诊断）。
副作用是诚实的：在完全没有 Shell 服务的组合里，本行保持未激活，而不是加载一个永远无法执行检查的门。

卸载：移除该 bundle 即可；行、监听、效果都会随之注销，除插件自己的存储目录外不留残余。

## 六、开发与验证

```powershell
npm test              # 137 个用例：配置、协议、存储、比较、适配器、端到端管线、full-suite 映射、非 git 基线（不需要 DSH）
npm run test:offline  # 显式子集；完整门禁以 npm test 为准
npm run check         # 语法检查 + 全部用例
npm run verify        # 装配验证（需要 DSH 安装以检查 profile 链接）
```

端到端用例（`test/pipeline.test.mjs`）用可编程的 Agent/Shell/记忆替身跑通方案 §11 要求的主链路：

```text
第一次修改产生错误 → 门真实检测失败 → 观察到四个检查点的检索调用
  → 下一步输入真的包含 RepairPacket → 第二次修改修复 → 门重新执行并通过 → 收尾交接
```

以及：无项目修改不执行测试、基线已有失败不归因本任务、新增失败正确识别、必测测试被删除/跳过
不算通过、退出 0 但报告缺失不算 PASS、检索失败不伪装成空命中、同一失败无进展提前停止、
预算用尽阻塞、收尾又改代码则重验、写入后只搜到相似旧记录不宣称成功、状态文件损坏时 fail-closed。

## 七、V1 的边界（明确未实现的部分）

诚实列出，避免把「设计了」当成「实现了」：

| 项目 | 现状 |
| --- | --- |
| 审查引擎的模型化审查 | **未实现**。V1 的审查是**确定性证据审查**：需求覆盖表会列出每条需求，但状态一律为 `unverified` 且不据此阻塞——语义判断仍归 Agent 已有的全局复盘规则。配置项 `reviewEnabled` 控制的是这个确定性审查。 |
| 基线依赖环境重建 | 锁文件未变时用目录链接共享 `node_modules`；**锁文件变了就明确报告基线不可用**，不做「假装可比」的比较。 |
| 基线快照范围 | 受 `snapshotMaxFiles` / `snapshotMaxFileBytes` 限制；git-ignored 路径不纳入，且会在快照的 `excluded` 中声明。 |
| 不稳定测试判定 | 只对失败文件做一次聚焦重跑，且仅限 vitest / pytest 适配器。 |
| 插件存储写入 | 插件自身存储用 `node:fs`；读取项目文件优先走 `ctx.fs`（策略感知），不可用时回退。 |
| `ctx.verification` 服务 | 控制器是插件内部的单例调度器，**未**作为 Cordis 服务发布（发布服务需要 isolate realm，收益不足）。 |
| 自动生成 E2E / Golden Master 采集 | 未实现（方案本身也把它列为 V1 之外）。 |
| 聚合工作区的「每轮重解析」 | 子项目绑定落在**任务**上（同一宿主进程内按会话延续）。任务身份包含该轮的首条消息 id，所以宿主**重启后**，一个没有提到任何路径的 turn 会退回到「歧义 → 未介入 + 明确告知」；提到路径的 turn 仍能正常识别。 |
| 无声明检查的项目 | 见 §四：`not_applicable`，不是 `verified`。 |
| 工具返回值形状 | 每个工具的返回值都必须满足**它自己声明的 `output.schema`**：没有值的可选字段**省略**而不是填 `null`，共享载荷不带未声明的键。宿主会按该 schema 校验，违规时整次调用被拒（`"value.gate" must be a string`）。`test/tool-schema.test.mjs` 覆盖三个工具的全部拒绝/不适用/无会话分支。 |

## 八、兼容性

- 宿主：`@deepseek-ai/dsh` **0.1.7-rc.2**（本机实测版本）。
- peer：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`。
- Node.js ≥ 22.19.0（本机 v24.19.0）。
- 纯 ESM、零构建、零运行时依赖；`lib/host/*` 是唯一接触宿主对象的位置。

DSH 目前仍是 Developer Preview 并会引入破坏性变更，本插件按上述版本测试，不承诺兼容所有公开版本。

## 九、许可

Apache-2.0，见 [LICENSE](./LICENSE)。
