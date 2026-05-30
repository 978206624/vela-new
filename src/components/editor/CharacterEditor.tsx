import { useState } from 'react'
import { Save, Trash2, Users, Sparkles } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { confirm } from '../ui/Confirm'
import {
  useCharacterStore,
  EMPTY_STATE,
  ROLE_LABELS,
  type CharacterCurrentState,
} from '../../stores/character-store'
import RelationshipGraph from './RelationshipGraph'
import CharacterProfilePreviewDialog, { type ProfileProposal } from './CharacterProfilePreviewDialog'
import { CompleteCharacterProfileCommand, PROFILE_FIELDS, type InferProfileResult } from '../../services/workflows/commands/complete-character-profile.command'
import { EmptyState as BaseEmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { Label } from '../ui/Label'
import { Select } from '../ui/Select'

/**
 * 角色卡编辑器 — 纯编辑区域（角色列表已移至侧栏）
 * 从 character-store 读取选中角色，仅渲染编辑表单。
 */
export default function CharacterEditor() {
  const currentProject = useProjectStore(s => s.currentProject)
  const addLog = useWorkflowStore(s => s.addLog)
  const startWorkflow = useWorkflowStore(s => s.startWorkflow)
  const characters = useCharacterStore(s => s.characters)
  const selectedName = useCharacterStore(s => s.selectedName)
  const saving = useCharacterStore(s => s.saving)
  const updateField = useCharacterStore(s => s.updateField)
  const deleteCharacter = useCharacterStore(s => s.deleteCharacter)
  const saveAll = useCharacterStore(s => s.saveAll)
  const [viewMode, setViewMode] = useState<'edit' | 'state'>('edit')
  const [inferring, setInferring] = useState(false)
  const [previewProposals, setPreviewProposals] = useState<ProfileProposal[] | null>(null)

  // 数据由 ProjectService 统一加载，组件只消费 store 数据

  const selectedCard = characters.find((c) => c.name === selectedName) || null

  // 是否存在空的静态人设字段（决定「AI 补全」按钮是否可用）
  const hasEmptyStatic = !!selectedCard && PROFILE_FIELDS.some(f => ((selectedCard[f] as string) ?? '').trim() === '')

  const handleAIComplete = async () => {
    if (!selectedCard) return
    const name = selectedCard.name
    setInferring(true)
    // 经 workflow-store 跑：流式正文 + 日志显示在 AI 输出面板，和章节生成等操作一致；取消走面板原生。
    // 结果用 holder 对象经闭包回传（TS 不跨闭包做控制流收窄，故不能用裸 let）。
    const holder: { value: InferProfileResult | null } = { value: null }
    try {
      await startWorkflow({
        type: 'character_profile',
        title: `AI 补全人设：${name}`,
        steps: [{
          name: `分析「${name}」的出场正文`,
          description: '从出场正文 + 人物群像反向归纳静态人设',
          executor: async (_step, context, callbacks) => {
            const res = await new CompleteCharacterProfileCommand().infer(name, { callbacks, context })
            holder.value = res
            const filled = PROFILE_FIELDS.filter(f => (res.profile[f] ?? '').trim() !== '').length
            callbacks.log(`归纳出 ${filled} 个可补全字段`)
          },
        }],
      })
    } catch (e) {
      addLog('error', `AI 补全人设失败：${String(e)}`)
    } finally {
      setInferring(false)
    }
    if (holder.value) {
      setPreviewProposals([{ characterName: name, profile: holder.value.profile, evidence: holder.value.evidence }])
    }
  }

  const handleDelete = async () => {
    if (!selectedCard || !currentProject) return
    const ok = await confirm(
      `确定要删除角色「${selectedCard.name || '未命名'}」吗？此操作不可撤销。`,
      { title: '删除角色', confirmText: '删除', danger: true }
    )
    if (!ok) return
    await deleteCharacter(selectedCard.name, currentProject.path)
  }

  const handleSave = async () => {
    if (!currentProject) return
    await saveAll(currentProject.path)
    addLog('info', `✅ 已保存 ${characters.length} 个角色卡`)
  }

  // ===== 渲染 =====

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
      {/* 统一顶部工具栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-editor-bg)',
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
            {selectedCard
              ? `${selectedCard.name || '新角色'} ${viewMode === 'state' ? '— 当前状态' : '— 编辑档案'}`
              : '角色档案'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {selectedCard ? (
            <>
              {viewMode === 'state' ? (
                <Button variant="outline" size="sm" onClick={() => setViewMode('edit')} title="返回基础设定">
                  <Users size={12} /> 基础设定
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setViewMode('state')} title="查看当前进展/状态">
                  📋 当前状态
                </Button>
              )}
              <Button
                variant="outline" size="sm"
                onClick={handleAIComplete}
                disabled={inferring || !hasEmptyStatic}
                title={hasEmptyStatic ? 'AI 从出场正文补全空缺人设' : '静态人设已完整，无空字段'}
              >
                <Sparkles size={12} /> {inferring ? '补全中…' : 'AI 补全'}
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDelete}>
                <Trash2 size={12} /> 删除
              </Button>
              <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
                <Save size={12} /> {saving ? '保存中...' : '保存'}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* 主体区 */}
      <div className="flex-1 overflow-y-auto relative">
        {!selectedCard ? (
          <BaseEmptyState 
            icon={<Users size={36} />} 
            message={currentProject ? "在左侧选择或创建角色卡" : "请先打开项目"} 
            opacity={currentProject ? 0.3 : 0.4}
          />
        ) : viewMode === 'state' ? (
          <div className="max-w-2xl mx-auto px-6 py-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-[var(--color-text)]">
                当前状态档案
              </h3>
              <span className="text-xs text-[var(--color-text-secondary)]">
                最后更新：第 {selectedCard.currentState?.updatedAtChapter ?? 0} 章
              </span>
            </div>
            <div className="space-y-3">
              {([
                ['location', '当前位置/阵营'],
                ['powerLevel', '修为境界/能力等级'],
                ['physicalState', '身体状态（伤势/BUFF/外貌）'],
                ['mentalState', '心理状态（愿望/恐惧/心态）'],
                ['keyItems', '关键道具/资源'],
                ['recentEvents', '最近重要事件'],
              ] as const).map(([field, label]) => (
                <div key={field}>
                  <Label>{label}</Label>
                  <Textarea
                    value={selectedCard.currentState?.[field]?.toString() ?? ''}
                    onChange={(e) => {
                      const cs: CharacterCurrentState = {
                        ...(selectedCard.currentState ?? EMPTY_STATE),
                        [field]: e.target.value,
                      }
                      updateField(selectedCard.name, 'currentState', cs)
                    }}
                    rows={2}
                    placeholder={`${label}...`}
                  />
                </div>
              ))}
            </div>
            {!selectedCard.currentState && (
              <div className="mt-4 p-3 rounded-lg bg-[var(--color-hover)] text-xs text-[var(--color-text-secondary)]">
                当前状态档案将在章节定稿后由 AI 自动更新，也可手动填写初始状态。
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto px-6 py-4">
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div><Label>姓名</Label><Input value={selectedCard.name} onChange={(e) => updateField(selectedCard.name, 'name', e.target.value)} /></div>
                <div><Label>性别</Label><Input value={selectedCard.gender} onChange={(e) => updateField(selectedCard.name, 'gender', e.target.value)} /></div>
                <div><Label>年龄</Label><Input value={selectedCard.age} onChange={(e) => updateField(selectedCard.name, 'age', e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>定位</Label>
                  <Select
                    value={selectedCard.role}
                    onValueChange={(v) => updateField(selectedCard.name, 'role', v as typeof selectedCard.role)}
                    options={Object.entries(ROLE_LABELS).map(([k, v]) => ({ value: k, label: v }))}
                  />
                </div>
              </div>
              <div><Label>外貌描写</Label><Textarea value={selectedCard.appearance} onChange={(e) => updateField(selectedCard.name, 'appearance', e.target.value)} rows={3} placeholder="输入外貌描写..." /></div>
              <div><Label>性格特征</Label><Textarea value={selectedCard.personality} onChange={(e) => updateField(selectedCard.name, 'personality', e.target.value)} rows={3} placeholder="输入性格特征..." /></div>
              <div><Label>背景故事</Label><Textarea value={selectedCard.background} onChange={(e) => updateField(selectedCard.name, 'background', e.target.value)} rows={4} placeholder="输入背景故事..." /></div>
              <div><Label>能力/技能</Label><Textarea value={selectedCard.abilities} onChange={(e) => updateField(selectedCard.name, 'abilities', e.target.value)} rows={3} placeholder="输入能力/技能..." /></div>
              <div><Label>核心动机</Label><Textarea value={selectedCard.motivation} onChange={(e) => updateField(selectedCard.name, 'motivation', e.target.value)} rows={2} placeholder="输入核心动机..." /></div>
              <div>
                <Label>关系网</Label>
                <Textarea value={selectedCard.relationships} onChange={(e) => updateField(selectedCard.name, 'relationships', e.target.value)} rows={3} placeholder="输入关系网...（格式如：苏晚晴：暧昧·盟友，陈三爷：旧怨）" />
                <div className="mt-2">
                  <RelationshipGraph center={selectedCard} characters={characters} />
                </div>
              </div>
              <div><Label>成长轨迹</Label><Textarea value={selectedCard.arc} onChange={(e) => updateField(selectedCard.name, 'arc', e.target.value)} rows={3} placeholder="输入成长轨迹..." /></div>
              <div><Label>备注</Label><Textarea value={selectedCard.notes} onChange={(e) => updateField(selectedCard.name, 'notes', e.target.value)} rows={2} placeholder="输入备注..." /></div>
            </div>
          </div>
        )}
      </div>

      {/* AI 补全人设 — 预览确认弹窗 */}
      {previewProposals && (
        <CharacterProfilePreviewDialog
          proposals={previewProposals}
          onClose={() => setPreviewProposals(null)}
        />
      )}
    </div>
  )
}
