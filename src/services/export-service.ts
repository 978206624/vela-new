/**
 * 导出服务 — 将小说项目导出为多种格式
 *
 * 支持：
 * - 合并 Markdown（全书合并为单个 .md）
 * - 分章 Markdown（每章一个 .md）
 * - 纯文本 TXT
 */
import { ipc } from './ipc-client'
import { useProjectStore } from '../stores/project-store'
import { useWorkflowStore } from '../stores/workflow-store'
import { getProjectToken } from '../stores/volume-store'
import type { VolumeData } from '../../electron/repositories/volume-repository'


export type ExportFormat = 'merged-md' | 'split-md' | 'txt'

/**
 * 导出范围。缺省 `'book'`，与分卷前行为完全一致（老调用点不传即可）。
 * `'volume'` 必须同时给 `volumeNumber`。
 */
export type ExportScope = 'book' | 'volume'

interface ExportOptions {
  format: ExportFormat
  outputDir: string
  includeOutline?: boolean
  /**
   * ⚠️ 已知局限（**分卷前就如此**，非本次引入）：`includeOutline` 目前只对
   * `merged-md` 生效，`split-md` 与 `txt` 会忽略它。分卷只是让这条局限更容易被察觉
   * （按卷导出时用户更可能勾选它）。统一三种格式的大纲语义属于导出功能自身的
   * 改造，已登记到 `../DEV-PLAN.md`「已知问题（待排期）」——规格与计划文档在仓库
   * **上一级目录**（`NovelForge/`），不在本 git 仓内。不在分卷 Task 内顺手扩大改动面。
   *
   * UI 侧已对齐：「包含大纲」复选框仅在 `merged-md` 下渲染，不再承诺做不到的事。
   */
  includeCharacters?: boolean
  scope?: ExportScope
  /** scope==='volume' 时必传 */
  volumeNumber?: number
  /**
   * 调用方在**点击入口**（选目录对话框之前）捕获的项目 token。
   * 选目录 + 逐章读正文都是长 await，等进了本函数才捕获已经晚了。
   */
  expectedToken?: number
}

