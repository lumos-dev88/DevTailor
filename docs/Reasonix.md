The user is asking me to analyze the context management mechanism in the current project (DeepSeek-Reasonix). Let me first explore the codebase to understand the architecture, then provide a structured analysis covering:

1. Architecture design: storage, retrieval, and flow structure
2. Working principles: context state update and transmission logic
3. Timing flow: complete lifecycle from input to processing to response
4. High hit rate optimization: caching, feature extraction, vectorization, eviction algorithms

Let me start by exploring the project structure to understand the context management system.
The subagent gave me a comprehensive overview. Now I need to read the key files to get deep details for the analysis. Let me read the core context management files to prepare a thorough response.
Now let me also read the controller and coordinator files for complete context flow understanding, as well as the memory compiler runtime.
Now I have a comprehensive understanding of the system. Let me also read the turn orchestrator and memory manager for the complete picture.
Now I have a comprehensive understanding of the entire context management system. Let me synthesize all of this into a structured, professional analysis covering all 4 aspects the user requested.

Let me organize the analysis:

1. **Architecture Design**: Storage, retrieval, and flow structure
2. **Working Principles**: Context state update and transmission logic
3. **Timing Flow**: Complete lifecycle sequence diagram
4. **High Hit Rate Optimization**: Caching, feature extraction, vectorization, eviction strategies

Key components:
- **Session**: Thread-safe message storage with RWMutex
- **Agent**: Core context management with compaction, steering, etc.
- **Compact**: Multi-stage context compression
- **Cache Shape**: Prefix hashing for cache hit/miss diagnostics
- **Prune**: Tool result maintenance
- **Memory System**: Persistent memory with hierarchical docs and auto-memory store
- **Memory Compiler v5**: Execution trace recording and contract compilation
- **Controller**: Input composition with cache-stable prefix
- **Coordinator**: Two-model architecture with separate sessions

Let me write this up comprehensively.
# DeepSeek-Reasonix 上下文管理机制深度分析

---

## 一、架构设计：上下文的存储、检索与流转结构

### 1.1 整体分层架构

系统采用 **"Controller-Agent-Session" 三层上下文架构**，将上下文划分为**稳定前缀（Stable Prefix）** 和**动态尾部（Dynamic Tail）** 两个区域，通过严格的写入纪律保证 LLM Provider 端的前缀缓存（Prompt Cache）持续命中。

```
┌────────────────────────────────────────────────────────────┐
│                    Controller (控制器)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │  memory  │  │  goals   │  │checkpoint│  │   jobs    │ │
│  │  Manager │  │  Machine │  │  Manager │  │  Manager  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│       │             │             │               │        │
│       └─────────────┼─────────────┼───────────────┘        │
│                     │ Compose()    │                         │
│                     ▼             ▼                         │
│              ┌──────────────────────────┐                  │
│              │   Turn Orchestrator      │                  │
│              │   (turnOrchestrator)     │                  │
│              └─────────────┬────────────┘                  │
└────────────────────────────┼───────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────┐
│                  Agent / Coordinator (代理)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Provider   │  │ Tool Registry│  │   Session    │     │
│  │  (LLM 后端)   │  │  (工具集合)   │  │ (消息存储)    │     │
│  └──────────────┘  └──────────────┘  └──────┬───────┘     │
│                                             │               │
│    ┌──────────────────────────────────────┐ │               │
│    │        Context Management            │ │               │
│    │  ┌──────────┐ ┌──────────┐ ┌──────┐ │ │               │
│    │  │ Compact  │ │  Prune   │ │Cache │ │ │               │
│    │  │ (摘要压缩) │ │(工具修剪) │ │Shape │ │ │               │
│    │  └──────────┘ └──────────┘ └──────┘ │ │               │
│    └──────────────────────────────────────┘ │               │
└─────────────────────────────────────────────┼───────────────┘
                                              │
                                              ▼
┌────────────────────────────────────────────────────────────┐
│               Session (会话存储)                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Messages []provider.Message  (RWMutex 保护)          │  │
│  │  rewriteVersion int          (重写版本号)              │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [system] [user] [assistant+tool_calls] [tool_results] ... │
│  ◄────────── 稳定前缀 ──────────►◄── recent tail ──►      │
└────────────────────────────────────────────────────────────┘
```

