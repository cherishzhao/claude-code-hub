## ADDED Requirements

### Requirement: query_log 数据表
系统 SHALL 提供独立的 `query_log` 表，用于存储用户查询内容。表 SHALL 包含以下字段：
- `id`: 自增主键
- `message_request_id`: 关联的 message_request 记录 ID（软关联，无外键约束）
- `user_id`: 用户 ID
- `session_id`: 会话 ID
- `request_sequence`: 请求在会话中的序号
- `model`: 请求使用的模型名称
- `endpoint`: API 端点路径
- `query_content`: 用户查询原文（`text` 类型，不设长度限制）
- `query_format`: 请求的 API 格式（claude/openai/codex/gemini）
- `created_at`: 记录创建时间（带时区）

表 SHALL 创建以下索引：
- `user_id` + `created_at` 复合索引（按用户查询的热路径）
- `session_id` + `request_sequence` 复合索引（还原会话对话流）
- `created_at` 索引（定时清理的热路径）

#### Scenario: 查询日志记录创建
- **WHEN** 一次代理请求通过 guard 管道且查询记录功能已启用
- **THEN** 系统在 `query_log` 表中创建一条记录，包含完整的用户查询原文和关联的请求元数据

#### Scenario: 大内容查询记录
- **WHEN** 用户发送的查询内容超过 100KB
- **THEN** 系统 SHALL 完整记录该查询内容，不做截断或摘要

### Requirement: 用户查询内容提取
系统 SHALL 从每次代理请求中提取最后一条 role=user 的消息内容作为查询原文。提取 SHALL 支持所有 API 格式：
- Claude/OpenAI: 从 `messages` 数组中过滤 `role="user"` 的消息，取最后一条的 `content` 字段
- Codex: 从 `input` 数组中取最后一个元素
- Gemini: 从 `contents` 或 `request.contents` 数组中过滤 `role="user"` 的消息，取最后一条的 `parts` 字段

提取结果 SHALL 以 JSON 字符串形式存储，保留原始数据结构（包括图片引用、工具调用等复合内容）。

#### Scenario: Claude 格式查询提取
- **WHEN** 收到 Claude 格式的请求，`messages` 数组包含多条消息
- **THEN** 系统提取最后一条 `role="user"` 的消息的 `content` 字段，JSON 序列化后存入 `query_content`

#### Scenario: OpenAI 格式查询提取
- **WHEN** 收到 OpenAI 格式的请求，`messages` 数组包含多条消息
- **THEN** 系统提取最后一条 `role="user"` 的消息的 `content` 字段，JSON 序列化后存入 `query_content`

#### Scenario: Codex 格式查询提取
- **WHEN** 收到 Codex Response API 格式的请求，`input` 数组包含多个元素
- **THEN** 系统提取 `input` 数组的最后一个元素，JSON 序列化后存入 `query_content`

#### Scenario: Gemini 格式查询提取
- **WHEN** 收到 Gemini 格式的请求，`contents` 数组包含多条消息
- **THEN** 系统提取最后一条 `role="user"` 的消息的 `parts` 字段，JSON 序列化后存入 `query_content`

#### Scenario: 无用户消息的请求
- **WHEN** 请求体中不包含任何 role=user 的消息（如纯 system 消息或空消息数组）
- **THEN** 系统 SHALL 跳过该请求的查询记录，不创建 `query_log` 条目

### Requirement: 异步非阻塞写入
系统 SHALL 通过独立的 `QueryLogWriteBuffer` 异步批量写入查询日志，确保不影响代理请求的响应延迟。写入缓冲区 SHALL：
- 使用定时刷新机制（默认 500ms 间隔）
- 使用批量 INSERT（默认每批 50 条）
- 在队列溢出时丢弃最旧的记录（默认队列上限 2000 条）
- 写入失败时重试一次，仍失败则丢弃并记录错误日志

#### Scenario: 正常批量写入
- **WHEN** 查询日志缓冲区中累积了多条待写入记录且定时器触发刷新
- **THEN** 系统通过单条批量 INSERT SQL 将所有待写入记录写入 `query_log` 表

#### Scenario: 写入失败重试
- **WHEN** 批量 INSERT 因数据库错误失败
- **THEN** 系统重试一次；若仍失败则丢弃该批次并通过 logger.error 记录错误信息

#### Scenario: 队列溢出保护
- **WHEN** 缓冲区中待写入记录超过上限（默认 2000 条）
- **THEN** 系统丢弃最旧的记录以保持队列大小在上限内

### Requirement: 提取时机
系统 SHALL 在 guard 管道通过后、请求转发前提取查询内容并异步入队。具体时机为 `message_request` 记录创建之后，此时 `session.messageContext` 已包含 `message_request_id`。

#### Scenario: 请求转发前提取
- **WHEN** guard 管道通过且 `message_request` 记录已创建
- **THEN** 系统立即从请求体中提取查询内容，异步入队到 `QueryLogWriteBuffer`，不阻塞后续转发流程

#### Scenario: 上游请求失败仍记录查询
- **WHEN** 查询内容已入队但上游供应商返回错误或超时
- **THEN** 查询日志 SHALL 仍然被写入（因为提取发生在转发之前）

### Requirement: 全局启用/禁用开关
系统 SHALL 在 `systemSettings` 表中新增 `enable_query_logging` 布尔字段（默认值 `false`）。仅当该开关为 `true` 时，系统才执行查询内容提取和存储。

#### Scenario: 功能默认关闭
- **WHEN** 系统首次部署或升级后未修改设置
- **THEN** `enable_query_logging` 为 `false`，不记录任何查询内容

#### Scenario: 管理员启用查询记录
- **WHEN** 管理员在仪表板设置页面将 `enable_query_logging` 设为 `true`
- **THEN** 后续所有代理请求的查询内容 SHALL 被提取和记录

#### Scenario: 管理员禁用查询记录
- **WHEN** 管理员将 `enable_query_logging` 设为 `false`
- **THEN** 系统立即停止提取和记录查询内容；已存储的历史记录不受影响

### Requirement: 数据保留与定时清理
系统 SHALL 在 `systemSettings` 表中新增 `query_log_retention_days` 整数字段（默认值 `30`）。系统 SHALL 通过 Leader Lock + setInterval 模式定时清理过期的查询日志。

清理任务 SHALL：
- 每 24 小时执行一次
- 使用分布式 Leader Lock 保证多实例环境下仅一个实例执行
- 批量删除 `created_at` 早于保留期限的记录（每批 5000 条）
- 清理完成后释放锁

#### Scenario: 定时清理过期记录
- **WHEN** 清理定时器触发且当前实例获得 Leader Lock
- **THEN** 系统批量删除所有 `created_at` 早于 `当前时间 - query_log_retention_days` 的记录

#### Scenario: 多实例清理互斥
- **WHEN** 多个应用实例同时触发清理定时器
- **THEN** 仅获得 Leader Lock 的实例执行清理，其他实例跳过本轮

#### Scenario: 保留期限为 0 表示不清理
- **WHEN** `query_log_retention_days` 设为 `0`
- **THEN** 系统 SHALL 跳过清理任务，永久保留所有查询日志
