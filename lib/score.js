/**
 * 评分引擎：把「最合适」拆成**两层**。
 *
 * ── 第一层：兼容性（门槛，不是分数）────────────────────────────────────
 *  能不能装是**前置条件**：不兼容的插件装了会被门禁 disabled、模块永不导入，
 *  所以它不参与质量分，只决定**分层**：
 *    `ok`      可用（engines.dsh / peer 覆盖当前版本，或干脆没声明 —— 门禁不拦）
 *    `unknown` 无法判断（取不到 manifest / 体检失败 / 没体检）
 *    `blocked` 不兼容（连用都用不了）
 *    `ignored` 用户关掉了「考虑兼容」——不拦、不分层，纯按质量分排序
 *
 * ── 第二层：质量分（满分 60）──────────────────────────────────────────
 *  只在「能装」的里面比"好不好用"：
 *    活跃度 25（最近推送）+ 人气 20（星数对数 / npm popularity）+ 维护健康 10（open issue 比例）+ 风险 5（扣分项）
 *
 * 输出：`{ qualityScore, qualityParts, compatTier, compatLabel, checklist, caveats }`
 */

/** 质量分权重（满分 60）—— 兼容性不在这里，它是独立门槛。 */
export const QUALITY_WEIGHTS = {
  activity: 25,
  popularity: 20,
  health: 10,
  risk: 5,
}

/** 兼容性分层，排序时按此优先级：可用 → 无法判断 → 不兼容。 */
export const COMPAT_TIER_RANK = { ok: 0, ignored: 0, unknown: 1, blocked: 2 }

const DAY = 24 * 60 * 60 * 1000

const daysSince = (iso, now) => {
  const at = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(at)) return null
  return Math.max(0, (now - at) / DAY)
}

/** 活跃度：最近推送越近越高。 */
export function scoreActivity(pushedAt, now = Date.now()) {
  const days = daysSince(pushedAt, now)
  if (days === null) return { score: 10, label: '推送时间未知', caveat: null }
  if (days <= 7) return { score: 25, label: '7 天内有推送', caveat: null }
  if (days <= 30) return { score: 20, label: '30 天内有推送', caveat: null }
  if (days <= 90) return { score: 12, label: `最近推送约 ${Math.round(days)} 天前`, caveat: null }
  if (days <= 180) return { score: 6, label: `最近推送约 ${Math.round(days / 30)} 个月前`, caveat: '可能已放缓维护' }
  return { score: 0, label: `已超过 ${Math.round(days / 30)} 个月没有推送`, caveat: '疑似停更' }
}

/** 人气：星数对数化（10→5、100→10、1000→15、10000→20）；npm 来源用 popularity 分。 */
export function scorePopularity({ stars, npmPopularity } = {}) {
  if (typeof stars === 'number' && stars >= 0) {
    const score = Math.max(0, Math.min(QUALITY_WEIGHTS.popularity, Math.round(Math.log10(stars + 1) * 5)))
    return { score, label: `★${stars}`, caveat: null }
  }
  if (typeof npmPopularity === 'number' && Number.isFinite(npmPopularity)) {
    return {
      score: Math.max(0, Math.min(QUALITY_WEIGHTS.popularity, Math.round(npmPopularity * QUALITY_WEIGHTS.popularity))),
      label: `npm popularity ${npmPopularity.toFixed(2)}`,
      caveat: null,
    }
  }
  return { score: 6, label: '人气未知（没取到星数/下载分）', caveat: '没有公开人气数据' }
}

/** 维护健康：open issue 相对星数的比例；归档直接 0。 */
export function scoreHealth({ openIssues, stars, archived } = {}) {
  if (archived === true) return { score: 0, label: '仓库已归档', caveat: '作者已停止维护，不要新用' }
  if (typeof openIssues !== 'number') return { score: 6, label: '维护状态未知', caveat: null }
  const base = typeof stars === 'number' && stars > 0 ? stars : null
  const ratio = base === null ? (openIssues > 0 ? 1 : 0) : openIssues / base
  if (ratio <= 0.02) return { score: 10, label: `${openIssues} 个 open issue（相对很少）`, caveat: null }
  if (ratio <= 0.05) return { score: 8, label: `${openIssues} 个 open issue`, caveat: null }
  if (ratio <= 0.15) return { score: 5, label: `${openIssues} 个 open issue（偏多）`, caveat: null }
  return { score: 2, label: `${openIssues} 个 open issue（很多）`, caveat: 'issue 积压可能意味着维护跟不上' }
}

