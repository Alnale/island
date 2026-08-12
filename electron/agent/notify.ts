/**
 * 系统通知统一出口(2026-08-13,补丁版 Electron 主进程 Notification 崩溃规避)
 *
 * **背景(实测)**:自编译 HEVC Electron(C:\electron-hevc-dist)主进程里
 * `new Notification().show()`(Chromium toast)与并发网络活动(NapCat WS/
 * LLM 流式)组合时稳定触发 EXCEPTION_ACCESS_VIOLATION——单独触发
 * toast 不崩(最小复现 3 秒存活)、关掉 toast 后真实 QQ 流量 2/2 轮 90s
 * 稳定;官方二进制无此问题(用户日常副本稳定)。崩溃栈 llhttp_message_
 * needs_eof 为堆损坏后的殃及表象,真源是自定义构建里 toast 原生路径的
 * 内存问题。托盘气泡 tray.displayBalloon(Shell_NotifyIcon 老通道,
 * Win10+ 由 shell 转为 toast 样式展示)走完全不同的原生路径,与网络
 * 活动组合实测稳定。
 *
 * **设计**:本模块提供 showNotify(title, body) 统一出口——主进程
 * (main.cjs)启动时经 setNotificationShower 注入托盘气泡实现;未注入
 * (测试/独立运行)回退原生 Notification(测试断言依赖 electron stub
 * 的 Notification 记录,行为不变)。
 */

import { Notification } from 'electron'

type NotifyFn = (title: string, body: string) => void

let shower: NotifyFn | null = null

/** 注入自定义通知实现(main.cjs 启动时调用:托盘气泡通道) */
export function setNotificationShower(fn: NotifyFn | null): void {
  shower = fn
}

/** 发系统通知(统一出口);失败静默(通知是增强功能,不阻断主流程) */
export function showNotify(title: string, body: string): void {
  try {
    if (shower) {
      shower(title, body)
      return
    }
    new Notification({ title, body }).show()
  } catch {
    // 通知失败忽略
  }
}
