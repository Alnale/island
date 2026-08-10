/**
 * 通用快捷菜单(2026-08-07,参考 Agent 设置菜单条设计抽离):
 * - **整合按钮**(当前项 + ▾)+ **同行联通展开**(悬浮滑入,一体胶囊,
 *   非独立气泡——像按钮展开成子菜单);
 * - **滚轮逐格循环切换**(useWheelSteps + WheelSwap 内容交换动画,
 *   open 时默认不响应滚轮——选项浮层是当时的交互面,可 wheelWhenOpen 放开);
 * - **高亮滑块指示器**(绝对定位,left/width 0.32s 无过冲过渡平滑滑动,
 *   选中项 offsetLeft/offsetWidth 布局值不受滑入 transform 影响);
 * - **按钮宽度过渡**(in 层 scrollWidth + CSS 计算值 gap/padding/border +
 *   箭头宽,向上取整——完整内容测量防 flex 收缩累积,详见注释);
 * - **展开方向**:right(按钮右侧,默认)/ left(按钮左侧,右上角菜单用);
 * - **onExpandChange** 回调:展开状态变化(记忆输入框宽度随菜单占位
 *   flex 收缩联动——flex 布局天然实时调整,回调供父组件额外处理)。
 *
 * 复用:Agent 设置菜单 / 记忆类型下拉 / Agent ⋯ 菜单 / 帮助手册模式按钮
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type WheelEvent,
} from 'react'
import { useWheelSteps } from '../../../hooks/useWheelSteps'
import { useWheelSwap } from '../../../hooks/useWheelSwap'
import { WheelSwap } from './WheelSwap'

export function QuickMenu<T>({
  items,
  value,
  onChange,
  getLabel,
  onSelect,
  onExpandChange,
  direction = 'right',
  className = '',
  title,
  wheelWhenOpen = false,
  buttonAction = 'toggle',
  allowCustom,
  min,
  max,
  compare,
}: {
  /** 选项列表 */
  items: readonly T[]
  /** 当前选中项 */
  value: T
  /** 选中变化(滚轮切换 / 点击菜单项切换) */
  onChange: (next: T) => void
  /** 选项渲染(按钮 WheelSwap 与菜单项共用;可含图标/徽标) */
  getLabel: (item: T) => ReactNode
  /** 点击菜单项时额外执行(如 ⋯ 菜单项动作);仅点击触发,滚轮切换不触发 */
  onSelect?: (item: T) => void
  /** 展开状态变化回调(记忆输入框宽度联动等) */
  onExpandChange?: (open: boolean) => void
  /** 展开方向:right = 按钮右侧(默认)/ left = 按钮左侧(右上角菜单) */
  direction?: 'right' | 'left'
  /** 容器附加类(定位/尺寸定制) */
  className?: string
  title?: string
  /** 展开状态下滚轮是否仍切换(默认 false:展开时选项浮层是交互面;
   *  悬浮交互面菜单(设置/预算/⋯/help)传 true */
  wheelWhenOpen?: boolean
  /**
   * 按钮点击行为(2026-08-07):'toggle' = 展开/收起(默认);
   * 'run' = **单击执行当前选中项**(⋯ 菜单:滚轮切换选中后单击快捷按钮
   * 即执行——原 QuickMenu 按钮只 toggle,用户实测"单击无响应").
   * 'run' 时展开完全由悬浮驱动
   */
  buttonAction?: 'toggle' | 'run'
  /**
   * 允许自定义值(2026-08-08 输出预算):单击按钮进入**内联编辑**
   * (替代 toggle——展开完全由悬浮驱动),Enter/失焦提交(钳制
   * min–max)、Esc 取消;提交值不在 items 时菜单无高亮、按钮显示
   * 当前值,滚轮经 compare 切到相邻档位
   */
  allowCustom?: boolean
  /** allowCustom 的提交钳制范围 */
  min?: number
  max?: number
  /**
   * 可选项排序比较器(allowCustom 且 value 不在 items 时,滚轮从
   * 当前值切到相邻档位用;缺省无比较器时值不在档位滚轮不切换)
   */
  compare?: (a: T, b: T) => number
}) {
  const swap = useWheelSwap<T>()
  const wheelSteps = useWheelSteps()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)
  // 内联编辑(allowCustom,2026-08-08 输出预算):单击按钮进入,
  // Enter/失焦提交(钳制 min–max)、Esc 取消;编辑态菜单不展开
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) {
      editRef.current?.focus()
      editRef.current?.select()
    }
  }, [editing])
  const editingRef = useRef(editing)
  editingRef.current = editing
  const commitEdit = () => {
    const v = Number(draft)
    if (Number.isFinite(v) && min !== undefined && max !== undefined) {
      const clamped = Math.min(max, Math.max(min, Math.round(v))) as T
      if (clamped !== value) {
        // 方向与数值一致(动画方向正确);比较经 compare(泛型不可直比)
        swap.step(value, compare && compare(clamped, value) > 0 ? 1 : -1)
        onChange(clamped)
      }
    }
    setEditing(false)
  }
  const cancelEdit = () => setEditing(false)
  // dir-left 一体胶囊背景层宽度(2026-08-07 用户要求"参考 Agent 设置菜单
  // 的连通背景"):pop 溢出容器左缘,容器自身背景盖不到——独立 shell 层
  // absolute 从按钮区延伸覆盖 pop 区域(左缘 = -popW),同一元素画背景+
  // 描边,连接处绝对无缝(pop 自画背景两段相接有亚像素接缝,实测观感)
  const [popW, setPopW] = useState(0)
  useLayoutEffect(() => {
    if (direction !== 'left') return
    const pop = wrapRef.current?.querySelector<HTMLElement>('.island-quick-menu-pop')
    if (!pop) return
    setPopW(pop.offsetWidth)
  }, [direction, open, items])
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
    onExpandChange?.(open)
  }, [open, onExpandChange])
  // 吞容器内滚轮的默认滚动(设置视图/聊天是滚动容器,不吞会整页跟滚;
  // React onWheel 为 passive 无法 preventDefault——ScaleStepper 同款)。
  // **展开/编辑态也拦截(2026-08-10 修复"记忆类型按钮只能向上不能向下"):
  // 记忆类型按钮悬浮即展开(onMouseEnter),原实现 open 时放行默认滚动
  // ——向下滚轮(form 内容向下滚)抢在切换前生效,表现为"触发整体向下";
  // 容器内滚轮一律拦截,切换与否由 React handleWheel 按 wheelWhenOpen
  // 决定(展开时逐格切换),默认滚动永不触发
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onNativeWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault()
    }
    el.addEventListener('wheel', onNativeWheel, { passive: false })
    return () => el.removeEventListener('wheel', onNativeWheel)
  }, [])
  // 按钮宽度过渡(完整内容测量 + 向上取整,防 flex 收缩累积——
  // Agent 设置菜单同款,三次修复实录见该处注释):
  // ① 切换瞬间按钮宽 = 旧显式宽,in 层被 overflow:hidden 裁剪,
  //    scrollWidth 返回完整内容宽(不受压缩影响)
  // ② 全局 box-sizing: border-box,in 层 scrollWidth 只是纯文字宽,
  //    总宽需叠加 gap + 箭头 + padding + border(CSS 计算值防硬编码漂移)
  // ③ scrollWidth 取整向下丢小数 + flex-shrink 收缩累积 → 越滚越窄;
  //    每次从完整内容重算 + Math.ceil(总宽 ≥ 内容,flex 不收缩,无累积)
  // ④ 编辑态(2026-08-09 allowCustom 内联输入):测量目标换输入框——
  //    输入框按 draft 内容宽(ch)自定宽,scrollWidth = max(元素宽,
  //    文字宽),按钮随输入内容展开/收缩(宽度过渡动画保留,数字左
  //    锚定只动右缘不跳位);提交后回测新标签
  useLayoutEffect(() => {
    const btn = btnRef.current
    if (!btn) return
    const inEl =
      btn.querySelector<HTMLElement>('.island-wheel-swap-in') ??
      btn.querySelector<HTMLInputElement>('input')
    const arrow = btn.querySelector<HTMLElement>('.island-quick-menu-arrow')
    if (!inEl) return
    const cs = getComputedStyle(btn)
    const gap = parseFloat(cs.gap) || 0
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
    const borderX = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0)
    const arrowW = arrow ? arrow.scrollWidth : 0
    btn.style.width = `${Math.ceil(inEl.scrollWidth + gap + arrowW + padX + borderX)}px`
  }, [value, open, editing, draft])
  // 高亮滑块:选中项 offsetLeft/offsetWidth(布局值,不受滑入 transform 影响)
  useLayoutEffect(() => {
    const pop = wrapRef.current?.querySelector('.island-quick-menu-pop')
    const itemsEl = pop ? [...pop.querySelectorAll<HTMLElement>('.island-quick-menu-item')] : []
    const idx = items.findIndex((it) => it === value)
    const item = itemsEl[idx]
    if (!pop || !item) return
    setIndicator({ left: item.offsetLeft, width: item.offsetWidth })
  }, [value, open, items])
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const step = wheelSteps(event)
    if (!step || (open && !wheelWhenOpen) || editing) return
    let idx = items.findIndex((it) => it === value)
    if (idx === -1) {
      // 自定义值不在档位(2026-08-08):经 compare 从当前值切到相邻
      // 档位(向上 → 最近更大档位,向下 → 最近更小档位);无比较器
      // 时维持旧行为(不切换)。切到档位后即进入正常循环
      if (!compare) return
      let lo = 0
      let hi = items.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (compare(items[mid], value) < 0) lo = mid + 1
        else hi = mid
      }
      if (step > 0) {
        if (lo >= items.length) return // 已是最上档位,向上无档位
        idx = lo
      } else {
        if (lo <= 0) return // 已是最下档位,向下无档位
        idx = lo - 1
      }
    }
    const next = items[(idx + step + items.length) % items.length]
    swap.step(value, step)
    onChange(next)
  }
  const valueIdx = items.findIndex((it) => it === value)
  return (
    <div
      ref={wrapRef}
      className={`island-quick-menu${open ? ' open' : ''}${direction === 'left' ? ' dir-left' : ''}${className ? ` ${className}` : ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onWheel={handleWheel}
    >
      {/* dir-left 一体胶囊背景层(在按钮/pop 之下,自身透明内容不参与
          布局):open 时画整块背景+描边,覆盖 [pop 区域 + 按钮] 一个
          整体胶囊——连接处无缝(两段背景相接有亚像素接缝) */}
      {direction === 'left' ? (
        <span
          className="island-quick-menu-shell"
          style={{ '--shell-pop-w': `${popW}px` } as CSSProperties}
          aria-hidden="true"
        />
      ) : null}
      {/* 整合按钮(当前项 + ▾):悬浮时菜单项在同一行滑入(容器后代联通一体) */}
      <button
        ref={btnRef}
        type="button"
        className="island-quick-menu-btn"
        title={title}
        onClick={(event) => {
          event.stopPropagation()
          // 'run' 模式(⋯ 菜单):单击 = 执行当前选中项(展开完全由悬浮
          // 驱动;执行后由调用方复位默认)
          if (buttonAction === 'run') {
            onSelect?.(value)
            return
          }
          // allowCustom(输出预算):单击 = 内联编辑自定义值(展开完全
          // 由悬浮驱动——悬浮展开档位、点击输入自定义,互不冲突)
          if (allowCustom) {
            setDraft(String(value))
            setEditing(true)
            return
          }
          setOpen((v) => !v)
        }}
      >
        {allowCustom && editing ? (
          <input
            ref={editRef}
            type="text"
            inputMode="numeric"
            value={draft}
            spellCheck={false}
            /* 宽度 = 内容宽(2026-08-09 修复"编辑截断"):按 draft 字数
               ch 自定宽(数字 ≈1ch,0.5ch 余量放光标),按钮宽度 effect
               同步测量展开——完整文本始终可见,不滚动不截断;数字
               左锚定,宽度变化只动右缘 */
            style={{ width: `${Math.max(2, draft.length + 0.5)}ch` }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') cancelEdit()
            }}
          />
        ) : (
          <WheelSwap tick={swap.tick} dir={swap.dir} prev={swap.prev != null ? getLabel(swap.prev) : null}>
            {getLabel(value)}
          </WheelSwap>
        )}
        <span className="island-quick-menu-arrow" aria-hidden="true">
          ▾
        </span>
      </button>
      {/* 菜单项:同行展开(一体胶囊);高亮滑块 absolute 在菜单项之下 */}
      <div className="island-quick-menu-pop" aria-hidden={!open}>
        <span
          className="island-quick-menu-indicator"
          style={indicator ? { left: indicator.left, width: indicator.width } : undefined}
          aria-hidden="true"
        />
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            tabIndex={open ? 0 : -1}
            className={`island-quick-menu-item${item === value ? ' on' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              if (item !== value) {
                swap.step(value, i > valueIdx ? 1 : -1)
                onChange(item)
              }
              onSelect?.(item)
              setOpen(false)
            }}
          >
            {getLabel(item)}
          </button>
        ))}
      </div>
    </div>
  )
}