/** 风险：扣分项（满分 = QUALITY_WEIGHTS.risk）。 */
export function scoreRisk({ archived, hasInstallScript, peerCount } = {}) {
  let score = QUALITY_WEIGHTS.risk
  const caveats = []
  if (archived === true) {
    score -= 3
    caveats.push('仓库已归档')
  }
  if (hasInstallScript === true) {
    score -= 5
    caveats.push('包含安装期脚本（preinstall/postinstall），安装时会在你机器上执行代码')
  }
  if (typeof peerCount === 'number' && peerCount > 20) {
    score -= 1
    caveats.push(`声明了 ${peerCount} 个 peer 依赖（可能是整包复制，升级时容易失配）`)
  }
  return { score: Math.max(0, score), caveats }
}

/**
 * 兼容性分类（门槛，不参与质量分）。
 * @param {object|undefined} compat evaluateCompat 的结果
 * @param {{consider?: boolean}} options `consider: false` 表示用户关掉了「考虑兼容」
 * @returns {{tier: 'ok'|'unknown'|'blocked'|'ignored', label: string, caveat: string|null}}
 */
export function classifyCompat(compat, { consider = true } = {}) {
  if (consider === false) {
    return { tier: 'ignored', label: '按设置未考虑兼容性', caveat: '你关掉了「考虑兼容」——这些插件未必能在当前 DSH 上运行' }
  }
  if (!compat) {
    return { tier: 'unknown', label: '未做体检', caveat: '未检查版本兼容性 —— 装之前最好单独验一下' }
  }
  if (compat.status === 'ok') {
    const basis =
      compat.fieldUsed === 'engines.dsh'
        ? `engines.dsh ${(compat.requirements && compat.requirements['engines.dsh']) || ''}`.trim()
        : 'peer 范围'
    return { tier: 'ok', label: `兼容（${basis}）`, caveat: null }
  }
  if (compat.status === 'none') {
    return {
      tier: 'ok',
      label: '未声明版本要求（门禁不拦）',
      caveat: '没有 engines.dsh 也没有 dsh peer —— 能装，但作者没承诺适配哪个版本',
    }
  }
  if (compat.status === 'incompatible') {
    return { tier: 'blocked', label: '不兼容（装了也用不了）', caveat: '门禁会把它 disabled，模块永不导入' }
  }
  return { tier: 'unknown', label: '体检失败，无法判断', caveat: '取不到 package.json，兼容性未知' }
}

/**
 * 给一个候选算质量分（不含兼容性）。
 * @param {object} item 候选（stars / pushedAt / openIssues / archived / npmPopularity 等）
 * @param {{compat?: object, considerCompat?: boolean}} options
 */
export function scoreCandidate(item = {}, { compat, considerCompat = true } = {}) {
  const activity = scoreActivity(item.pushedAt)
  const popularity = scorePopularity({ stars: item.stars, npmPopularity: item.npmPopularity })
  const health = scoreHealth({ openIssues: item.openIssues, stars: item.stars, archived: item.archived })
  const risk = scoreRisk({ archived: item.archived, hasInstallScript: item.hasInstallScript, peerCount: item.peerCount })

  const qualityParts = {
    activity: activity.score,
    popularity: popularity.score,
    health: health.score,
    risk: risk.score,
  }
  const qualityScore = Object.values(qualityParts).reduce((sum, value) => sum + value, 0)

  const compatInfo = classifyCompat(compat, { consider: considerCompat })

  const checklist = [compatInfo.label, activity.label, popularity.label, health.label]
  const caveats = [compatInfo.caveat, activity.caveat, popularity.caveat, health.caveat, ...risk.caveats].filter(
    (text) => typeof text === 'string' && text !== '',
  )
  if (compatInfo.tier === 'blocked') {
    caveats.unshift('与当前 DSH 版本不兼容 —— 装了也会被门禁 disabled，等于白装')
  }

  return {
    qualityScore,
    qualityParts,
    compatTier: compatInfo.tier,
    compatLabel: compatInfo.label,
    scoreParts: qualityParts,
    checklist,
    caveats,
  }
}

/** 一行可读说明。 */
export function explainScore(result) {
  if (!result) return ''
  const parts = Object.entries(result.qualityParts ?? result.scoreParts ?? {})
    .map(([key, value]) => `${labelOf(key)} ${value}`)
    .join(' · ')
  return `质量分 ${result.qualityScore ?? 0}/60（${parts}）· 兼容 ${result.compatTier ?? 'unknown'}`
}

function labelOf(key) {
  return (
    {
      activity: '活跃',
      popularity: '人气',
      health: '健康',
      risk: '风险',
    }[key] ?? key
  )
}
