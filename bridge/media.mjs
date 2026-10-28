/**
 * bridge/media.mjs —— 把 Telegram 各种消息统一描述成一段文字
 * ============================================================================
 * 为什么要做这一层：模型看到的只能是文字。贴纸/图片/语音/文件都得先变成
 * `[发来一个贴纸：哭唧唧的小人]` 这种，它才接得住话。
 *
 * 贴纸和图片会下载 → 视觉模型识别（见 vision.mjs）。原因：
 * Telegram 贴纸的 alt（关联 emoji）**不一定反映画面**，光看 alt 会理解错。
 * ============================================================================
 */
import { describeImage } from './vision.mjs'

/**
 * @param {object} cfg
 * @param {object} m     GramJS message
 * @param {{client?:object, download?:boolean}} [opts]
 * @returns {Promise<{text:string, kind:string}|null>}
 */
export async function describeMessage(cfg, m, { client, download = true } = {}) {
  if (m.message && m.message.trim()) return { text: m.message, kind: 'text' }
  if (!m.media) return null          // 服务类消息（入群、置顶等）直接忽略

  const c = m.media.className
  const doc = m.media.document

  async function vision(hint) {
    if (!download || !client || cfg.vision?.enabled === false) return null
    try {
      const buf = await client.downloadMedia(m.media, {})
      if (!buf || buf.length === 0) return null
      return await describeImage(cfg, buf, hint)
    } catch (e) {
      console.error('[media] 下载失败:', e?.message ?? e)
      return null
    }
  }

  if (c === 'MessageMediaDocument' && doc) {
    const attrs = (doc.attributes ?? []).map((a) => a.className)

    if (attrs.includes('DocumentAttributeSticker')) {
      const alt = doc.attributes.find((a) => a.className === 'DocumentAttributeSticker')?.alt?.trim?.()
      const desc = await vision('贴纸')
      if (desc) return { text: `[发来一个贴纸：${desc}]`, kind: 'sticker' }
      return { text: `[发来一个贴纸${alt ? ` ${alt}` : ''}]`, kind: 'sticker' }
    }

    if (attrs.includes('DocumentAttributeCustomEmoji')) {
      const e = doc.attributes.find((a) => a.className === 'DocumentAttributeCustomEmoji')?.alt
      return { text: `[发来一个表情 ${e ?? ''}]`.trim(), kind: 'emoji' }
    }

    if (attrs.includes('DocumentAttributeAudio') && m.media.voice) {
      const d = doc.attributes.find((a) => a.className === 'DocumentAttributeAudio')?.duration ?? 0
      return { text: `[发来一条语音，${d} 秒]`, kind: 'voice' }
    }

    if (attrs.includes('DocumentAttributeVideo')) return { text: '[发来一段视频]', kind: 'video' }
    if (attrs.includes('DocumentAttributeAnimated')) return { text: '[发来一个动图]', kind: 'gif' }

    if (attrs.includes('DocumentAttributeFilename')) {
      const n = doc.attributes.find((a) => a.className === 'DocumentAttributeFilename')?.fileName ?? '文件'
      return { text: `[发来一个文件：${n}]`, kind: 'file' }
    }

    if (attrs.includes('DocumentAttributeImageSize') || doc.mimeType?.startsWith('image/')) {
      const desc = await vision('图片')
      return desc ? { text: `[发来一张图片：${desc}]`, kind: 'image' } : { text: '[发来一张图片]', kind: 'image' }
    }

    return { text: '[发来一个附件]', kind: 'document' }
  }

  if (c === 'MessageMediaPhoto') {
    const desc = await vision('图片')
    return desc ? { text: `[发来一张图片：${desc}]`, kind: 'photo' } : { text: '[发来一张图片]', kind: 'photo' }
  }

  if (c === 'MessageMediaGeo' || c === 'MessageMediaGeoLive') return { text: '[发来一个位置]', kind: 'geo' }
  if (c === 'MessageMediaContact') return { text: '[发来一张名片]', kind: 'contact' }
  if (c === 'MessageMediaPoll') return { text: '[发来一个投票]', kind: 'poll' }
  if (c === 'MessageMediaWebPage') return m.message ? { text: m.message, kind: 'text' } : null

  return { text: '[发来一条不支持的消息]', kind: 'unknown' }
}