/** 导出全书或单卷 */
export async function exportNovel(options: ExportOptions): Promise<{ success: boolean; path?: string; error?: string }> {
  const project = useProjectStore.getState().currentProject
  if (!project) return { success: false, error: '未打开项目' }

  // 导出要逐章读定稿正文，长篇可达数百次 IPC、耗时可观。
  // 期间用户完全可能切项目——若不复核，会把 A 的项目名与选项、
  // B 的卷/蓝图/正文拼成一个混合文件写出去。
  // `expectedToken` 由调用方在**点击入口**捕获（选目录对话框本身就是个长 await）；
  // 未传时退化为在此捕获，至少覆盖读数据那一段。
  const expectedToken = options.expectedToken ?? getProjectToken()
  const assertSameProject = (): { success: false; error: string } | null =>
    getProjectToken() === expectedToken
      ? null
      : { success: false as const, error: '项目已切换，本次导出已取消（避免混合两个项目的内容）' }

  const addLog = useWorkflowStore.getState().addLog
  const scope = options.scope ?? 'book'

  try {
    // 分卷信息只在**有卷**时才用；零卷项目下面所有分卷分支都不会触发，
    // 导出结果与分卷前逐字节一致（老项目零感知）
    const volumes = await ipc.invoke('db:volume-get-all')

    let targetVolume: VolumeData | null = null
    if (scope === 'volume') {
      if (options.volumeNumber === undefined) {
        return { success: false, error: '按卷导出必须指定卷序号' }
      }
      targetVolume = volumes.find(v => v.volumeNumber === options.volumeNumber) ?? null
      if (!targetVolume) {
        return { success: false, error: `第 ${options.volumeNumber} 卷不存在` }
      }
    }

    const staleAfterVolumes = assertSameProject()
    if (staleAfterVolumes) return staleAfterVolumes

    addLog('info', targetVolume
      ? `📦 开始导出「${targetVolume.title}」（${formatLabel(options.format)}）...`
      : `📦 开始导出（${formatLabel(options.format)}）...`)

    // 遍历所有章节蓝图，取定稿内容
    const chapterContents: Array<{ name: string; content: string; chapterNumber: number }> = []
    const blueprints = (await ipc.invoke('db:blueprint-get-all')) as unknown as Array<Record<string, unknown>>
    let sortedBps = blueprints ? blueprints.sort((a, b) => (a.chapterNumber as number) - (b.chapterNumber as number)) : []

    if (targetVolume) {
      sortedBps = sortedBps.filter(bp => {
        const n = bp.chapterNumber as number
        return n >= targetVolume!.startChapter && n <= targetVolume!.endChapter
      })
    }

    for (const bp of sortedBps) {
      const meta = await ipc.invoke('db:draft-get-finalized', bp.chapterNumber as number)
      if (meta && (meta as { id: number }).id !== undefined) {
        const full = await ipc.invoke('db:draft-get-full', (meta as { id: number }).id)
        if (full && (full as { content?: string }).content) {
          chapterContents.push({
            name: `chapter_${bp.chapterNumber}.md`,
            content: (full as { content: string }).content,
            chapterNumber: bp.chapterNumber as number,
          })
        }
      }
    }

    if (chapterContents.length === 0) {
      return {
        success: false,
        error: targetVolume
          ? `「${targetVolume.title}」（第 ${targetVolume.startChapter}–${targetVolume.endChapter} 章）内没有已定稿的章节`
          : '无可导出的章节（无定稿章节）',
      }
    }

    // 整本导出且已分卷时，在各卷首章前插入卷分隔标题。
    // 只按**卷起始章**匹配，不按「第一个落在区间内的章」——后者在首章尚未定稿时
    // 会把标题错插到卷中间某章头上
    const volumeHeaderAt = new Map<number, string>()
    if (!targetVolume && volumes.length > 0) {
      for (const v of volumes) {
        volumeHeaderAt.set(v.startChapter, `## 第${v.volumeNumber}卷 · ${v.title}`)
      }
    }

    /** 该章前该插的卷标题（无则空串） */
    const headerFor = (chapterNumber: number) => volumeHeaderAt.get(chapterNumber) ?? ''

    addLog('info', `找到 ${chapterContents.length} 个已定稿章节`)

    // fs 通道的失败是**返回值**不是异常（权限不足 / 磁盘满 / 路径过长都走 {success:false}）。
    // 不检查就会「日志说导出完成、磁盘上什么都没有」
    const mkdir = async (dir: string) => {
      const r = await ipc.invoke('fs:mkdir', dir)
      if (!r.success) throw new Error(`创建目录失败（${dir}）：${r.error ?? '未知错误'}`)
    }
    const writeFile = async (file: string, content: string) => {
      const r = await ipc.invoke('fs:write-file', file, content)
      if (!r.success) throw new Error(`写入文件失败（${file}）：${r.error ?? '未知错误'}`)
    }

    // 全书大纲必须在**最后一道复核之前**读完。
    // 它原本嵌在下面 merged-md 的分支里，排在复核之后——而复核与那次读取之间
    // 隔着 `mkdir` 这个 await，切项目正好能挤进去：结果是 A 项目的目录里
    // 写进 B 的全书大纲。复核只有当它之后**不再碰项目数据库**时才算数。
    const needBookOutline =
      options.format === 'merged-md' && !!options.includeOutline && !targetVolume
    const bookSynopsis = needBookOutline
      ? (await ipc.invoke('db:project-core-get'))?.synopsis ?? ''
      : ''

    // 至此项目数据的读取全部结束。这是**最后一道**复核，
    // 它之后只剩纯字符串拼装与写盘，不再有任何 IPC 读
    const staleBeforeWrite = assertSameProject()
    if (staleBeforeWrite) return staleBeforeWrite

    // 确保输出目录存在
    await mkdir(options.outputDir)

    // 展示用标题与路径用文件名**必须分开**：卷名常含冒号（「第二卷：南征」），
    // 净化只该作用于路径，正文标题里出现 `第二卷_南征` 是把技术约束泄漏给读者
    const displayTitle = targetVolume
      ? `${project.name} - 第${targetVolume.volumeNumber}卷 ${targetVolume.title}`.trim()
      : project.name
    const safeBaseName = targetVolume ? sanitizeFileName(displayTitle) : project.name

    let outputPath = ''

    switch (options.format) {
      case 'merged-md': {
        // 合并为单个 Markdown
        let content = `# ${displayTitle}\n\n`
        content += `> ${project.novelConfig.genre} · ${project.novelConfig.targetAudience}\n\n---\n\n`

        // 可选：包含大纲
        if (options.includeOutline) {
          if (targetVolume) {
            // 按卷导出塞全书 synopsis 会把还没写到的后续卷剧情剧透给读者，
            // 且那份描述的是整本书而非本卷。改用本卷自己的主线与大纲
            const volOutline = [
              targetVolume.premise?.trim() && `### 本卷主线\n\n${targetVolume.premise.trim()}`,
              targetVolume.synopsis?.trim() && `### 本卷大纲\n\n${targetVolume.synopsis.trim()}`,
            ].filter(Boolean).join('\n\n')
            if (volOutline) content += volOutline + '\n\n---\n\n'
          } else if (bookSynopsis) {
            // 已在最后一道复核之前读好（见上），此处不再访问数据库
            content += bookSynopsis + '\n\n---\n\n'
          }
        }

        // 章节内容
        for (const ch of chapterContents) {
          const header = headerFor(ch.chapterNumber)
          if (header) content += header + '\n\n'
          content += ch.content + '\n\n---\n\n'
        }

        outputPath = `${options.outputDir}/${safeBaseName}.md`
        await writeFile(outputPath, content)
        break
      }

      case 'split-md': {
        // 每章一个 Markdown，写进**每次唯一的新目录**。
        //
        // 为什么不能复用「项目名/卷名」这种固定目录：现有 fs 通道只有
        // read/write/list/mkdir，**没有删除能力**，无法清掉上次导出的残留。
        // 而卷号与卷名不变、章号区间缩短是很常见的（末卷从 51–100 改成 51–80，
        // 或某章被退回草稿导致定稿章变少）——此时目录名完全相同，
        // 旧的 chapter_81.md…chapter_100.md 会继续躺在里面，
        // 用户拿到的「本卷全文」混着已经不属于本次范围的章节。
        //
        // 取舍：唯一目录会让反复导出累积多个目录，但那是**可见且无损**的；
        // 静默混入过期章节则是不可见的错误内容。宁可前者。
        // （若将来加了带路径边界校验的删除通道，可改回固定目录 + 受管清理。）
        const splitDir = `${options.outputDir}/${safeBaseName}_${nextExportStamp()}`
        await mkdir(splitDir)

        for (const ch of chapterContents) {
          await writeFile(`${splitDir}/${ch.name}`, ch.content)
        }

        outputPath = splitDir
        break
      }

      case 'txt': {
        // 纯文本（去除 Markdown 格式）
        let content = `${displayTitle}\n${'='.repeat(displayTitle.length * 2)}\n\n`

        for (const ch of chapterContents) {
          const header = headerFor(ch.chapterNumber)
          // txt 是纯文本，卷标题去掉 Markdown 的 ## 前缀
          if (header) content += header.replace(/^#+\s*/, '') + '\n\n'
          // 简单去除 Markdown 标记
          const plainText = ch.content
            .replace(/^#{1,6}\s+/gm, '')  // 去掉标题标记
            .replace(/\*\*(.*?)\*\*/g, '$1')  // 去掉加粗
            .replace(/\*(.*?)\*/g, '$1')  // 去掉斜体
            .replace(/`(.*?)`/g, '$1')  // 去掉代码标记
            .replace(/---+/g, '\n')  // 分隔线
            .trim()

          content += plainText + '\n\n'
        }

        outputPath = `${options.outputDir}/${safeBaseName}.txt`
        await writeFile(outputPath, content)
        break
      }
    }

    addLog('info', `✅ 导出完成: ${outputPath}`)
    return { success: true, path: outputPath }
  } catch (error) {
    addLog('error', `❌ 导出失败: ${error}`)
    return { success: false, error: String(error) }
  }
}

/** 同一次运行内单调递增，用于给 split-md 目录后缀去重 */
let exportSeq = 0

/**
 * split-md 每次导出的唯一目录后缀。
 *
 * 只用「精确到秒」的时间戳是不够的——用户连点两次导出、或先导整卷再导缩小后的
 * 范围，两次完全可能落在同一秒，目录名相同就退化回「旧章节残留」那个 bug。
 * 故追加一个进程内单调序号：同一次运行内绝对不重复，跨运行靠毫秒时间戳区分。
 */
function nextExportStamp(): string {
  const t = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)
  return `${t}_${++exportSeq}`
}

/**
 * 卷名进文件名前的净化。卷名是用户可编辑的自由文本，仓储层不限字符，
 * 故这里要挡住三类会让 Windows 写盘失败或路径归一化冲突的东西：
 * ① 路径分隔符与保留字符 ② ASCII 控制字符（\x00–\x1f）
 * ③ 末尾的点与空格（Windows 会静默去掉，导致"写出来的文件名和请求的不一样"）
 */
function sanitizeFileName(name: string): string {
  return (name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
}

function formatLabel(format: ExportFormat): string {
  const labels: Record<ExportFormat, string> = {
    'merged-md': '合并 Markdown',
    'split-md': '分章 Markdown',
    'txt': '纯文本 TXT',
  }
  return labels[format]
}
