/**
 * 【已退役 2026-09-22】主人指纹真实 API 服从性测试
 *
 * 本测试原用于验证 LLM 是否遵守【主人指纹:xxx】文本前缀协议(2026-08-15
 * 双指纹机制)。2026-09-22 归属指纹重设计(用户定案四规则)后,整套文本
 * 标记协议退役:回复归属由触发来源在程序入口判定,LLM 不写不读任何指纹
 * 标记,路由正确性不再依赖 LLM 服从性——本测试验证的前提不存在了。
 *
 * 现行验证资产:
 * - tests/test-agent-core.mjs:classifyTurn/isDirectedToBot/isReplyInstruction/
 *   looksLikeMasterAddressed 等归属纯函数矩阵(276 用例)
 * - tests/screenshot-tests.cjs session-debug 模式:mock LLM + 假 OneBot 端到端
 *   (场景 E/F/J = 询问轮 / 默认送达 / 安全网路由)
 *
 * 运行本文件仅打印退役说明并退出 0(保留文件名防旧文档/脚本引用报错)。
 */
console.log('[master-fp-test] 已退役(2026-09-22 归属指纹重设计):主人指纹文本协议不再存在,')
console.log('[master-fp-test] 路由由触发来源程序判定,无需验证 LLM 指纹服从性。')
console.log('[master-fp-test] 现行验证 = node tests/test-agent-core.mjs + session-debug 巡检。')
process.exit(0)
