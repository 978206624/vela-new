import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { useCharacterStore, type CharacterCard } from '../../stores/character-store'
import { fieldLabel } from '../ui/fieldLabels'
import { ipc } from '../../services/ipc-client'
import { PROFILE_FIELDS, type ProfileField, type CharacterProfile, type ProfileEvidence } from '../../services/workflows/commands/complete-character-profile.command'

/** 一个角色的 AI 补全提案 */
export interface ProfileProposal {
  characterName: string
  profile: CharacterProfile
  evidence: ProfileEvidence
}

/** 单字段编辑态 */
interface FieldEdit { include: boolean; value: string }

/**
 * CharacterProfilePreviewDialog — AI 补全人设的统一预览/确认弹窗。
 * 单角色（proposals 长度 1）与批量（长度 N）共用：只展示「当前为空 + AI 有值」的候选字段，
 * 逐字段可编辑/勾选；确认后只填空字段、按 applied merge 进 store（不全量 load，不覆盖未保存编辑）。
 */
export default function CharacterProfilePreviewDialog({
  proposals,
  onClose,
}: {
  proposals: ProfileProposal[]
  onClose: () => void
}) {
  const characters = useCharacterStore(s => s.characters)
  const [writing, setWriting] = useState(false)

  // 计算候选字段（DB/内存中为空 且 AI 给了非空值）并初始化编辑态（冻结于打开时）
  const [edits, setEdits] = useState<Record<string, Partial<Record<ProfileField, FieldEdit>>>>(() => {
    const init: Record<string, Partial<Record<ProfileField, FieldEdit>>> = {}
    for (const p of proposals) {
      const card = characters.find(c => c.name === p.characterName)
      const perChar: Partial<Record<ProfileField, FieldEdit>> = {}
      for (const f of PROFILE_FIELDS) {
        const localEmpty = ((card?.[f] as string) ?? '').trim() === ''
        const aiVal = (p.profile[f] ?? '').trim()
        if (localEmpty && aiVal !== '') perChar[f] = { include: true, value: p.profile[f] }
      }
      init[p.characterName] = perChar
    }
    return init
  })

  // 有候选可填的角色
  const fillable = proposals.filter(p => Object.keys(edits[p.characterName] ?? {}).length > 0)
  const totalChecked = fillable.reduce(
    (n, p) => n + Object.values(edits[p.characterName] ?? {}).filter(e => e?.include).length, 0
  )

  const setField = (charName: string, field: ProfileField, patch: Partial<FieldEdit>) => {
    setEdits(prev => ({
      ...prev,
      [charName]: { ...prev[charName], [field]: { ...prev[charName]?.[field]!, ...patch } },
    }))
  }

  const handleConfirm = async () => {
    setWriting(true)
    try {
      for (const p of fillable) {
        const perChar = edits[p.characterName] ?? {}
        const patch: Partial<Record<ProfileField, string>> = {}
        for (const f of PROFILE_FIELDS) {
          const e = perChar[f]
          if (e?.include && e.value.trim()) patch[f] = e.value
        }
        if (Object.keys(patch).length === 0) continue

        const res = await ipc.invoke('db:character-fill-empty-profile', p.characterName, patch)
        if (res.success && res.applied) {
          // 只 merge 本次实际填入字段，且本地仍为空才写（本地未保存非空值优先），不全量 load
          const card = useCharacterStore.getState().characters.find(c => c.name === p.characterName)
          for (const [field, value] of Object.entries(res.applied)) {
            const cur = ((card?.[field as keyof CharacterCard] as string) ?? '').trim()
            if (cur === '') useCharacterStore.getState().updateField(p.characterName, field as keyof CharacterCard, value)
          }
        }
      }
      onClose()
    } finally {
      setWriting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !writing) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI 补全人设 — 预览确认</DialogTitle>
          <DialogDescription>
            仅补全当前为空的字段，不覆盖已填内容。可逐项编辑、取消勾选不需要的字段。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto px-6 py-3 flex flex-col gap-4">
          {fillable.length === 0 ? (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
              没有可补全的空字段（AI 未能从正文归纳出新信息，或字段已填）。
            </div>
          ) : (
            fillable.map(p => (
              <div key={p.characterName} className="flex flex-col gap-2">
                {proposals.length > 1 && (
                  <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                    {p.characterName}
                  </div>
                )}
                {PROFILE_FIELDS.filter(f => edits[p.characterName]?.[f]).map(f => {
                  const e = edits[p.characterName]![f]!
                  const ev = p.evidence?.[f]
                  return (
                    <div key={f} className="flex flex-col gap-1 pl-1">
                      <label className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                        <input
                          type="checkbox"
                          checked={e.include}
                          onChange={ev2 => setField(p.characterName, f, { include: ev2.target.checked })}
                        />
                        {fieldLabel(f)}
                      </label>
                      <textarea
                        value={e.value}
                        disabled={!e.include}
                        onChange={ev2 => setField(p.characterName, f, { value: ev2.target.value })}
                        rows={2}
                        className="w-full resize-y rounded-md px-2 py-1.5 text-xs leading-relaxed outline-none"
                        style={{
                          backgroundColor: 'var(--color-hover)',
                          border: '1px solid var(--color-border)',
                          color: 'var(--color-text)',
                          opacity: e.include ? 1 : 0.5,
                        }}
                      />
                      {Array.isArray(ev) && ev.length > 0 && (
                        <div className="text-[0.68rem] pl-1" style={{ color: 'var(--color-text-muted)' }}>
                          依据：第 {ev.map(x => x.chapter).join('、')} 章
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            将写入 {totalChecked} 个字段
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={writing}>取消</Button>
            <Button size="sm" onClick={handleConfirm} disabled={writing || totalChecked === 0}>
              {writing ? '写入中…' : '确认写入'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