### 1.2 核心数据结构

**Session** (`internal/agent/session.go`)：
```go
type Session struct {
    mu             sync.RWMutex        // 线程安全，Add/Replace写锁，Snapshot读锁
    Messages       []provider.Message  // 完整的对话历史消息列表
    rewriteVersion int                 // 每次 compact/fold 时递增，驱动缓存失效
}
```

**Agent 上下文参数** (`internal/agent/agent.go`)：
```go
contextWindow       int        // 上下文窗口大小（token），0=禁用compaction
softCompactRatio    float64    // 0.5 - 软提示阈值（仅提示，不压缩）
toolResultSnipRatio float64    // 0.6 - 工具结果截断阈值
compactRatio        float64    // 0.8 - 触发压缩的阈值
compactForceRatio   float64    // 0.9 - 强制压缩高水位
recentKeep          int        // 最小保留消息数
keepPolicy          KeepPolicy // 保留策略（KeepErrors | KeepUserMarked）
```

### 1.3 两级模型架构（Coordinator）

`Coordinator` 实现 Planner + Executor 分离，**两个模型各自拥有独立的 Session**：

```
User Input
    │
    ▼
┌──────────────┐    独立的 Session-A     ┌──────────────┐
│   Planner    │ ───────────────────────► │  Executor    │
│ (规划模型)    │   formatHandoff()        │ (执行模型)    │
│ Session-A    │   (带有缓存稳定前缀)        │ Session-B    │
└──────────────┘                          └──────────────┘
```

关键设计：两个 Session 从不交叉，**各自的 prompt 前缀保持缓存稳定**，一方的 turns 不会干扰另一方的前缀缓存。

---

## 二、工作原理：上下文状态的更新与传递逻辑

### 2.1 上下文写入纪律 —— 稳定前缀 vs 动态尾部

系统的核心原则是**只向用户消息尾部追加内容，绝不修改系统提示或工具Schema**：

| 上下文组件 | 位置 | 是否可变 | 影响缓存 |
|-----------|------|---------|---------|
| System Prompt | Messages[0] | 不可变 | 变化则 CACHE MISS |
| Tool Schemas | API 请求参数 | 不可变 | 变化则 CACHE MISS |
| 分层的 Memory 文档 | System Prompt 尾部 | 仅跨会话更新 | 同会话内稳定 |
| 用户消息 | Session 尾部追加 | 追加模式 | 前缀命中 → 尾部 MISS |
| PlanMode 标记 | 用户消息前缀 | 可切换 | 在用户消息中，不触碰前缀 |
| Memory 更新 | `<memory-update>` 块 | 注入用户消息 | 在用户消息中，不触碰前缀 |
| Background Jobs | `<background-jobs>` 块 | 注入用户消息 | 在用户消息中，不触碰前缀 |
| Steer 消息 | 中轮注入 | 追加用户消息 | 单次 CACHE MISS |

### 2.2 Compose()—— 输入上下文组装

`Controller.Compose()` 是上下文组装的入口，它将各种"叶子"组件**注入用户消息而不触碰缓存前缀**：

```
func (c *Controller) Compose(text string) string {
    // 1. 活跃目标注入（<active-goal> 块）
    // 2. PlanMode 标记注入（如果启用）
    // 3. 语言偏好注入（<reasoning-language>, <response-language>）
    // 4. 记忆更新注入（<memory-update> 块，仅本次会话未合并到前缀的内容）
    // 5. 后台任务完成通知注入（<background-jobs> 块）
}
```

### 2.3 上下文传递的完整链路

