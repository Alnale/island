/**
 * 工具组插件(Consumer:消费 ctx.tools / ctx.llm 接缝)
 *
 * 每个插件一组工具,平行挂载;挂载顺序 = 工具列表呈现顺序。
 * 纪律:
 * - inject ['tools', ...],宿主可选能力以值探测决定激活与否
 *   (保持"未注入则不注册"的既有语义);
 * - 一切注册经 ctx.effect,引擎 dispose 时逆序回滚;
 * - 新增工具组 = 平行挂载一个新插件,不改 loop、不改其他插件。
 */

import { createTools, disposeTools } from '../tools/tools'
import { createMusicControlTools, createSettingsTools } from '../tools/settingsTools'
import { createSessionTools } from '../tools/sessionTools'
import { createNapcatTools } from '../napcat/napcat'
import { createMemoryTools } from '../memory'
import { createConfigTools } from '../tools/configTools'
import { createBuiltinTools } from '../engine/engine-builtins'
import { createDelegateTool } from '../engine/engine-tool-execution'
import { getTaskDoneHandler, setTaskDoneHandler } from '../tasks'
import { toolExecHooksOf } from './tool-events'
import type { AgentContext, Plugin } from './kernel'

/** 核心工具组(exec_command / bili / 文件 / 模式切换等) */
export function coreToolsPlugin(): Plugin {
  return {
    name: 'tools-core',
    inject: ['tools', 'events', 'confirm', 'switchToMusic', 'sessionState', 'config'],
    apply(ctx: AgentContext) {
      const tools = ctx.get('tools')
      tools.registerTools(
        createTools({
          onSwitchToMusic: ctx.get('switchToMusic'),
          // **2026-08-16 修复"完成通知串会话"**:事件带任务发起会话键
          // (task.sessionKey)——引擎 emit 闭包对显式 sessionKey 透传,
          // 不再用本引擎 currentSessionKey 覆盖(多引擎并存时本引擎未必
          // 是发起下载的那个);渲染端按键只让发起会话的实例处理
          onBackgroundDone: (info) =>
            ctx.get('events').emit({ type: 'background-done', ...info }),
          confirmAction: ctx.get('confirm').confirmAction,
          getOutputDir: () => ctx.get('config').getConfig().outputDir?.trim() || null,
          getSessionId: () => ctx.get('sessionState').getSessionId(),
          // 后台任务注册时的发起会话键(2026-08-16)
          getSessionKey: () => ctx.get('sessionState').getSessionKey(),
          // 智谱 GLM 云端文档工具凭据(2026-08-19:glm_ocr / glm_file_parse):
          // 实时读 providers.glm 桶,与激活供应商无关;Key 空返回 null
          // (工具执行时报错引导,不隐藏工具)
          getGlmCreds: () => {
            const glm = ctx.get('config').getConfig().providers?.glm
            return glm && glm.apiKey.trim() ? { apiKey: glm.apiKey, baseURL: glm.baseURL } : null
          },
        }),
      )
      // docflow 常驻子进程随引擎销毁回收;**doneHandler 恢复链
      // (2026-08-16)**:任务终态回调是 tasks.ts 模块级单例,本插件装配
      // 时接管;引擎被 dispose(会话上限淘汰等)时恢复上一个 handler——
      // 否则回调指向已销毁的 ctx,emit 抛错 = 任务完成通知丢失
      const prevDoneHandler = getTaskDoneHandler()
      return () => {
        disposeTools()
        setTaskDoneHandler(prevDoneHandler)
      }
    },
  }
}

/** 灵动岛设置工具(宿主桥未注入则不激活) */
export function settingsToolsPlugin(): Plugin {
  return {
    name: 'tools-island-settings',
    inject: ['tools', 'islandSettings'],
    apply(ctx: AgentContext) {
      const run = ctx.get('islandSettings')
      if (!run) return
      ctx.get('tools').registerTools(createSettingsTools({ runIslandSettings: run }))
    },
  }
}

/** NapCat QQ 工具(宿主桥未注入则不激活) */
export function napcatToolsPlugin(): Plugin {
  return {
    name: 'tools-napcat',
    inject: ['tools', 'napcatClient', 'sessionState', 'confirm'],
    apply(ctx: AgentContext) {
      const client = ctx.get('napcatClient')
      if (!client) return
      ctx.get('tools').registerTools(
        createNapcatTools({
          client,
          getSessionKey: () => ctx.get('sessionState').getSessionKey(),
          confirmDangerous: ctx.get('confirm').confirmAction,
        }),
      )
    },
  }
}

