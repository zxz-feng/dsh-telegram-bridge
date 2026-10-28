#!/usr/bin/env node
/**
 * scripts/import-stickers.mjs —— 把**你自己账号里装了的贴纸**做成索引
 * ============================================================================
 * 贴纸索引属于账号，不随插件发布（别人的 id/accessHash 对你不成立）。
 * 所以新机器上想让她会发贴纸，就跑一次这个：
 *
 *   node scripts/import-stickers.mjs            # 全部贴纸集，视觉识别（要网关）
 *   node scripts/import-stickers.mjs --no-desc  # 只存 emoji，不调模型（省钱、快）
 *
 * 产出：`<家目录>/stickers-index.json`
 *   [{ id, accessHash, fileReference, emoji, mime, desc, tags[] }]
 *
 * ⚠️ fileReference 会过期（Telegram 的规矩）。发不出去时重跑一次就行 ——
 *    发送失败只会静默不发表情，不影响文字回复。
 * ============================================================================
 */
import { join } from 'node:path'
import { writeJson, dshHome } from '../lib/home.mjs'
import { loadConfig } from '../bridge/config.mjs'
import { makeClient, loadSession, hasSession } from '../bridge/client.mjs'
import { describeImage } from '../bridge/vision.mjs'

const PLUGIN_ID = 'telegram-bridge'
const HOME = process.env.BRIDGE_HOME || join(dshHome(), PLUGIN_ID)
const NO_DESC = process.argv.includes('--no-desc')

const cfg = loadConfig(HOME)
if (!hasSession(HOME)) {
  console.error('还没登录，先跑起来登录一次（tg_login_start），再来导贴纸')
  process.exit(1)
}

const client = makeClient(cfg, loadSession(HOME))
await client.connect()

const { Api } = await import('telegram')

console.log('取已安装的贴纸集…')
const res = await client.invoke(new Api.messages.GetAllStickers({ hash: 0 }))
const sets = res?.sets ?? []
console.log(`共 ${sets.length} 个贴纸集`)

const out = []
for (const set of sets) {
  const full = await client.invoke(new Api.messages.GetStickerSet({
    stickerset: new Api.InputStickerSetID({ id: set.id, accessHash: set.accessHash }),
    hash: 0,
  })).catch(() => null)
  const docs = full?.documents ?? []
  console.log(`- ${set.title}（${docs.length} 张）`)

  for (const doc of docs) {
    const stickerAttr = (doc.attributes ?? []).find((a) => a.className === 'DocumentAttributeSticker')
    const emoji = stickerAttr?.alt?.trim?.() ?? ''
    let desc = ''
    if (!NO_DESC) {
      try {
        const buf = await client.downloadMedia(doc, {})
        if (buf?.length) desc = (await describeImage(cfg, buf, '贴纸')) ?? ''
      } catch { /* 单张失败不影响整批 */ }
    }
    out.push({
      id: String(doc.id),
      accessHash: String(doc.accessHash),
      fileReference: Buffer.from(doc.fileReference ?? []).toString('base64'),
      emoji,
      mime: doc.mimeType ?? '',
      setId: String(set.id),
      setTitle: set.title ?? '',
      desc,
      tags: [emoji, ...(desc ? [desc.slice(0, 6)] : [])].filter(Boolean),
    })
    process.stdout.write(`\r  已处理 ${out.length} 张…`)
  }
}

writeJson(join(HOME, 'stickers-index.json'), out)
console.log(`\n写好了：${join(HOME, 'stickers-index.json')}（${out.length} 条）`)
await client.disconnect().catch(() => {})
process.exit(0)