```
用户输入 "fix the bug"
    │
    ▼
turnOrchestrator.runOrchestratedTurn()
    │
    ├── mayBeSessionStart()          → 可能的 SessionStart hook
    ├── mayBeAutoPlan()              → 可能的自动规划
    ├── WithParentSession(ctx)       → 上下文传递 session ID
    ├── WithUserImages(ctx)          → 上下文传递用户图片
    ├── WithMemoryCompiler(ctx)      → 上下文传递 Memory v5 源输入
    │
    ├── c.Compose(input)             → ★ 上下文组装：注入 memory/jobs/goal/plan
    │       │
    │       ├── <memory-update>      → 中会话记忆变更
    │       ├── <background-jobs>    → 后台任务完成
    │       ├── <active-goal>        → 活跃目标
    │       └── PlanModeMarker       → 规划模式标记
    │
    ├── beginCheckpoint(input)       → 检查点快照
    │
    └── c.runner.Run(ctx, composedInput)
            │
            ├── maybeCompact()       → 上下文窗口检查
            └── stream(msgs, tools)  → 发送到 LLM Provider
```

### 2.4 中轮转向（Steer）机制

用户可以在 Agent 执行过程中注入引导消息：

```go
func (a *Agent) Steer(text string) {
    a.steerQueue = append(a.steerQueue, text)
}
```

- 每个 steer 消息导致**一次 CACHE MISS**
- 消息带 `MidTurnSteerPrefix` 前缀标识为引导而非新任务
- 被持久化到 Session 中，在 history replay 时重现

### 2.5 Memory v5 编译器上下文注入

`memorycompiler.Runtime` 将执行追踪编译为执行契约（PlannerIR），通过**用户消息替换**注入：

```
用户输入 "fix the bug"
    │
    ▼
memCompiler.StartTurn()
    │
    ├── 选择策略（基于成功率和探索率）
    ├── 引用相关记忆（向量/关键词匹配）
    ├── 生成执行步骤（ExecutionSteps）
    └── 编译为 PlannerIR XML，替换原用户输入
    │
    ▼
替换后的输入 = "<execution-contract>...[PlannerIR]...</execution-contract>"
```

注入有严格的门控：最多 5 次注入，每次至少间隔 30 秒，且只对任务型输入（非聊天）触发。

---

## 三、时序流程：上下文从输入、处理到响应的完整生命周期

### 3.1 完整时序图

