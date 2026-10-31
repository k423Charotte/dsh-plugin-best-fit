/**
 * Host 侧的配置路由（给输入框上的浮窗读写用）。
 *
 * 设计要点（照 bili-duty 已验证的形态）：
 *  - **不能**直接 `ctx.get('webServer')`：冷启动时它可能还没就绪 → 用 `ctx.inject(['webServer'], cb)` 等；
 *  - `webServer.register()` 的 disposer **必须**交给 `ctx.effect`，否则禁用/重载后旧路由不释放，
 *    webServer 会以 "duplicate exact route" 拒绝下一次激活；
 *  - 每个 handler 都套一层守卫：① 只允许 loopback 来源（含 Origin 校验，GET 也检查） ② 异常不外抛。
 */

import { publicConfig, writeConfig, writeToken } from './config.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

/** 来源校验：只接受本机回环（浏览器同源页面）。返回拒绝码或 null。 */
function requestRejection(req) {
  try {
    const hostHeader = String(req?.headers?.host ?? '')
    const hostname = hostHeader.split(':')[0].replace(/^\[|\]$/g, '')
    if (!LOOPBACK.has(hostname)) return 'HOST_NOT_LOOPBACK'
    const origin = req?.headers?.origin
    if (typeof origin === 'string' && origin !== '') {
      try {
        const parsed = new URL(origin)
        if (!LOOPBACK.has(parsed.hostname)) return 'ORIGIN_NOT_LOOPBACK'
      } catch {
        return 'ORIGIN_INVALID'
      }
    }
    return null
  } catch {
    return 'GUARD_THREW'
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

async function readBody(req, limit) {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 等 webServer 就绪再回调（拿不到就静默放弃，不阻塞宿主）。 */
export function whenWebServer(ctx, callback) {
  const read = () => (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  const immediate = read()
  if (immediate && typeof immediate.register === 'function') {
    callback(immediate)
    return
  }
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (scoped) => {
      const server =
        scoped && typeof scoped.get === 'function' ? scoped.get('webServer') : scoped && scoped.webServer
      if (server && typeof server.register === 'function') callback(server)
    })
  } catch {
    /* 注入失败就不注册路由，工具本身仍然可用 */
  }
}

/**
 * 注册配置路由。
 * - `GET  /best-fit/config.json` → 当前配置（token 只回显后 4 位）
 * - `POST /best-fit/config.json` → 局部更新配置；`token` 字段单独落到 credential.json
 */
export function registerRoutes(ctx, log) {
  const route = (meta, handler) => {
    whenWebServer(ctx, (server) => {
      try {
        ctx.effect(() => {
          const dispose = server.register({
            ...meta,
            handler: async (req, res) => {
              const denied = requestRejection(req)
              if (denied !== null) {
                try {
                  json(res, 403, { ok: false, error: `已拒绝该请求（${denied}）` })
                } catch {
                  /* 响应写不出去就只能作罢 */
                }
                return
              }
              try {
                await handler(req, res)
              } catch (error) {
                try {
                  log?.warn?.(`[best-fit] 路由 ${meta.path} 处理失败：${String(error?.message || error)}`)
                } catch {
                  /* 日志失败无所谓 */
                }
                try {
                  json(res, 500, { ok: false, error: String(error?.message || error) })
                } catch {
                  /* 已发送则忽略 */
                }
              }
            },
          })
          return () => {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* 释放失败不阻塞卸载 */
            }
          }
        })
      } catch (error) {
        try {
          log?.warn?.(`[best-fit] 注册路由失败：${String(error?.message || error)}`)
        } catch {
          /* 忽略 */
        }
      }
    })
  }

  // ⚠️ 同一个 path 只能注册**一次**：webServer 按 exact path 做键，重复注册会被拒，
  //    表现为 POST 打到 GET handler → 405（实测）。所以按 method 在一个 handler 里分发。
  route({ kind: 'exact', path: '/best-fit/config.json' }, async (req, res) => {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, config: publicConfig() })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }
    const body = JSON.parse((await readBody(req, 32 * 1024)) || '{}')
    if (body && typeof body === 'object' && Object.hasOwn(body, 'token')) {
      writeToken(body.token)
    }
    writeConfig(body ?? {})
    json(res, 200, { ok: true, config: publicConfig() })
  })
}
