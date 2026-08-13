/**
 * 撤销 git 快照模块(2026-08-14 停止与撤销分离)
 *
 * 「撤销」= 原停止的回滚语义:主人输入轮发送前对监控目录拍快照,
 * 撤销时精确还原到该轮之前的状态。
 *
 * 快照采用**临时索引**生成隐藏快照提交——不动用户工作区/真实索引,
 * 只在 refs/island-undo/<id> 私有引用命名空间挂提交防 gc:
 * 1. `rev-parse HEAD` 记 headSha;`ls-files --others` 记未跟踪清单;
 * 2. GIT_INDEX_FILE=<临时文件> read-tree HEAD → add -A → write-tree →
 *    commit-tree -p HEAD:捕获"工作区全量状态(含未跟踪文件)"的快照提交;
 * 3. `update-ref refs/island-undo/<id> <sha>` 钉住防 gc。
 *
 * 回滚(精确还原):
 * 1. `reset --hard <headSha>`(分支回到快照前,该轮提交被丢弃);
 * 2. `restore --source=<快照sha> --worktree -- .`(旧版 git 回退
 *    `checkout <sha> -- .`)把快照时的脏改动覆盖回工作区;
 * 3. 当前未跟踪清单 − 快照未跟踪清单 = 该轮新建文件,逐个删除
 *    (不用 git clean,只删差集,不误伤快照后用户自己新建的文件);
 * 4. 释放私有引用。
 *
 * git 执行器以参数注入(便于测试,仿 napcat 测试模式)。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileP = promisify(execFile)

/** git 执行器(注入式):成功返回 stdout;失败 reject(stderr/错误信息) */
export type GitExec = (args: string[], cwd: string, extraEnv?: Record<string, string>) => Promise<string>

/** 默认 git 执行器(execFile;非零退出码自动 reject) */
export const defaultGitExec: GitExec = async (args, cwd, extraEnv) => {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

/** 单个监控目录的快照/回滚记录 */
export interface UndoDirRecord {
  dir: string
  ok: boolean
  /** 失败原因(非 git 目录/无 git/命令失败等) */
  reason?: string
  /** 快照时的 HEAD(回滚第 1 步 reset 的目标) */
  headSha?: string
  /** 隐藏快照提交 sha(回滚第 2 步还原脏改动的来源) */
  snapSha?: string
  /** 快照时的未跟踪文件清单(回滚第 3 步差集删除的基准) */
  untracked?: string[]
}

/** 一次快照 = id + 各监控目录记录(登记表条目,持久化到主进程 JSON) */
export interface UndoSnapshotRecord {
  id: string
  sessionKey: string
  at: number
  dirs: UndoDirRecord[]
}

/** 私有引用前缀(快照提交只挂这里,不进用户分支/标签命名空间) */
const REF_PREFIX = 'refs/island-undo/'
const undoRef = (id: string) => `${REF_PREFIX}${id}`

function errMsg(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  return String(e?.stderr || e?.message || err)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0]
    ?.slice(0, 200) ?? '未知错误'
}

function parseLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** 逐目录拍快照(单目录失败不影响其余;非 git 目录/无 git 记 ok:false) */
export async function snapshotWatchDirs(
  dirs: string[],
  id: string,
  exec: GitExec = defaultGitExec,
): Promise<UndoDirRecord[]> {
  const out: UndoDirRecord[] = []
  for (const dir of dirs) {
    out.push(await snapshotOneDir(dir, id, exec))
  }
  return out
}

