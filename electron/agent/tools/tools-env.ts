/**
 * 工具路径环境簇(内置工具根目录 / 用户数据目录 / 工具输出目录环境)
 *
 * 十期自 tools.ts 下沉:tools-bili / tools-docflow / tools.ts 三方共用,
 * 独立成簇避免循环依赖;tools.ts barrel 兼容 re-export。
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

/**
 * 内置工具根目录(2026-08-07 三个外部工具移植进 tools/):
 * 项目根 tools/(cwd = 项目根;不用 __dirname —— agent.cjs
 * 是 CJS 而测试 bundle 是 ESM,__dirname 在 ESM 下不可用(实测报错))
 */
export function toolsRoot(): string {
  const res = process.resourcesPath ? path.join(process.resourcesPath, 'tools') : ''
  return res && existsSync(res) ? res : path.resolve(process.cwd(), 'tools')
}


/** 用户数据目录(可写;bili 下载落点 / xxt 登录态 / docflow 运行时产物;
 * = %APPDATA%/dynamic-island;测试回退临时路径) */
export function userDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    return path.join(process.env.APPDATA ?? os.homedir(), 'dynamic-island')
  }
}

/**
 * 工具输出目录环境(2026-08-12,引擎经 createTools deps 注入):
 * - getOutputDir = Agent 配置的工具输出根目录(空 = 未启用,工具保持
 *   默认位置 userData 下);
 * - getSessionId = 当前会话 ID(send/proactiveTurn 更新)。
 * 目录结构 = <根>/<工具名>/[<会话ID>]——每工具文件夹分类、文件按
 * 对话 ID 分类(用户要求);会话 ID 缺失(测试/历史调用)回退
 * <根>/<工具名>。write_file/exec_command 是用户指定路径的写入,
 * 不重定向,只有工具自产文件(bili 下载 / xxt 截图 / doc_convert 输出)
 * 走本机制
 */
let outputEnv: { getOutputDir: () => string | null; getSessionId: () => string | null } = {
  getOutputDir: () => null,
  getSessionId: () => null,
}

/** 工具输出目录解析(测试导出):未配置根目录返回 null,否则
 * <根>/<工具名>/[<会话ID>](会话 ID 缺失落在 <根>/<工具名>) */
export function toolOutputDir(tool: string): string | null {
  const root = outputEnv.getOutputDir()
  if (!root) return null
  const base = path.join(root, tool)
  const sid = outputEnv.getSessionId()
  return sid ? path.join(base, sid) : base
}

/** 输出目录环境注入(createTools 时调用;模块级,工具执行时读取) */
export function setOutputEnv(env: { getOutputDir: () => string | null; getSessionId: () => string | null }): void {
  outputEnv = env
}