```
┌──────┐     ┌───────────┐     ┌───────────┐     ┌────────┐     ┌───────────┐     ┌──────────┐
│ User │     │Controller │     │TurnOrch.  │     │ Agent  │     │ Session   │     │ Provider │
└──┬───┘     └─────┬─────┘     └─────┬─────┘     └───┬────┘     └─────┬─────┘     └────┬─────┘
   │               │                 │               │               │                 │
   │  Send(msg)    │                 │               │               │                 │
   │──────────────►│                 │               │               │                 │
   │               │                 │               │               │                 │
   │               │ acquire run lock│               │               │                 │
   │               │────────────────►│               │               │                 │
   │               │                 │               │               │                 │
   │               │                 │ [Pre-turn]    │               │                 │
   │               │                 │── mayBeSessionStart           │                 │
   │               │                 │── mayBeAutoPlan               │                 │
   │               │                 │── resolve @refs               │                 │
   │               │                 │── drainPending memory         │                 │
   │               │                 │── drainCompleted jobs         │                 │
   │               │                 │── check active goal           │                 │
   │               │                 │               │               │                 │
   │               │                 │ [Compose]     │               │                 │
   │               │                 │── Compose(input)              │                 │
   │               │                 │   ├─<memory-update>           │                 │
   │               │                 │   ├─<background-jobs>         │                 │
   │               │                 │   ├─<active-goal>             │                 │
   │               │                 │   └─PlanModeMarker            │                 │
   │               │                 │               │               │                 │
   │               │                 │ [Run turn]    │               │                 │
   │               │                 │──────────────►│               │                 │
   │               │                 │               │               │                 │
   │               │                 │               │ [Memory v5]   │                 │
   │               │                 │               │── classifier.IsTask()          │
   │               │                 │               │── memCompiler.StartTurn()       │
   │               │                 │               │── 可能注入执行契约               │
   │               │                 │               │               │                 │
   │               │                 │               │── session.Add(user msg)         │
   │               │                 │               │──────────────►│                 │
   │               │                 │               │               │                 │
   │               │                 │               │ [MaybeCompact]│                 │
   │               │                 │               │── maybeCompact(usage)           │
   │               │                 │               │   ├─ soft (<0.5): 仅提示        │
   │               │                 │               │   ├─ snip (<0.6): 截断工具结果   │
   │               │                 │               │   ├─ compact (<0.8): 触发压缩   │
   │               │                 │               │   │   ├─ PruneStaleToolResults  │
   │               │                 │               │   │   ├─ planCompaction         │
   │               │                 │               │   │   ├─ partitionFold          │
   │               │                 │               │   │   ├─ summarize()            │
   │               │                 │               │   │   └─ session.Replace()      │
   │               │                 │               │   └─ force (<0.9): 强制压缩     │
   │               │                 │               │               │                 │
   │               │                 │               │ [Stream]      │                 │
   │               │                 │               │── prov.Stream(messages, tools)──►│
   │               │                 │               │               │    LLM Stream    │
   │               │                 │               │◄─ reasoning ──│◄────────────────│
   │               │  event.Reasoning│◄──────────────│               │                 │
   │               │◄────────────────│               │               │                 │
   │               │                 │               │◄─ text ───────│◄────────────────│
   │               │  event.Text     │◄──────────────│               │                 │
   │               │◄────────────────│               │               │                 │
   │               │                 │               │◄─ tool_calls ─│◄────────────────│
   │               │  event.ToolDispatch◄────────────│               │                 │
   │               │◄────────────────│               │               │                 │
   │               │                 │               │◄─ usage ──────│◄────────────────│
   │               │                 │               │  (cache_hit/miss, total, etc.)  │
   │               │                 │               │               │                 │
   │               │                 │               │ [CacheDiagnostics]             │
   │               │                 │               │── CompareShape(prev,cur,usage)  │
   │               │                 │               │── 发送 Usage 事件(含诊断)       │
   │               │                 │               │               │                 │
   │               │                 │               │── session.Add(assistant msg)    │
   │               │                 │               │──────────────►│                 │
   │               │                 │               │               │                 │
   │               │                 │               │ [Execute Tools]                │
   │               │                 │               │── executeBatch(calls)           │
   │               │                 │               │   ├─ partitionToolCalls (RO并联)│
   │               │                 │               │   ├─ gate check (权限)          │
   │               │                 │               │   ├─ planMode check (只读)       │
   │               │                 │               │   ├─ PreToolUse hook            │
   │               │                 │               │   ├─ onPreEdit snapshot         │
   │               │                 │               │   ├─ tool.Execute()             │
   │               │                 │               │   ├─ evidence.Record()          │
   │               │                 │               │   └─ PostToolUse hook           │
   │               │                 │               │── session.Add(tool results)     │
   │               │                 │               │──────────────►│                 │
   │               │                 │               │               │                 │
   │               │                 │               │ [循环直到 final answer]         │
   │               │                 │               │── finalReadinessCheck()         │
   │               │                 │               │   ├─ 检查未完成 todos            │
   │               │                 │               │   └─ 检查 project checks         │
   │               │                 │               │── maybeCompact()                │
   │               │                 │               │               │                 │
   │               │  event.TurnDone│◄──────────────│               │                 │
   │               │◄────────────────│               │               │                 │
   │               │                 │               │               │                 │
   │               │ [Post-turn]    │               │               │                 │
   │               │── snapshot activity            │               │                 │
   │               │── record display               │               │                 │
   │               │                 │               │               │                 │
   │  (response)   │                 │               │               │                 │
   │◄──────────────│                 │               │               │                 │
```

### 3.2 关键阶段说明

