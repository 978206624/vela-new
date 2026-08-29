/**
 * partial-json — 从**尚未结束**的 JSON 流里取出某个字符串字段的当前内容
 *
 * ## 为什么需要它
 *
 * 卷大纲这类产物是**单个 JSON 对象**（`{"synopsis":"..."}`）。流式生成时，
 * 中途任何一刻拿到的都是半截 JSON，`JSON.parse` 必然抛错——于是「边生成边看」
 * 只能二选一：要么整场空白直到结束，要么把原始 JSON 串连转义符一起显示给用户。
 * 两个都不能接受（设计稿 30 要求大纲区实时打字机输出 + 光标）。
 *
 * 本模块的做法是**只解析到需要的那一个字段为止**：定位 `"key"` 之后的开引号，
 * 逐字符解转义直到遇到未转义的收引号或串尾。串尾即停——半截转义序列
 * （结尾恰好是 `\` 或 `\u12`）**整段丢弃**，而不是原样输出：那几个字符
 * 在下一个 chunk 到达后才会变成一个真正的字符，提前吐出去会让预览闪一下乱码。
 *
 * ## 为什么放在 `src/shared/`
 *
 * 与 `volume-limits.ts` 同理：本模块必须能被 harness 直接 import 做纯函数验证，
 * 而它不依赖 React、不依赖 window、不依赖任何 store。放进组件文件就只能靠人工点。
 *
 * ## 证明力边界
 *
 * 只找**第一处** `"key"`，不做 JSON 结构分析。若模型在别的字符串值里原样写下
 * `"synopsis":`，本函数会定位到那一处。取舍：真正的增量 JSON 解析器要维护
 * 完整的对象/数组栈，代价远大于收益——而这里的消费方是**预览**，
 * 预览错了下一个 chunk 就会纠正，最终落库用的仍是 `JSON.parse` 的权威结果。
 */

/** JSON 双引号字符串里的单字符转义表 */
const SIMPLE_ESCAPES: Record<string, string> = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
}

/**
 * 从（可能不完整的）JSON 文本里取出 `key` 对应的字符串值的**当前已到达部分**。
 *
 * @returns 已解转义的文本；`key` 尚未出现、或它后面还没跟上开引号时返回 `null`。
 *          注意 `''`（已开引号但还没有内容）与 `null`（还没开始）是**不同的**结论：
 *          前者说明模型已经开始写这一字段，UI 该切成「输出中」；后者不该。
 */
export function extractPartialJSONString(raw: string, key: string): string | null {
    if (!raw) return null

    // 定位 `"key"` —— 用带引号的完整 token 匹配，避免命中 `"suggested_key"` 这类后缀重名
    const marker = `"${key}"`
    const keyAt = raw.indexOf(marker)
    if (keyAt < 0) return null

    // 跳过 key 与冒号之间、冒号与开引号之间的空白
    let i = keyAt + marker.length
    while (i < raw.length && /\s/.test(raw[i])) i++
    if (i >= raw.length) return null
    if (raw[i] !== ':') return null
    i++
    while (i < raw.length && /\s/.test(raw[i])) i++
    if (i >= raw.length) return null
    // 值还没开始写成字符串（可能是 null / 数字，或流刚好停在这里）→ 视作「尚未开始」
    if (raw[i] !== '"') return null
    i++

    let out = ''
    while (i < raw.length) {
        const ch = raw[i]

        if (ch === '"') return out          // 未转义的收引号 = 该字段已完整
        if (ch !== '\\') { out += ch; i++; continue }

        // ── 转义序列 ──
        // 半截转义（`\` 是流的最后一个字符）：**整段丢弃**。
        // 原样输出一个反斜杠，会在下一个 chunk 到达时被替换掉，预览闪一下乱码
        if (i + 1 >= raw.length) return out

        const esc = raw[i + 1]
        const simple = SIMPLE_ESCAPES[esc]
        if (simple !== undefined) { out += simple; i += 2; continue }

        if (esc === 'u') {
            // `\uXXXX` 需要 4 位十六进制。不足 4 位说明流停在中间 → 丢弃，等下一段
            const hex = raw.slice(i + 2, i + 6)
            if (hex.length < 4) return out
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                // 非法转义：按字面量原样保留，不抛错。
                // 预览的职责是尽量把内容显示出来，不是校验模型输出的合法性
                out += `\\u${hex}`
                i += 6
                continue
            }
            const code = parseInt(hex, 16)
            // 处理 UTF-16 代理对：高代理项（U+D800–U+DBFF）必须等下一个 \uXXXX
            // 拼出低代理项（U+DC00–U+DFFF），否则单独输出就是「替换字符」。
            // 流停在高代理项后面、或停在低代理项的中间段，都**不输出**——
            // 让它闪一下乱码后变成 emoji 与「先把乱码替换掉再贴正确字符」相比，
            // 哪一种体验更糟没有悬念
            if (code >= 0xD800 && code <= 0xDBFF) {
                const peek = raw.slice(i + 6, i + 12)
                if (peek.length < 6 || peek[0] !== '\\' || peek[1] !== 'u') return out
                const hex2 = peek.slice(2, 6)
                if (!/^[0-9a-fA-F]{4}$/.test(hex2)) return out
                const code2 = parseInt(hex2, 16)
                if (code2 < 0xDC00 || code2 > 0xDFFF) return out
                out += String.fromCodePoint(code, code2)
                i += 12
                continue
            }
            // 流停在低代理项后面 / 停在中间：JSON 规范上低代理项必须跟在高代理项之后，
            // 单独出现就是非法。**不输出**孤立的低代理项，避免替换字符闪烁
            if (code >= 0xDC00 && code <= 0xDFFF) return out
            out += String.fromCharCode(code)
            i += 6
            continue
        }

        // 未知转义（非法 JSON）：原样保留反斜杠与其后一字符，继续往下走
        out += `\\${esc}`
        i += 2
    }

    // 走到串尾也没等到收引号 —— 正常的「还在输出中」
    return out
}
