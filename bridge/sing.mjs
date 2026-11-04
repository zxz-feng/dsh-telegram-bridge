/**
 * 点唱（TG 版）：spawn 一个子进程去跑 B站→换声，拿回一条 mp3 路径。
 *
 * 为什么是子进程：歌名筛选那套模块长在 QQ 桥里、按 QQ 的目录写死了路径。
 * 隔一层进程最省事——它崩了不会带崩 TG 桥，环境也不互相污染。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const SCRIPT = process.env.SING_SCRIPT || '/root/工位/qq-bridge/tools/sing-once.mjs';
const NODE = process.execPath;

/** 这句话是不是在点歌 */
export function parseSing(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  let s = raw
  if (!s || s.length > 30) return ''
  // 「我说/你/给我/我想听」这类垫话先剥掉，否则句子不从「唱」开头就识别不到
  s = s.replace(/^(?:我说|那我说|我说你|那你|你给我|给我|你|我想听|我想|我想听你|请|好|嗯|诶|诶你|哎)[\s,，]*/g, '')
  // 带书名号最可靠
  const b = raw.match(/《([^》]{1,16})》/)
  if (b) return strip(b[1])
  // 「我想听夜曲」「想听你唱晴天」——没有动词也能认
  const w = raw.match(/^(?:我想听你唱|想听你唱|我想听|想听你唱|想听)\s*[「"“']?([^」"”'，。]{1,14})/)
  if (w) { const n = strip(w[1]); if (n) return n }
  // 长的前缀必须排前面，否则「唱个后来」会被「唱」吃掉
  const m = s.match(/^(?:唱一首|唱一个|唱一支|唱首|唱个|唱|点歌|点一首|点首|来一首|来一首歌|来首|来一段|放一首|整一首)\s*[「"“']?([^」"”']{1,16})[」"”']?(?:吧|呗|呀|啊)?$/)
  return m ? strip(m[1]) : ''
}

/** 「首雨爱」「一首雨爱」这种把量词吃进歌名的情况，剥掉 */
function strip(name) {
  let n = String(name || '').trim()
  // 「唱得真好」「唱了起来」这种是动词补语，不是歌名
  if (/^(?:得|的|到|起|完|过|着|了|真|好|不|一?下|一?遍)/.test(n)) return ''
  n = n.replace(/^(?:一?首|一?支|一?曲)\s*/, '')
  n = n.replace(/[的吧呗呀啊嘛]+$/, '')
  return n.trim()
}

/**
 * 跑一次点唱
 * @returns {Promise<{ok:boolean, file?:string, title?:string, ms?:number, reason?:string}>}
 */
export function runSing(song) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(NODE, [SCRIPT, song], { timeout: 420_000, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '';
        try {
          const j = JSON.parse(line);
          if (j.ok && j.file && existsSync(j.file)) {
            resolve({ ok: true, file: j.file, title: j.title, ms: Date.now() - t0 });
            return;
          }
          resolve({ ok: false, reason: j.reason || '没结果' });
        } catch {
          const tail = String(stderr || '').trim().split('\n').slice(-2).join(' | ');
          resolve({ ok: false, reason: (err?.message || tail || '脚本没输出').slice(0, 100) });
        }
      });
  });
}