| 阶段 | 描述 | 时间节点 |
|------|------|---------|
| **Pre-turn** | 解析用户输入、组装上下文、注入 memory/jobs/goal | Turn 开始前 |
| **Memory v5** | 分类器判断任务/聊天，选择性启动 Memory Compiler | Run 开始时 |
| **Add User Msg** | 将组合后的用户消息追加到 Session | 进入 Agent.Run 后 |
| **MaybeCompact** | 检查上下文窗口，执行分级压缩 | 每次 API 调用前/后 |
| **Stream** | 发送请求到 LLM，流式接收 reasoning/text/tool_calls/usage | 压缩后 |
| **CacheDiagnostics** | 比较前后 PrefixShape，诊断缓存命中/未命中原因 | Stream 完成后 |
| **Execute Tools** | 执行工具调用，并行只读调用，串行写入调用 | 模型返回 tool_calls 后 |
| **Post-turn** | 完整度检查、再次 compact、快照活动 | Turn 结束前 |

---

## 四、高命中率优化：实现高缓存命中率的策略详解

### 4.1 稳定前缀策略 —— 缓存命中的基石

**核心思想**：LLM Provider（如 Anthropic Claude、OpenAI）的 Prompt Cache 基于**前缀匹配**——只要消息列表的前缀不变，后续轮次的请求就能命中缓存。系统的所有优化都围绕"让前缀尽可能不变"展开。

```
时间线:  Turn 1              Turn 2              Turn 3
         ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
         │ System      │    │ System      │    │ System      │   ◄── 缓存命中 ✓
         │ Memory      │    │ Memory      │    │ Memory      │   ◄── 缓存命中 ✓
         │ Tools       │    │ Tools       │    │ Tools       │   ◄── 缓存命中 ✓
         ├─────────────┤    ├─────────────┤    ├─────────────┤
         │ User msg 1  │    │ User msg 1  │    │ User msg 1  │   ◄── 缓存命中 ✓
         │ Assistant 1 │    │ Assistant 1 │    │ Assistant 1 │   ◄── 缓存命中 ✓
         │ Tool 1      │    │ Tool 1      │    │ Tool 1      │   ◄── 缓存命中 ✓
         ├─────────────┤    ├─────────────┤    ├─────────────┤
         │             │    │ User msg 2  │    │ User msg 2  │   ◄── 缓存命中 ✓
         │             │    │ Assistant 2 │    │ Assistant 2 │   ◄── 缓存命中 ✓
         │             │    │ Tool 2      │    │ Tool 2      │   ◄── 缓存命中 ✓
         │             │    ├─────────────┤    ├─────────────┤
         │             │    │             │    │ User msg 3  │   ◄── 首次计算/缓存未命中
         │             │    │             │    │ Assistant 3 │
```

**关键保证**：
- System Prompt 从不修改
- Tool Schema 从不修改（PlanMode 也不改变 tool 列表，只在 execute 时 gating）
- Memory 文档同会话内不变（变更通过 turn-tail notes 注入用户消息）
- 会话恢复时，系统提示必须与保存时完全一致

### 4.2 PrefixShape —— 缓存形态诊断机制

`cache_shape.go` 实现了**前缀形状的哈希快照与跨轮次比较**，精确定位缓存未命中原因：

```go
type PrefixShape struct {
    SystemHash        string  // SHA256 前8字节 → System Prompt 是否变化
    ToolsHash         string  // SHA256 前8字节 → Tool Schema 是否变化
    PrefixHash        string  // System+Tools 联合哈希
    LogRewriteVersion int     // Session 重写版本 → Compaction 是否发生
    ToolSchemaTokens  int     // Tool Schema 估计 token 数
}
```

**CompareShape** 在每轮 LLM 调用后执行，诊断并报告：
- `"system"` → 系统提示发生变化 → 完整缓存未命中
- `"tools"` → 工具 Schema 发生变化 → 完整缓存未命中
- `"log_rewrite"` → Compaction 重写了 Session → 前缀变更

### 4.3 分层压缩策略（Compaction） —— 延迟缓存重置