async function snapshotOneDir(dir: string, id: string, exec: GitExec): Promise<UndoDirRecord> {
  // 临时索引文件(快照提交用它生成,绝不碰用户真实索引)
  const tmpIndex = path.join(os.tmpdir(), `island-undo-${id}-${Math.random().toString(36).slice(2, 8)}.index`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  try {
    // ① 基准状态:HEAD + 未跟踪清单
    const headSha = (await exec(['rev-parse', 'HEAD'], dir)).trim()
    const untracked = parseLines(await exec(['ls-files', '--others', '--exclude-standard'], dir))
    // ② 临时索引里重建"工作区全量状态":read-tree 铺 HEAD → add -A
    //    并入脏改动与未跟踪文件 → write-tree 得树对象
    await exec(['read-tree', 'HEAD'], dir, env)
    await exec(['add', '-A'], dir, env)
    const treeSha = (await exec(['write-tree'], dir, env)).trim()
    // ③ 隐藏快照提交(-c 自带身份:用户仓库可能没配 user.name/email);
    //    挂 HEAD 为父,回滚时 reset --hard 回 headSha 即"丢弃该轮"
    const snapSha = (
      await exec(
        [
          '-c', 'user.name=island-undo',
          '-c', 'user.email=island-undo@local',
          'commit-tree', treeSha,
          '-p', headSha,
          '-m', `island-undo snapshot ${id}`,
        ],
        dir,
        env,
      )
    ).trim()
    // ④ 私有引用钉住防 gc(回滚成功后释放)
    await exec(['update-ref', undoRef(id), snapSha], dir)
    return { dir, ok: true, headSha, snapSha, untracked }
  } catch (err) {
    return { dir, ok: false, reason: errMsg(err) }
  } finally {
    fs.promises.unlink(tmpIndex).catch(() => {
      // 临时索引清理失败无害(系统临时目录兜底)
    })
  }
}

/** 逐目录回滚(精确还原到快照前状态;单目录失败不影响其余) */
export async function restoreUndoSnapshot(
  rec: Pick<UndoSnapshotRecord, 'id' | 'dirs'>,
  exec: GitExec = defaultGitExec,
): Promise<UndoDirRecord[]> {
  const out: UndoDirRecord[] = []
  for (const d of rec.dirs) {
    out.push(await restoreOneDir(d, rec.id, exec))
  }
  return out
}

async function restoreOneDir(d: UndoDirRecord, id: string, exec: GitExec): Promise<UndoDirRecord> {
  if (!d.ok || !d.headSha || !d.snapSha) {
    return { ...d, ok: false, reason: d.reason ?? '快照不完整,无法回滚' }
  }
  try {
    // ① 分支与工作区回到快照前(该轮内的提交被丢弃)
    await exec(['reset', '--hard', d.headSha], d.dir)
    // ② 快照时的脏改动覆盖回工作区(restore 优先;旧版 git 无 restore
    //    命令回退 checkout——checkout 会把改动入索引,③ 复位索引兜底)
    try {
      await exec(['restore', `--source=${d.snapSha}`, '--worktree', '--', '.'], d.dir)
    } catch {
      await exec(['checkout', d.snapSha, '--', '.'], d.dir)
      // 索引复位到 HEAD(mixed,不动工作区)——只还原工作区脏改动,
      // 不把改动留在暂存区
      try {
        await exec(['reset'], d.dir)
      } catch {
        // 复位失败不影响工作区还原结果
      }
    }
    // ③ 该轮新建文件差集删除:当前未跟踪 − 快照未跟踪(不用 git clean,
    //    只删差集——快照后用户在其它轮新建的文件不受影响)
    const snapSet = new Set(d.untracked ?? [])
    const current = parseLines(await exec(['ls-files', '--others', '--exclude-standard'], d.dir))
    for (const rel of current) {
      if (snapSet.has(rel)) continue
      await fs.promises.unlink(path.join(d.dir, rel)).catch(() => {
        // 单文件删除失败(已移动/占用)跳过,不阻断整体回滚
      })
    }
    // ④ 释放私有引用(快照使命完成)
    await releaseUndoRef(d.dir, id, exec)
    return { ...d, ok: true, reason: undefined }
  } catch (err) {
    return { ...d, ok: false, reason: errMsg(err) }
  }
}

/** 释放快照私有引用(超额淘汰/回滚成功后调;尽力而为不抛错) */
export async function releaseUndoRef(dir: string, id: string, exec: GitExec = defaultGitExec): Promise<void> {
  try {
    await exec(['update-ref', '-d', undoRef(id)], dir)
  } catch {
    // 引用可能已释放(重复回滚/仓库已删)——尽力而为
  }
}

