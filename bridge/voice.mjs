/**
 * 让 Telegram 这边也能"说话"——调用 dsh-voice 的 HTTP 接口拿一条 mp3。
 *
 * 之所以走 HTTP 而不是直接 import：dsh-voice 是另一个插件，跑在 dsh-web 里，
 * 桥是独立子进程，跨插件 import 会扯到依赖解析。HTTP 最省事，也最不容易互相带崩。
 *
 * 接口（见 repos/dsh-voice/index.js）：
 *   POST /api/voice/test  {text}  → {ok, url:'/api/voice/audio/xxx.mp3', ms}
 *   GET  /api/voice/audio/:f      → 音频字节
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.VOICE_API || 'http://10.0.0.10:3080';
const TIMEOUT = Number(process.env.VOICE_TIMEOUT_MS || 90_000);
const MAX_CHARS = 180;          // 太长的语音没人听完，超了就截断

let dir = null;
function cacheDir() {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'tgvoice-'));
  return dir;
}

/**
 * 文字 → 本地 mp3 路径
 * @returns {Promise<{path:string, ms:number}|null>} 失败返回 null（调用方静默降级成纯文字）
 */
export async function speak(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!clean) return null;
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/voice/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) { console.error(`  🔇 语音接口 ${r.status}`); return null; }
    const j = await r.json();
    if (!j?.url) { console.error('  🔇 语音接口没给 url'); return null; }
    const a = await fetch(BASE + j.url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!a.ok) { console.error(`  🔇 取音频 ${a.status}`); return null; }
    const buf = Buffer.from(await a.arrayBuffer());
    if (buf.length < 2000) { console.error('  🔇 音频太小，当失败'); return null; }
    const path = join(cacheDir(), `v-${Date.now()}.mp3`);
    writeFileSync(path, buf);
    return { path, ms: Date.now() - t0 };
  } catch (e) {
    console.error('  🔇 语音生成失败：', e.message);
    return null;
  }
}

/** 这句话是不是在要语音 */
export function wantsVoice(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/别打字|打字累|发语音|语音说|说句话|听听你|你的声音|用语音/.test(s)) return true;
  return false;
}

/** 平时偶尔自己发一条（不频繁，省 GPU） */
export function randomVoice() {
  return Math.random() < 0.06;
}