Compaction 是缓存命中率的**最大敌人**（每次 compact 都会导致 rewriteVersion 递增，触发前缀变化），系统通过多级水位线尽可能推迟压缩：

```
Context Window 使用率:
0% ──────────── 50% ──────────── 60% ──────────── 80% ──────── 90% ──── 100%
    正常追加        softCompact    toolResultSnip  compactRatio  forceRatio
    缓存持续命中    仅提示用户      无损截断工具结果   模型摘要压缩    强制压缩
    ✓✓✓✓✓          ✓✓✓✓✓          ✓✓✓✓✓           ✗ 缓存重置     ✗ 缓存重置
```

**具体策略**：

| 水位 | 阈值 | 操作 | 缓存影响 |
|------|------|------|---------|
| **softCompact** | 50% | 仅通知用户上下文增长 | 无影响 |
| **toolResultSnip** | 60% | 无损截断旧工具结果（仅头尾保留）| 无影响，不改变 RewriteVersion |
| **compactRatio** | 80% | Plan → Prune → PartitionFold → Summarize → Replace | **缓存失效** |
| **compactForce** | 90% | 强制压缩（跳过经济效益检查）| **缓存失效** |

### 4.4 工具结果修剪（Snip/Prune） —— 免费的上下文回收

`prune.go` 实现了**不需要模型调用的上下文回收策略**，这是"免费"的优化，不影响缓存：

**SnipStaleToolResults**（60%-80% 水位）：
- 保留工具结果的前 N 行（head）和后 M 行（tail）
- 根据工具类型选择不同策略：
  - 只读工具（如 `read_file`）：保留前 80 行 + 后 12 行
  - 带副作用工具（如 `bash`）：保留前 40 行 + 后 40 行
- 不影响 Assistant 的 tool_calls 和 reasoning

**PruneStaleToolResults**（80% 水位，compact 前）：
- 将工具结果替换为占位符：`[elided tool result — <name>, <n> bytes archived]`
- 在 compact 之前执行，可能直接清除 compact 需求

### 4.5 智能分区折叠（PartitionFold） —— 保持关键信息

Compaction 时不是简单地从中间切分，而是进行智能分区：

```
Session Messages:
[system] [user-1] [assistant-1+calls] [tool-1] [assistant-2+calls] [tool-2] ... [user-N]
◄── pinnedPrefix ──►◄────── foldable region ──────────►◄── recent tail ──►
   永远保留          ↓                                    token预算内的保留
                    ┌──────────────────────┐
                    │  partitionFold()     │
                    │  ├─ 小用户turn → kept│    ← 用户事实永不摘要化
                    │  ├─ 历史摘要   → kept│    ← 避免摘要链丢失信息
                    │  ├─ KeepErrors  → kept│   ← 保留错误消息用于调试
                    │  ├─ KeepUserMarked→ kept│ ← [[keep]]/<!-- keep --> 标记
                    │  └─ 其余       → fold│    ← 仅这部分被摘要化
                    └──────────────────────┘
```

**分区的经济效益检查**：
```go
func foldEconomics(region []provider.Message) bool {
    const minFoldTokens = 400
    return estimateMessagesTokens(region) >= minFoldTokens
}
```
仅当折叠区域 token 数 ≥ 400 时才调用 Summarizer，避免为节省少量 token 而消耗总结 API 调用的成本。

### 4.6 Token 估算器 —— 无需本地 Tokenizer

系统不引入笨重的本地 tokenizer，而是使用**轻量级 token 估算**：

```go
func estimateTextTokens(s string) int {
    bytes := len(s)
    runes := utf8.RuneCountInString(s)
    byBytes := (bytes + 3) / 4        // 英文 ≈ 4 字节/token
    if runes > byBytes {
        return runes                  // CJK ≈ 1 字符/token
    }
    return byBytes
}
```

