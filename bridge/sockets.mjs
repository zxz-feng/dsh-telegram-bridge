/**
 * bridge/sockets.mjs —— 让 GramJS 的裸 TCP 连接走 SOCKS5
 * ============================================================================
 * 为什么要自己写（这个坑踩过一次，别删）：
 *   · GramJS 的 `proxy` 选项**只支持 MTProxy**，不支持普通 SOCKS5/HTTP
 *   · Node 的 NODE_USE_ENV_PROXY 也不作用于 net.connect 的裸 socket
 *   ⇒ 实现一个与 PromisedNetSockets 同形的类，把 connect 换成经代理建连，
 *     再通过 client 的 `networkSocket` 参数注入。
 *
 * 不需要代理时（本地直连就通）这段代码不会被用到。
 * ============================================================================
 */
import { SocksClient } from 'socks'

export class ProxiedNetSockets {
  /** @param {{host:string, port:number, type:number}} socksProxy */
  constructor(socksProxy) {
    this.proxy = socksProxy
    this.closed = false
    this.stream = null
    this.canRead = null
    this.resolveRead = null
    this._pending = null
  }

  async connect(port, ip) {
    const { socket } = await SocksClient.createConnection({
      proxy: this.proxy,
      command: 'connect',
      destination: { host: ip, port },
      timeout: 20000,
    })
    this.stream = socket
    socket.on('close', () => { this.closed = true })
    socket.on('error', () => { this.closed = true })
    socket.on('data', (chunk) => {
      if (this.canRead) {
        const resolve = this.resolveRead
        this.canRead = null
        this.resolveRead = null
        resolve(chunk)
      } else {
        this._pending = this._pending ? Buffer.concat([this._pending, chunk]) : chunk
      }
    })
  }

  _read() {
    if (this._pending && this._pending.length > 0) {
      const buf = this._pending
      this._pending = null
      return Promise.resolve(buf)
    }
    this.canRead = true
    return new Promise((resolve) => { this.resolveRead = resolve })
  }

  async read(number) {
    const chunk = await this._read()
    if (chunk.length <= number) return chunk
    this._pending = chunk.subarray(number)
    return chunk.subarray(0, number)
  }

  async readExactly(number) {
    let out = Buffer.alloc(0)
    while (out.length < number) {
      const chunk = await this._read()
      out = Buffer.concat([out, chunk])
      if (out.length > number) {
        this._pending = out.subarray(number)
        return out.subarray(0, number)
      }
    }
    return out
  }

  async readAll() { return this._read() }

  write(data) {
    if (this.stream && !this.closed) this.stream.write(data)
  }

  async close() {
    this.closed = true
    if (this.stream) { this.stream.destroy(); this.stream = null }
  }

  async receive() { return this._read() }

  toString() { return 'ProxiedNetSockets(socks5)' }
}

/** socks5://user:pass@host:port → { host, port, type, userId, password } */
export function parseSocks(url) {
  const u = new URL(url)
  const port = Number(u.port || 1080)
  return {
    host: u.hostname,
    port,
    type: 5,
    ...(u.username ? { userId: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  }
}
