import { useState } from 'react'
import { Sparkles, FolderOpen, Clock, BookOpen, FileUp, ExternalLink, Trash2 } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import { ContextMenu } from '../ui/ContextMenu'

interface WelcomePageProps {
  onNewProject: () => void
  onOpenProject: () => void
  onImportNovel?: () => void
}

/** 欢迎页面 — 无项目打开时显示 */
export default function WelcomePage({ onNewProject, onOpenProject, onImportNovel }: WelcomePageProps) {
  const recentProjects = useProjectStore(s => s.recentProjects)
  const openProject = useProjectStore(s => s.openProject)
  const currentProject = useProjectStore(s => s.currentProject)
  const removeRecentProject = useProjectStore(s => s.removeRecentProject)

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    project: { name: string; path: string }
  } | null>(null)

  const handleContextMenu = (e: React.MouseEvent, project: { name: string; path: string }) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, project })
  }

  return (
    <div
      className="w-full h-full overflow-y-auto"
      style={{ backgroundColor: 'var(--color-editor-bg)' }}
    >
      <div className="max-w-lg w-full mx-auto px-8 py-16">
        {/* Logo 区域 — 品牌极光光环 */}
        <div className="text-center mb-12">
          <div
            className="ai-glow inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-5"
            style={{
              boxShadow: '0 8px 32px color-mix(in srgb, var(--color-accent) 25%, transparent), 0 0 60px color-mix(in srgb, var(--color-gold) 12%, transparent)',
            }}
          >
            <BookOpen size={36} color="#fff" style={{ position: 'relative', zIndex: 1 }} />
          </div>
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--color-text)' }}>
            {currentProject ? currentProject.name : '欢迎使用 Vela'}
          </h1>
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {currentProject ? currentProject.path : '本地优先的中文长篇小说创作 IDE'}
          </p>
        </div>

        {/* 操作按钮 */}
        <div className="grid grid-cols-3 gap-3 mb-10">
          <button
            onClick={onNewProject}
            className="group flex flex-col items-center gap-2.5 p-5 rounded-xl transition-all hover:scale-[1.02]"
            style={{
              backgroundColor: 'var(--color-sidebar)',
              border: '1px solid var(--color-border)',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--color-accent) 40%, transparent)'
              e.currentTarget.style.boxShadow = '0 4px 20px color-mix(in srgb, var(--color-accent) 10%, transparent)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--color-border)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            <div
              className="ai-glow flex items-center justify-center w-10 h-10 rounded-xl transition-transform group-hover:scale-105"
            >
              <Sparkles size={20} />
            </div>
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              新建项目
            </span>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              创建一部新的小说
            </span>
          </button>

          <button
            onClick={onOpenProject}
            className="group flex flex-col items-center gap-2.5 p-5 rounded-xl transition-all hover:scale-[1.02]"
            style={{
              backgroundColor: 'var(--color-sidebar)',
              border: '1px solid var(--color-border)',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--color-gold) 40%, transparent)'
              e.currentTarget.style.boxShadow = '0 4px 20px color-mix(in srgb, var(--color-gold) 8%, transparent)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--color-border)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            <div
              className="flex items-center justify-center w-10 h-10 rounded-xl transition-transform group-hover:scale-105"
              style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}
            >
              <FolderOpen size={20} />
            </div>
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              打开项目
            </span>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              打开已有 Vela 项目
            </span>
          </button>

          <button
            onClick={onImportNovel}
            className="group flex flex-col items-center gap-2.5 p-5 rounded-xl transition-all hover:scale-[1.02]"
            style={{
              backgroundColor: 'var(--color-sidebar)',
              border: '1px solid var(--color-border)',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--color-accent) 40%, transparent)'
              e.currentTarget.style.boxShadow = '0 4px 20px color-mix(in srgb, var(--color-accent) 12%, transparent)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--color-border)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            <div
              className="flex items-center justify-center w-10 h-10 rounded-xl transition-transform group-hover:scale-105"
              style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 14%, transparent)', color: 'var(--color-accent)' }}
            >
              <FileUp size={20} />
            </div>
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              导入小说
            </span>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              导入已有作品续写
            </span>
          </button>
        </div>

        {/* 最近项目 */}
        {recentProjects.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-3">
              <Clock size={14} style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                最近项目
              </span>
            </div>
            <div className="space-y-1">
              {recentProjects.map((p, i) => (
                <div
                  key={i}
                  className="group flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all"
                  style={{ backgroundColor: 'transparent', borderLeft: '2px solid transparent' }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--color-hover)'
                    e.currentTarget.style.borderLeftColor = 'var(--color-accent)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent'
                    e.currentTarget.style.borderLeftColor = 'transparent'
                  }}
                  onClick={() => openProject(p.path)}
                  onContextMenu={(e) => handleContextMenu(e, p)}
                >
                  <BookOpen size={14} style={{ color: 'var(--color-accent)', opacity: 0.6 }} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm block truncate" style={{ color: 'var(--color-text)' }}>
                      {p.name}
                    </span>
                    <span className="text-xs block truncate" style={{ color: 'var(--color-text-muted)' }}>
                      {p.path}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 右键菜单 —— 复用通用 ContextMenu（自带边界钳制 + 点击外部/Esc 关闭） */}
        {contextMenu && (
          <ContextMenu
            position={{ x: contextMenu.x, y: contextMenu.y }}
            items={[
              {
                key: 'reveal',
                label: '在文件管理器中显示',
                icon: <ExternalLink size={13} strokeWidth={1.5} />,
                onClick: () => ipc.revealInExplorer(contextMenu.project.path),
              },
              {
                key: 'remove',
                label: '移除',
                icon: <Trash2 size={13} strokeWidth={1.5} />,
                danger: true,
                onClick: () => removeRecentProject(contextMenu.project.path),
              },
            ]}
            onClose={() => setContextMenu(null)}
          />
        )}

        <div className="text-center mt-12">
          <p className="text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
            Vela v0.1.0 · 七阶段 AI 驱动创作流水线 · 本地化数据安全
          </p>
        </div>
      </div>
    </div>
  )
}