**动态校准** (`tokPerChar()`)：
```go
func (a *Agent) tokPerChar() float64 {
    if u := a.lastUsage.Load(); u != nil && u.PromptTokens > 0 {
        if c := charsOfMessages(a.session.Messages); c > 0 {
            if r := float64(u.PromptTokens) / float64(c); r > 0.05 && r < 2 {
                return r  // 使用上一轮的真实 token/字符 比率
            }
        }
    }
    return fallbackTokPerChar  // 0.25，约 4 字符/token
}
```

### 4.7 Memory 系统的缓存无关更新

Memory 系统的写入（`remember`/`forget`/文档编辑）**不会触发缓存失效**：

```
写入 REASONIX.md         写入 auto-memory         写入新 fact
       │                       │                       │
       ▼                       ▼                       ▼
   磁盘持久化               磁盘持久化               磁盘持久化
       │                       │                       │
       ▼                       ▼                       ▼
   turn-tail note           turn-tail note          turn-tail note
   (追加到下一条用户消息)     (追加到下一条用户消息)     (追加到下一条用户消息)
       │                       │                       │
       ▼                       ▼                       ▼
   当前会话生效              当前会话生效              当前会话生效
   (不触碰系统提示前缀)       (不触碰系统提示前缀)       (不触碰系统提示前缀)
       │                       │                       │
       ▼                       ▼                       ▼
   下次会话启动时             下次会话启动时            下次会话启动时
   memory.Load()              memory.Load()            memory.Load()
   重新发现并折叠到前缀        重新发现并折叠到前缀      重新发现并折叠到前缀
```

### 4.8 聚合缓存命中率追踪

系统提供了**跨多轮的聚合缓存命中率**，而非仅单轮统计：

```go
sessCacheHit  atomic.Int64  // 跨所有 API 调用的累计缓存命中 token
sessCacheMiss atomic.Int64  // 跨所有 API 调用的累计缓存未命中 token

// 聚合命中率 = Σhit / Σ(hit + miss)
```

这两个计数器**在 Compaction 时不被重置**——Compaction 只重写 Messages，不影响累计统计，因此前端的状态行显示的命中率是一个稳定、有意义的成本指标。

### 4.9 多阶段总结提示 —— 结构化的摘要质量保证

Compact 使用的总结提示精心设计，确保摘要质量，避免"摘要丢失关键信息"：

```
## Standing facts & constraints     ← 用户陈述的事实
## Goal                              ← 用户目标
## Decisions & rationale             ← 已做的决策（避免重复讨论）
## Files & code                      ← 修改的文件和具体代码信息
## Commands & outcomes               ← 执行的命令和结果
## Errors & fixes                    ← 错误和修复方案（避免重蹈覆辙）
## Pending & next step               ← 待完成工作和下一步
```

### 4.10 防循环保护机制

**Storm Breaker**：
- 检测同一工具的同一错误连续出现 3 次
- 签名基于 `(tool_name, error_message)` 而非 `(tool_name, args)`
- 因为卡住的模型会微调参数但产生同样的错误

**Repeat Success Blocker**：
- 检测同一写入工具连续成功 2 次
- 防止无意义的重复写入循环

**Compact Stuck 保护**：
- 连续 2 轮 Compaction 后仍超过阈值 → 锁定自动压缩
- 提示用户增大 `context_window` 或减少工具输出

---

## 总结

DeepSeek-Reasonix 的上下文管理系统围绕**"稳定前缀最大化缓存命中"**这一核心原则设计：

1. **存储**: Session 以 `[]provider.Message` 为中心，RWMutex 保证线程安全，`rewriteVersion` 追踪重写事件
2. **流转**: Controller.Compose() 将 memory/jobs/goal/plan 注入用户消息尾部，不触碰 System Prompt 和 Tool Schema
3. **压缩**: 四级水位线（50%→60%→80%→90%）渐进式回收上下文，Prune/Snip 在缓存无损阶段先行，Summarize 作为最后手段
4. **诊断**: PrefixShape 哈希快照精确定位缓存未命中原因
5. **优化**: turn-tail notes 延迟 Memory 更新到前缀、经济效益检查避免低价值 Summarize、动态 token 估算替代重量级 tokenizer、两级模型分离避免前缀交叉污染