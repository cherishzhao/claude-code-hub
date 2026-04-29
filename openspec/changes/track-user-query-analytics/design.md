## Context (背景)

系统当前通过 `message_request` 表记录每次代理请求的元数据（token、成本、模型、供应商链路等），但不记录用户实际发送的查询内容。请求体在 `ProxySession.fromContext()` 中解析后仅用于转发，不做持久化。

现有基础设施：
- `ProxySession` 已能解析所有 API 格式（Claude/OpenAI/Codex/Gemini）的消息数组，并提供 `getMessages()` 方法获取原始消息
- `MessageRequestWriteBuffer` 提供了成熟的异步批量写入模式（Map 去重 + 250ms 定时刷新 + CASE WHEN 批量 SQL）
- `systemSettings` 表支持通过新增列扩展全局配置
- 日志清理机制有两种成熟模式：Bull 队列定时清理和 Leader Lock + setInterval 清理

## Goals / Non-Goals (目标与非目标)

**Goals:**
- 完整记录每次请求中用户发送的查询内容原文（不截断、不摘要），使用 `text` 类型存储
- 通过异步写入确保查询记录不影响代理请求的响应延迟
- 提供管理员仪表板页面，支持按用户、时间、会话浏览查询原文
- 提供使用模式聚合分析：对话轮次、任务分类、工具使用频率等行为指标
- 支持全局启用/禁用开关和可配置的数据保留期限
- 支持 5 种语言的国际化

**Non-Goals:**
- 不做查询内容的自动分类或 AI 分析（本期仅提供原始数据和基础聚合）
- 不做实时告警（如检测到异常查询模式时自动通知）
- 不做查询内容的全文搜索索引（如 pg_trgm 或 tsvector），本期用 LIKE 查询即可
- 不修改现有的 `message_request` 或 `usage_ledger` 表结构

## Decisions (技术决策)

### D1: 查询内容存储方案 — 独立 `query_log` 表 vs 在 `message_request` 中加列

**选择: 独立 `query_log` 表**

理由：
- `message_request` 表已经有 25+ 个索引，是系统热路径表，写入频率极高。在其上增加大 text 字段会影响整体 I/O 和 VACUUM 性能
- 查询内容可能很大（编码智能体的上下文窗口可达数十 KB），独立表可以有不同的清理策略和存储周期
- 通过 `message_request_id` 外键关联，查询时 JOIN 即可

备选方案：在 `message_request` 中新增 `query_content text` 列。优点是查询更简单，缺点是影响热路径表性能。

### D2: 消息内容提取策略 — 提取最后一条用户消息 vs 提取全部消息

**选择: 提取最后一条 role=user 的消息内容**

理由：
- 编码智能体的典型请求模式是多轮对话，每次请求携带完整历史。存储全部消息会导致大量重复数据（同一会话的前 N-1 条消息在每次请求中都会重复出现）
- 最后一条用户消息代表了用户当前轮次的实际意图，是评估用户使用模式的核心数据
- 通过 `session_id` + `request_sequence` 可以还原完整对话流

备选方案：存储完整消息数组（JSON）。优点是信息最完整，缺点是存储量膨胀严重，且绝大部分是冗余数据。

### D3: 写入模式 — 复用 MessageRequestWriteBuffer vs 独立写入缓冲

**选择: 独立的 QueryLogWriteBuffer**

理由：
- 查询日志的写入模式与 `message_request` 不同：它是纯 INSERT（一次写入，不更新），而 `MessageRequestWriteBuffer` 是 UPDATE 模式（先创建记录再批量更新字段）
- 独立缓冲区可以有不同的批大小和刷新频率配置（查询内容较大，批大小应更小）
- 故障隔离：查询日志写入失败不应影响核心请求元数据的记录

实现模式复用 `MessageRequestWriteBuffer` 的架构：Map 去重 + 定时刷新 + 批量 INSERT。

### D4: 提取时机 — guard 管道中 vs 响应处理后

