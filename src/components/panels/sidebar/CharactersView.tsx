/**
 * CharactersView — 角色管理列表视图
 */

import { useState } from 'react'
import { Users, RefreshCw, Plus, Sparkles, X } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore, ROLE_LABELS, type CharacterCard } from '../../../stores/character-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { cn } from '../../../lib/utils'
import { CompleteCharacterProfileCommand, PROFILE_FIELDS } from '../../../services/workflows/commands/complete-character-profile.command'
import CharacterProfilePreviewDialog, { type ProfileProposal } from '../../editor/CharacterProfilePreviewDialog'

/** 角色是否存在空的静态人设字段 */
function hasEmptyStaticFields(c: CharacterCard): boolean {
  return PROFILE_FIELDS.some(f => ((c[f] as string) ?? '').trim() === '')
}

export default function CharactersView() {
  const currentProject = useProjectStore(s => s.currentProject)
  const characters = useCharacterStore(s => s.characters)
  const selectedName = useCharacterStore(s => s.selectedName)
  const load = useCharacterStore(s => s.load)
  const setSelectedName = useCharacterStore(s => s.setSelectedName)
  const addCharacter = useCharacterStore(s => s.addCharacter)
  const startWorkflow = useWorkflowStore(s => s.startWorkflow)

  // 批量补全状态（hooks 必须在任何提前 return 之前）
  const [batching, setBatching] = useState(false)
  const [proposals, setProposals] = useState<ProfileProposal[] | null>(null)
  const [note, setNote] = useState<string>('')

  const anyEmpty = characters.some(hasEmptyStaticFields)

  // 经 workflow-store 跑：一个 run、每角色一个 step，流式正文 + 进度 + 取消都在 AI 输出面板，
  // 和章节生成等操作一致。每个 step 内 try/catch 吞错保证单个失败不中断整批（executor 抛错会 break 整个 run）。
  const handleBatchComplete = async () => {
    const targets = characters.filter(hasEmptyStaticFields)
    if (targets.length === 0) { setNote('所有角色人设已完整'); return }
    setNote('')
    setBatching(true)
    const collected: ProfileProposal[] = []
    try {
      await startWorkflow({
        type: 'character_profile',
        title: `批量补全人设（${targets.length} 个角色）`,
        steps: targets.map(t => ({
          name: `分析「${t.name}」`,
          description: '从出场正文归纳静态人设',
          executor: async (_step, context, callbacks) => {
            if (context.cancelled) return
            try {
              const res = await new CompleteCharacterProfileCommand().infer(t.name, { callbacks, context })
              if (PROFILE_FIELDS.some(f => (res.profile[f] ?? '').trim() !== '')) {
                collected.push({ characterName: t.name, profile: res.profile, evidence: res.evidence })
                callbacks.log(`✓ ${t.name} 归纳完成`)
              } else {
                callbacks.log(`— ${t.name} 正文无可归纳信息，跳过`)
              }
            } catch (e) {
              // 单个失败跳过、不中断整批（不可向上抛，否则 run 会 break）
              callbacks.log(`✗ ${t.name} 失败跳过：${String(e)}`)
            }
          },
        })),
      })
    } finally {
      setBatching(false)
    }
    if (collected.length > 0) setProposals(collected)
    else setNote('未能从正文归纳出可补全的人设')
  }

  if (!currentProject) {
    return (
      <EmptyState 
        icon={<Users size={36} />} 
        message="请先打开项目" 
        className="pb-[15vh]" 
        opacity={0.4} 
      />
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between px-3 h-9 flex-shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text)] flex items-center gap-1">
          <Users size={13} />
          角色列表 ({characters.length})
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost" size="icon" className="h-6 w-6"
            onClick={handleBatchComplete}
            disabled={batching || !anyEmpty}
            title={batching ? '批量补全进行中（进度/取消见 AI 输出面板）' : anyEmpty ? 'AI 批量补全缺失人设' : '所有角色人设已完整'}
          >
            <Sparkles size={14} strokeWidth={2} className={batching ? 'animate-pulse' : ''} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => load()} title="刷新列表">
            <RefreshCw size={14} strokeWidth={2} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={addCharacter} title="新建角色">
            <Plus size={14} strokeWidth={2} />
          </Button>
        </div>
      </div>

      {note && (
        <div className="px-3 py-1.5 text-[0.7rem] flex items-center justify-between" style={{ color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' }}>
          <span>{note}</span>
          <button onClick={() => setNote('')} style={{ color: 'var(--color-text-muted)' }}><X size={11} /></button>
        </div>
      )}

      {/* 批量补全 — 统一预览确认弹窗 */}
      {proposals && (
        <CharacterProfilePreviewDialog proposals={proposals} onClose={() => setProposals(null)} />
      )}
      {/* 角色列表 */}
      <div className="flex-1 overflow-y-auto p-1">
        {characters.map((c) => (
          <div
            key={c.name}
            className={cn(
              'px-2.5 py-1.5 rounded-md text-xs cursor-pointer mb-0.5',
              selectedName === c.name
                ? 'bg-[var(--color-active)] text-[var(--color-text)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
            )}
            onClick={() => setSelectedName(c.name)}
          >
            <div className="font-medium">{c.name || '未命名'}</div>
            <div className="text-[0.7rem] mt-0.5 opacity-60">{ROLE_LABELS[c.role]}</div>
            {c.currentState && (
              <div className="text-[0.65rem] mt-0.5 opacity-50">
                第{c.currentState.updatedAtChapter}章更新
              </div>
            )}
          </div>
        ))}
        {characters.length === 0 && (
          <div className="text-center py-6 opacity-30 text-xs">暂无角色</div>
        )}
      </div>
    </div>
  )
}
