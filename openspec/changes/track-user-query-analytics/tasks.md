## 1. 数据库 Schema 与迁移

- [x] 1.1 在 `src/drizzle/schema.ts` 中新增 `query_log` 表定义（id, message_request_id, user_id, session_id, request_sequence, model, endpoint, query_content, query_format, created_at）及索引（user_id+created_at, session_id+request_sequence, created_at）
- [x] 1.2 在 `src/drizzle/schema.ts` 的 `systemSettings` 表中新增 `enable_query_logging`（boolean, 默认 false）和 `query_log_retention_days`（integer, 默认 30）字段
- [ ] 1.3 运行 `bun run db:generate` 生成迁移文件，检查生成的 SQL 是否正确
- [ ] 1.4 运行 `bun run db:migrate` 应用迁移，验证表和字段创建成功

## 2. 查询内容提取

- [x] 2.1 新增 `src/app/v1/_lib/proxy/query-extractor.ts`，实现统一的查询内容提取函数 `extractUserQuery(session: ProxySession): string | null`，支持 Claude/OpenAI/Codex/Gemini 四种格式
- [x] 2.2 为 `extractUserQuery` 编写单元测试，覆盖四种 API 格式的提取逻辑、无用户消息的边界情况、以及大内容场景

## 3. 异步写入缓冲区

- [x] 3.1 新增 `src/repository/query-log-write-buffer.ts`，实现 `QueryLogWriteBuffer` 类（定时刷新 500ms、批大小 50、队列上限 2000、批量 INSERT、失败重试一次）
- [ ] 3.2 为 `QueryLogWriteBuffer` 编写单元测试，覆盖正常批量写入、队列溢出丢弃、写入失败重试逻辑

## 4. 数据访问层

- [ ] 4.1 新增 `src/repository/query-log.ts`，实现查询日志的 CRUD 操作：插入、按条件查询（用户/时间/会话/模型/端点筛选）、游标分页、批量删除
- [ ] 4.2 新增 `src/repository/query-log-analytics.ts`，实现按用户维度的聚合查询：查询次数时间桶统计、活跃会话数、模型分布、端点分布、用户活跃度排行
- [ ] 4.3 在 `src/repository/system-config.ts` 中扩展设置读写逻辑，支持 `enable_query_logging` 和 `query_log_retention_days` 字段

## 5. 代理管道集成

- [x] 5.1 在 `src/app/v1/_lib/proxy-handler.ts` 中集成查询日志逻辑：在 message_request 创建后检查 `enable_query_logging` 开关，调用 `extractUserQuery` 提取内容，异步入队到 `QueryLogWriteBuffer`
- [x] 5.2 在应用启动入口（instrumentation.ts 或类似位置）初始化 `QueryLogWriteBuffer`，在应用关闭时调用 `stop()` 确保缓冲区刷新

## 6. 定时清理

- [x] 6.1 新增 `src/lib/log-cleanup/query-log-cleanup.ts`，实现 Leader Lock + setInterval 模式的定时清理（每 24 小时、批量 5000 条、读取 `query_log_retention_days` 配置、retention_days=0 时跳过）
- [x] 6.2 在应用启动入口注册查询日志清理任务
- [ ] 6.3 为清理逻辑编写单元测试，覆盖正常清理、多实例互斥、retention_days=0 跳过清理

## 7. Server Actions API

- [ ] 7.1 新增查询浏览相关 Server Action：查询日志列表（支持筛选+游标分页）、查询日志详情
- [ ] 7.2 新增分析聚合相关 Server Action：用户查询统计（按时间范围+时间桶）、用户活跃度排行（支持分页）、模型/端点分布
- [ ] 7.3 新增设置管理相关 Server Action：获取/更新 `enable_query_logging` 和 `query_log_retention_days`

## 8. 国际化

- [ ] 8.1 在 5 种语言的 messages 文件中新增查询浏览页面的翻译键（页面标题、筛选标签、表格列头、空状态提示等）
- [ ] 8.2 在 5 种语言的 messages 文件中新增使用分析仪表板的翻译键（图表标题、时间范围选项、排行榜列头等）
- [ ] 8.3 在 5 种语言的 messages 文件中新增设置页面查询记录配置项的翻译键

## 9. 仪表板前端 - 查询浏览页面

- [ ] 9.1 新增 `src/app/[locale]/dashboard/query-logs/page.tsx`，实现查询浏览页面：筛选栏（用户、时间范围、会话 ID、模型、端点）+ 查询列表表格 + 游标分页
- [ ] 9.2 实现查询内容展示组件：支持展开/收起长文本、JSON 格式化显示
- [ ] 9.3 实现会话对话流查看：点击会话 ID 筛选同一会话的所有查询，按 request_sequence 升序排列

## 10. 仪表板前端 - 使用分析页面

- [ ] 10.1 新增 `src/app/[locale]/dashboard/query-analytics/page.tsx`，实现使用分析仪表板：时间范围选择器 + 查询趋势折线图（Recharts）
- [ ] 10.2 实现用户活跃度排行表格组件（Top N 用户、查询次数、活跃会话数、平均轮次、最近查询时间）
- [ ] 10.3 实现模型使用分布图和端点使用分布图（饼图或柱状图，Recharts）

## 11. 仪表板前端 - 设置页面扩展

- [ ] 11.1 在现有系统设置页面中新增查询记录配置区域：启用/禁用开关 + 保留天数输入框 + 保存按钮

## 12. 测试与验证

- [ ] 12.1 端到端验证：启动开发环境，开启查询记录，发送代理请求，确认 query_log 表中正确记录了查询内容
- [ ] 12.2 验证查询浏览页面的筛选、分页、会话对话流查看功能
- [ ] 12.3 验证使用分析仪表板的图表渲染、时间范围切换、排行榜展示
- [ ] 12.4 验证设置页面的开关和保留天数配置生效
- [ ] 12.5 运行 `bun run build && bun run lint && bun run typecheck && bun run test` 确保全部通过