**选择: 在 `proxy-handler.ts` 中 message_request 创建后立即提取，异步入队**

理由：
- guard 管道通过后 `session.messageContext` 已经创建（包含 `message_request_id`），此时请求体已解析完毕
- 在转发前提取可以确保即使上游超时或出错也能记录查询内容
- 异步入队不阻塞转发流程

备选方案：在响应处理阶段提取。优点是可以关联响应状态，缺点是如果请求失败可能丢失查询记录。

### D5: 多格式消息提取 — 统一提取函数

利用 `ProxySession` 已有的格式检测和消息访问能力：

```
Claude/OpenAI: messages 数组 → 过滤 role="user" → 取最后一条 → JSON.stringify(content)
Codex:         input 数组 → 取最后一个元素 → JSON.stringify
Gemini:        contents/request.contents → 过滤 role="user" → 取最后一条 → JSON.stringify(parts)
```

提取结果统一存为 `text` 类型，内容为 JSON 字符串（保留原始结构，包括图片引用、工具调用等）。

### D6: 清理策略 — Leader Lock + setInterval

**选择: Leader Lock + setInterval 模式**（与 `probe-log-cleanup` 一致）

理由：
- 查询日志清理是简单的按时间批量删除，不需要 Bull 队列的复杂调度
- Leader Lock 保证多实例部署时只有一个实例执行清理
- 默认保留 30 天，通过 `systemSettings` 中的 `query_log_retention_days` 配置

### D7: 仪表板架构 — Server Actions + 分页

- 查询浏览页面：使用游标分页（keyset pagination），与现有 `usage-logs` 页面模式一致
- 分析聚合页面：使用时间桶聚合（hourly/daily），与现有 `statistics` 模式一致
- 所有数据通过 Server Actions 获取，路由在 `/api/actions/` 下自动注册

## Risks / Trade-offs (风险与权衡)

**[存储增长] → 可配保留期限 + 定时清理**
完整记录查询内容会显著增加数据库存储量。按每条查询平均 5KB、日均 10000 次请求计算，每天约增长 50MB，30 天约 1.5GB。通过可配置的保留期限和定时清理控制增长。

**[大查询性能] → 批量 INSERT + 独立缓冲**
编码智能体的单次查询可能包含大量上下文（数十 KB），批量 INSERT 时需注意 PostgreSQL 的语句大小限制。将批大小默认设为 50（而非 message_request 的 200）以控制单次 SQL 大小。

**[隐私合规] → 全局开关 + 保留期限**
查询内容可能包含敏感代码或商业信息。提供全局启用/禁用开关，默认关闭。管理员需显式开启。保留期限到期后自动清理。

**[查询关联完整性] → 软关联而非外键约束**
`query_log.message_request_id` 使用软关联（不加 FOREIGN KEY 约束），因为 `message_request` 有独立的清理周期。查询日志可能比对应的 message_request 存活更久或更短。

## Migration Plan (迁移计划)

1. **Schema 变更**: 在 `schema.ts` 中新增 `query_log` 表和 `systemSettings` 的新字段
2. **生成迁移**: `bun run db:generate` 自动生成 SQL
3. **部署顺序**: 先应用数据库迁移，再部署新代码。新字段有默认值，向后兼容
4. **回滚策略**: 功能开关默认关闭。如需回滚，关闭开关即可停止记录。`query_log` 表可安全删除（不影响核心功能）
5. **数据迁移**: 无需迁移历史数据，仅记录功能开启后的新请求

## Open Questions (待确定问题)

- ~~仪表板的使用模式分析具体需要哪些聚合维度？~~ **已确定：按用户维度聚合**（每个用户的查询频率、对话轮次、使用的模型分布等）
- 是否需要按用户级别控制查询记录的启用/禁用？（当前设计仅支持全局开关）
- 查询浏览页面是否需要内容搜索能力？（当前设计仅支持按用户/时间/会话筛选）
