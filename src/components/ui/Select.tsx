import * as RadixSelect from '@radix-ui/react-select'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
  /** 原生 title 提示 */
  title?: string
}

/**
 * 自定义下拉选择器（基于 Radix Select）。
 * 替代原生 <select>：完全可主题化，弹层跟随熔炉/象牙等主题，不再出现系统白底菜单。
 * 与原生 select 行高/字号一致（h-7 / text-xs）。
 */
export function Select({ value, onValueChange, options, placeholder, className, disabled, title }: SelectProps) {
  // 受控 value 不在 options 中时（如 AI 返回了列表外的枚举值），补一项以原值兜底展示，
  // 避免 Radix Select 触发器显示空白。空字符串/哨兵已由调用方保证在 options 内，无需补。
  const allOptions = value && !options.some((o) => o.value === value)
    ? [{ value, label: value }, ...options]
    : options
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        title={title}
        className={cn(
          'flex h-7 w-full items-center justify-between gap-1 rounded-md px-2 py-1 text-xs',
          'border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text)]',
          'outline-none focus:ring-1 focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)]',
          'data-[placeholder]:text-[var(--color-text-muted)] disabled:cursor-not-allowed disabled:opacity-50',
          'cursor-pointer transition-colors hover:border-[var(--color-accent)]',
          className,
        )}
      >
        {/* Radix Select.Value 会丢弃 className，故用外层 span 承载截断：长值（如 AI 兜底的列表外枚举）超出时省略号 */}
        <span className="min-w-0 flex-1 truncate text-left">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon>
          <ChevronDown size={13} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-[60] max-h-[280px] min-w-[var(--radix-select-trigger-width)] max-w-[min(18rem,var(--radix-select-content-available-width))] overflow-hidden rounded-lg',
            'border border-[var(--color-border)] bg-[var(--color-panel)] shadow-lg',
          )}
        >
          <RadixSelect.Viewport className="p-1">
            {allOptions.map((opt) => (
              <RadixSelect.Item
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                className={cn(
                  'relative flex cursor-pointer select-none items-start rounded-md py-1.5 pl-7 pr-2 text-xs leading-snug break-words',
                  'text-[var(--color-text)] outline-none',
                  'data-[highlighted]:bg-[var(--color-hover)] data-[highlighted]:text-[var(--color-text)]',
                  'data-[state=checked]:text-[var(--color-accent)] data-[state=checked]:font-medium',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
                )}
              >
                <RadixSelect.ItemIndicator className="absolute left-2 top-2 inline-flex items-center">
                  <Check size={12} style={{ color: 'var(--color-accent)' }} />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
