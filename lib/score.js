/**
 * 评分引擎：把"最合适"拆成可解释的分项。
 *
 * 五个维度（权重可调，导出在 {@link WEIGHTS}）：
 *  1. **兼容性 40** —— 能否在你这版 DSH 上装（唯一有硬依据的一项）
 *  2. **活跃度 25** —— 最近推送时间（越新越可能还在维护）
 *  3. **人气 20** —— 星数对数化；npm 来源用 registry 的 popularity 分
 *  4. **维护健康 10** —— open issue 相对比例；仓库归档直接判 0
 *  5. **风险 5** —— 扣分项：归档、安装期脚本、peer 声明异常膨胀
 *
 * 输出：`{ score, scoreParts, checklist, caveats }`，
 * `checklist` 是"为什么给这个分"的人话依据，`caveats` 是需要提醒的风险/未知。
 */

export const WEIGHTS = {
  compatibility: 40,
  activity: 25,
  popularity: 20,
  health: 10,
  risk: 5,
}

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
    const score = Math.max(0, Math.min(WEIGHTS.popularity, Math.round(Math.log10(stars + 1) * 5)))
    return { score, label: `★${stars}`, caveat: null }
  }
  if (typeof npmPopularity === 'number' && Number.isFinite(npmPopularity)) {
    return {
      score: Math.max(0, Math.min(WEIGHTS.popularity, Math.round(npmPopularity * WEIGHTS.popularity))),
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

/** 风险：扣分项（满分 = WEIGHTS.risk）。 */
export function scoreRisk({ archived, hasInstallScript, peerCount } = {}) {
  let score = WEIGHTS.risk
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

/** 兼容性：唯一有硬依据的维度（来自 manifest 的 engines/peer 原文）。 */
export function scoreCompatibility(compat) {
  if (!compat) return { score: 15, label: '未做体检', caveat: '未检查版本兼容性' }
  if (compat.status === 'ok') {
    const basis = compat.fieldUsed === 'engines.dsh' ? `engines.dsh ${compat.requirements?.['engines.dsh'] ?? ''}` : 'peer 范围'
    return { score: WEIGHTS.compatibility, label: `兼容（${basis}）`, caveat: null }
  }
  if (compat.status === 'none') {
    return {
      score: 20,
      label: '未声明任何版本要求',
      caveat: '没有 engines.dsh 也没有 dsh peer —— 门禁不拦，但不保证能用',
    }
  }
  if (compat.status === 'incompatible') {
    return { score: 0, label: '与当前 DSH 版本不兼容', caveat: '装不上的：门禁会把它 disabled，模块永不导入' }
  }
  return { score: 10, label: '体检失败', caveat: '无法判断兼容性' }
}

/**
 * 给一个候选打分。
 * @param {object} item 候选（stars / pushedAt / openIssues / archived / npmPopularity 等）
 * @param {{compat?: object}} options compat = evaluateCompat 的结果
 */
export function scoreCandidate(item = {}, { compat } = {}) {
  const compatibility = scoreCompatibility(compat)
  const activity = scoreActivity(item.pushedAt)
  const popularity = scorePopularity({ stars: item.stars, npmPopularity: item.npmPopularity })
  const health = scoreHealth({ openIssues: item.openIssues, stars: item.stars, archived: item.archived })
  const risk = scoreRisk({ archived: item.archived, hasInstallScript: item.hasInstallScript, peerCount: item.peerCount })

  const scoreParts = {
    compatibility: compatibility.score,
    activity: activity.score,
    popularity: popularity.score,
    health: health.score,
    risk: risk.score,
  }
  const subtotal = Object.values(scoreParts).reduce((sum, value) => sum + value, 0)

  // ⚠️ 一票否决：与当前 DSH 版本不兼容的插件**根本装不上**（门禁会 disabled、模块永不导入），
  // 人气再高也不能算「合适」—— 总分直接归零，排序时沉底（2026-10-31 用户指正）。
  const vetoed = compat?.status === 'incompatible'

  const checklist = [compatibility.label, activity.label, popularity.label, health.label]
  const caveats = [compatibility.caveat, activity.caveat, popularity.caveat, health.caveat, ...risk.caveats].filter(
    (text) => typeof text === 'string' && text !== '',
  )
  if (vetoed) caveats.unshift('与当前 DSH 版本不兼容 —— 装了也会被门禁 disabled，等于白装')

  return { score: vetoed ? 0 : subtotal, subtotal, vetoed, scoreParts, checklist, caveats }
}

/** 一行可读说明（放进 summary）。 */
export function explainScore(result) {
  if (!result) return ''
  const parts = Object.entries(result.scoreParts ?? {})
    .map(([key, value]) => `${labelOf(key)} ${value}`)
    .join(' · ')
  return `评分 ${result.score}（${parts}）`
}

function labelOf(key) {
  return (
    {
      compatibility: '兼容',
      activity: '活跃',
      popularity: '人气',
      health: '健康',
      risk: '风险',
    }[key] ?? key
  )
}