/** 音乐控制工具(宿主桥未注入则不激活) */
export function musicToolsPlugin(): Plugin {
  return {
    name: 'tools-music-control',
    inject: ['tools', 'musicControl'],
    apply(ctx: AgentContext) {
      const run = ctx.get('musicControl')
      if (!run) return
      ctx.get('tools').registerTools(createMusicControlTools(run))
    },
  }
}

/** 会话管理工具(set_session_note / clear_session_context) */
export function sessionToolsPlugin(): Plugin {
  return {
    name: 'tools-session',
    inject: ['tools', 'sessionBridge', 'sessionState'],
    apply(ctx: AgentContext) {
      const bridge = ctx.get('sessionBridge')
      if (!bridge) return
      ctx.get('tools').registerTools(
        createSessionTools({
          getSessionKey: () => ctx.get('sessionState').getSessionKey(),
          getNote: bridge.getNote,
          setNote: bridge.setNote,
          clearContext: bridge.clearContext,
        }),
      )
    },
  }
}

/** delegate 子代理工具(经工具接缝取全量工具,经 llm 接缝做流式调用;
 *  执行链钩子与主循环同享 tools/pre-execute + post-execute 扩展点) */
export function delegateToolPlugin(): Plugin {
  return {
    name: 'tools-delegate',
    inject: ['tools', 'config', 'outputBudget', 'llm'],
    apply(ctx: AgentContext) {
      ctx.get('tools').register(
        createDelegateTool({
          getConfig: () => ctx.get('config').getConfig(),
          getOutputBudget: () => ctx.get('outputBudget').value,
          getAllTools: () => ctx.get('tools').listTurn(),
          stream: (params) => ctx.get('llm').stream(params),
          hooks: toolExecHooksOf(ctx),
        }),
      )
    },
  }
}

/** 记忆工具(记忆存储未注入则不激活) */
export function memoryToolsPlugin(): Plugin {
  return {
    name: 'tools-memory',
    inject: ['tools', 'memoryStore'],
    apply(ctx: AgentContext) {
      if (!ctx.get('memoryStore')) return
      ctx.get('tools').registerTools(createMemoryTools(() => ctx.get('memoryStore')))
    },
  }
}

/** LLM 自我配置工具(mcp_config / skills_config / set_owner_qq 等) */
export function configToolsPlugin(): Plugin {
  return {
    name: 'tools-config',
    inject: ['tools', 'config', 'mcpManager', 'skillLoader', 'ownerConfig'],
    apply(ctx: AgentContext) {
      ctx.get('tools').registerTools(
        createConfigTools({
          getConfig: () => ctx.get('config').getConfig(),
          updateAgentConfig: ctx.get('updateConfig'),
          testMcp: (server) => ctx.get('mcpManager').test(server),
          listSkills: (dirs, excluded) =>
            ctx.get('skillLoader').listTools(dirs, excluded, [ctx.get('skillDir')?.() ?? '']),
          getSkillDir: ctx.get('skillDir') ?? undefined,
          listAllTools: () => ctx.get('tools').builtin(),
          ownerConfig: ctx.get('ownerConfig'),
        }),
      )
    },
  }
}

/** 内置专属工具(输出预算 / 记忆进化 / 余额查询) */
export function builtinToolsPlugin(): Plugin {
  return {
    name: 'tools-builtin',
    inject: ['tools', 'config', 'outputBudget', 'evolution'],
    apply(ctx: AgentContext) {
      ctx.get('tools').registerTools(
        createBuiltinTools(ctx.get('outputBudget'), {
          getConfig: () => ctx.get('config').getConfig(),
          getEvolution: () => ctx.get('evolution'),
          updateAgentConfig: ctx.get('updateConfig'),
        }),
      )
    },
  }
}

/** 外部工具源(MCP + 技能)注册为动态源:每步实时解析 */
export function externalToolsSourcePlugin(): Plugin {
  return {
    name: 'tools-external-source',
    inject: ['tools', 'externalTools'],
    apply(ctx: AgentContext) {
      ctx.get('tools').registerSource(ctx.get('externalTools'), 'external(mcp+skills)')
    },
  }
}
