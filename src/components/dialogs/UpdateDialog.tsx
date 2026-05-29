import { Download, RefreshCw, ExternalLink, AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { useUpdateStore } from '../../stores/update-store'
import { Button } from '../ui/Button'

/**
 * 在线更新提示弹窗（对应 Product-Spec §4.9）
 * 紧凑居中卡片，按 update-store 状态渲染：
 *   available / downloading / downloaded / portable-manual / error
 * checking / not-available / idle 不弹窗（在设置「关于」区给反馈）。
 */
export default function UpdateDialog() {
  const status = useUpdateStore((s) => s.status)
  const version = useUpdateStore((s) => s.version)
  const releaseNotes = useUpdateStore((s) => s.releaseNotes)
  const percent = useUpdateStore((s) => s.percent)
  const errorMessage = useUpdateStore((s) => s.errorMessage)
  const startDownload = useUpdateStore((s) => s.startDownload)
  const quitAndInstall = useUpdateStore((s) => s.quitAndInstall)
  const openReleases = useUpdateStore((s) => s.openReleases)
  const dismiss = useUpdateStore((s) => s.dismiss)

  const visible =
    status === 'available' ||
    status === 'downloading' ||
    status === 'downloaded' ||
    status === 'portable-manual' ||
    status === 'error'

  if (!visible) return null

  // 下载中不允许点遮罩关闭，避免误中断
  const dismissable = status !== 'downloading'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)' }}
      onClick={(e) => {
        if (dismissable && e.target === e.currentTarget) dismiss()
      }}
    >
      <div
        className="relative flex flex-col w-[440px] max-h-[70vh] rounded-2xl overflow-hidden shadow-2xl"
        style={{ backgroundColor: 'var(--color-editor-bg)', border: '1px solid var(--color-border)' }}
      >
        {/* 头部 */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2.5">
            <HeaderIcon status={status} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              {titleFor(status)}
            </h2>
          </div>
          {dismissable && (
            <button
              onClick={dismiss}
              className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-[var(--color-hover)]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {status === 'available' && (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: 'var(--color-text)' }}>
                新版本 <span className="font-semibold" style={{ color: 'var(--color-accent)' }}>v{version}</span> 已发布，是否更新？
              </p>
              {releaseNotes && (
                <div
                  className="text-xs leading-relaxed whitespace-pre-wrap rounded-lg p-3 max-h-48 overflow-y-auto"
                  style={{ backgroundColor: 'var(--color-panel)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
                >
                  {releaseNotes}
                </div>
              )}
            </div>
          )}

          {status === 'downloading' && (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: 'var(--color-text)' }}>
                正在下载 v{version || '新版本'}…
              </p>
              <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--color-hover)' }}>
                <div
                  className="h-full transition-all duration-200"
                  style={{ width: `${percent}%`, backgroundColor: 'var(--color-accent)' }}
                />
              </div>
              <p className="text-xs text-right" style={{ color: 'var(--color-text-muted)' }}>{percent}%</p>
            </div>
          )}

          {status === 'downloaded' && (
            <p className="text-sm" style={{ color: 'var(--color-text)' }}>
              v{version} 已下载完成，重启应用即可安装。你也可以稍后再装。
            </p>
          )}

          {status === 'portable-manual' && (
            <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text)' }}>
              便携版无法自动更新。请前往 GitHub Releases 下载最新版本，覆盖当前文件即可。
            </p>
          )}

          {status === 'error' && (
            <p className="text-sm leading-relaxed break-all" style={{ color: 'var(--color-text)' }}>
              检查或下载更新失败，请稍后重试。
              <span className="block text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>{errorMessage}</span>
            </p>
          )}
        </div>

        {/* 操作 */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3.5 flex-shrink-0"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          {status === 'available' && (
            <>
              <Button variant="ghost" onClick={dismiss}>以后再说</Button>
              <Button onClick={startDownload}>
                <Download size={13} />
                更新
              </Button>
            </>
          )}

          {status === 'downloading' && (
            <Button variant="ghost" disabled>下载中…</Button>
          )}

          {status === 'downloaded' && (
            <>
              <Button variant="ghost" onClick={dismiss}>稍后</Button>
              <Button onClick={quitAndInstall}>
                <RefreshCw size={13} />
                重启安装
              </Button>
            </>
          )}

          {status === 'portable-manual' && (
            <>
              <Button variant="ghost" onClick={dismiss}>关闭</Button>
              <Button onClick={openReleases}>
                <ExternalLink size={13} />
                前往 Releases
              </Button>
            </>
          )}

          {status === 'error' && <Button variant="ghost" onClick={dismiss}>关闭</Button>}
        </div>
      </div>
    </div>
  )
}

function HeaderIcon({ status }: { status: string }) {
  const color = status === 'error' ? 'var(--color-error)' : 'var(--color-accent)'
  if (status === 'downloaded') return <CheckCircle2 size={16} style={{ color }} />
  if (status === 'error') return <AlertTriangle size={16} style={{ color }} />
  if (status === 'portable-manual') return <ExternalLink size={16} style={{ color }} />
  return <Download size={16} style={{ color }} />
}

function titleFor(status: string): string {
  switch (status) {
    case 'available': return '发现新版本'
    case 'downloading': return '正在下载更新'
    case 'downloaded': return '更新已就绪'
    case 'portable-manual': return '请手动更新'
    case 'error': return '更新失败'
    default: return '更新'
  }
}
