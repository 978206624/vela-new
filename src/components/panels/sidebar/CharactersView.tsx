/**
 * CharactersView — 角色管理列表视图
 */

import { useRef, useState } from 'react'
import { Users, RefreshCw, Plus, Sparkles, X } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore, ROLE_LABELS, type CharacterCard } from '../../../stores/character-store'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { cn } from '../../../lib/utils'
import type { WorkflowContext } from '../../../stores/workflow-store'
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

  // 批量补全状态（hooks 必须在任何提前 return 之前）
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  const [proposals, setProposals] = useState<ProfileProposal[] | null>(null)
  const [note, setNote] = useState<string>('')
  const batchCtxRef = useRef<WorkflowContext>({ data: {}, cancelled: false })

  const batching = batchProgress !== null
  const anyEmpty = characters.some(hasEmptyStaticFields)

  const handleBatchComplete = async () => {
    const targets = characters.filter(hasEmptyStaticFields)
    if (targets.length === 0) { setNote('所有角色人设已完整'); return }
    setNote('')
    batchCtxRef.current = { data: {}, cancelled: false }
    const collected: ProfileProposal[] = []
    setBatchProgress({ done: 0, total: targets.length })
    for (let i = 0; i < targets.length; i++) {
      if (batchCtxRef.current.cancelled) break
      setBatchProgress({ done: i, total: targets.length })
      try {
        const res = await new CompleteCharacterProfileCommand().infer(targets[i].name, { context: batchCtxRef.current })
        // 仅保留 AI 归纳出非空字段的角色
        if (PROFILE_FIELDS.some(f => (res.profile[f] ?? '').trim() !== '')) {
          collected.push({ characterName: targets[i].name, profile: res.profile, evidence: res.evidence })
        }
      } catch {
        // 单个失败跳过、不中断整批
      }
    }
    setBatchProgress(null)
    if (collected.length > 0) setProposals(collected)
    else setNote('未能从正文归纳出可补全的人设')
  }

  const cancelBatch = () => { batchCtxRef.current.cancelled = true }

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
          {batching ? (
            <button
              onClick={cancelBatch}
              className="flex items-center gap-1 px-1.5 h-6 rounded text-[0.7rem]"
              style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
              title="取消批量补全"
            >
              <X size={12} /> {batchProgress?.done}/{batchProgress?.total}
            </button>
          ) : (
            <Button
              variant="ghost" size="icon" className="h-6 w-6"
              onClick={handleBatchComplete}
              disabled={!anyEmpty}
              title={anyEmpty ? 'AI 批量补全缺失人设' : '所有角色人设已完整'}
            >
              <Sparkles size={14} strokeWidth={2} />
            </Button>
          )}
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
