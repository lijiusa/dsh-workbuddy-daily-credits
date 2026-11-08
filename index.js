/**
 * WorkBuddy 每日积分 —— Host 半身。
 *
 * 只做一件事：把 WorkBuddy（国内版 CodeBuddy / 国际版 WorkBuddy）的每日签到积分
 * 与福利活动积分领到手，并给出余额与状态。认证走官方网页 OAuth，
 * 所以**不需要安装 WorkBuddy 桌面客户端**。
 *
 * 上游接口与请求头对齐官方 WorkBuddy 插件（dsh-connect-workbuddy）的实现，
 * 但只保留签到/福利/余额所需的部分，不含模型接入、账号池、CLI 桥接等大块功能。
 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'workbuddy-daily-credits'

/** 插件在浏览器端的 API 前缀（Host 与 Client 共用同一段路径）。 */
const ROUTE_PREFIX = '/api/dsh-workbuddy-daily-credits'

/** 凭据记录键：必须是 `<scope>/<id>` 两段小写连字符形式。 */
const CREDENTIAL_KEY = 'dsh-workbuddy-daily-credits/account'

const API_PREFIX = '/v2/plugin'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BILLING_BASE = 'https://www.workbuddy.ai'
const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const OAUTH_TTL_MS = 10 * 60 * 1000

const BENEFIT_STATUS_PATHS = {
  compensation: '/billing/meter/compensation-status',
  gift: '/billing/meter/check-gift-claimed',
}
const BENEFIT_CLAIM_PATHS = {
  compensation: '/billing/meter/claim-compensation',
  gift: '/billing/meter/claim-gift',
}

/** 登录会话（内存态，宿主重启即失效）。 */
const sessions = new Map()

/* ------------------------------------------------------------------ *
 * 区域与域名
 * ------------------------------------------------------------------ */

/** 按登录返回的 domain 判定区域：*.workbuddy.ai / *.codebuddy.ai 是国际版，其余按国内版。 */
function regionOfDomain(domain) {
  const host = String(domain ?? '').toLowerCase()
  if (host === 'workbuddy.ai' || host.endsWith('.workbuddy.ai')) return 'global'
  if (host === 'codebuddy.ai' || host.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/** 国际版可能用 www.codebuddy.ai 独立域名。 */
function globalBase(domain) {
  const host = String(domain ?? '').toLowerCase()
  if (host === 'codebuddy.ai' || host.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BILLING_BASE
}

/** 计费/签到域名。 */
function billingBase(domain) {
  return regionOfDomain(domain) === 'global' ? globalBase(domain) : CN_BILLING_BASE
}

/** 令牌刷新域名。 */
function chatBase(domain) {
  return regionOfDomain(domain) === 'global' ? globalBase(domain) : CN_CHAT_BASE
}

/** 地域选择：cn = 国内版（CodeBuddy），global = 国际版（WorkBuddy）。 */
function billingBaseForRegion(region) {
  return region === 'global' ? GLOBAL_BILLING_BASE : CN_BILLING_BASE
}

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 上游统一信封 `{code, msg, data}`。 */
function envelopeOk(envelope) {
  return envelope.code === 0 || envelope.code === 200
}

function envelopeMessage(envelope) {
  if (!isPlainObject(envelope)) return ''
  const msg = envelope.msg ?? envelope.message ?? envelope.error
  return typeof msg === 'string' ? msg.slice(0, 200) : ''
}

/** 发一个 JSON 请求，返回解析后的信封。 */
async function postJson(url, headers, body) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: body ?? '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法访问 WorkBuddy 服务（${message}）`)
  }
  const text = await response.text()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error(`WorkBuddy 返回了非 JSON 内容（http ${response.status}）`)
  }
  if (!response.ok || !envelopeOk(envelope)) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('WorkBuddy 拒绝了当前凭据，请重新登录')
    }
    const detail = envelopeMessage(envelope)
    throw new Error(detail === '' ? `WorkBuddy 请求失败（http ${response.status}）` : `WorkBuddy 请求失败：${detail}`)
  }
  return isPlainObject(envelope.data) ? envelope.data : {}
}

/** 发一个 GET 请求，返回解析后的信封。 */
async function getJson(url, headers) {
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法访问 WorkBuddy 服务（${message}）`)
  }
  const text = await response.text()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error(`WorkBuddy 返回了非 JSON 内容（http ${response.status}）`)
  }
  if (!response.ok || !envelopeOk(envelope)) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('WorkBuddy 拒绝了当前凭据，请重新登录')
    }
    const detail = envelopeMessage(envelope)
    throw new Error(detail === '' ? `WorkBuddy 请求失败（http ${response.status}）` : `WorkBuddy 请求失败：${detail}`)
  }
  return isPlainObject(envelope.data) ? envelope.data : {}
}

/** 把 `YYYY-MM-DD HH:MM:SS` 之类的本地时间解析成毫秒时间戳。 */
function parseLocalInstant(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (match === null) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    match[6] === undefined ? 0 : Number(match[6]),
  ).getTime()
}

function toNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 把任意值整理成可无损 JSON 化的副本。
 *
 * 宿主的 tool 输出契约要求「lossless JSON」：嵌套的 `undefined`、NaN、Infinity
 * 都会被判为非法值。所以这里统一丢掉 undefined、把非法数字收敛成 0。
 */
function toJsonSafe(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? value : 0
  if (type === 'string' || type === 'boolean') return value
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const safe = toJsonSafe(entry)
      return safe === undefined ? null : safe
    })
  }
  if (type === 'object') {
    const output = {}
    for (const [key, entry] of Object.entries(value)) {
      const safe = toJsonSafe(entry)
      if (safe !== undefined) output[key] = safe
    }
    return output
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} WorkBuddyAccount
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} [expiresAtMs]
 * @property {number} [refreshExpiresAtMs]
 * @property {string} domain
 * @property {string} [uid]
 * @property {string} [nickname]
 * @property {string} [uin]
 * @property {string} [enterpriseId]
 */

/** 读取已保存的账号凭据。 */
async function readAccount(credentials) {
  if (credentials === undefined) return undefined
  const record = await credentials.readRecord(CREDENTIAL_KEY)
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (!isPlainObject(payload)) return undefined
  if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) return undefined
  return payload
}

/** 写入账号凭据（唯一写路径：modifyRecord）。 */
async function writeAccount(credentials, account) {
  if (credentials === undefined) throw new Error('凭据服务不可用，无法保存登录状态')
  await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({
    kind: 'grant',
    payload: {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken ?? '',
      expiresAtMs: account.expiresAtMs ?? 0,
      refreshExpiresAtMs: account.refreshExpiresAtMs ?? 0,
      domain: account.domain ?? '',
      uid: account.uid ?? '',
      nickname: account.nickname ?? '',
      uin: account.uin ?? '',
      enterpriseId: account.enterpriseId ?? '',
    },
  }))
}

/** 清除账号凭据。 */
async function clearAccount(credentials) {
  if (credentials === undefined) return
  await credentials.deleteRecord(CREDENTIAL_KEY)
}

/* ------------------------------------------------------------------ *
 * 上游请求
 * ------------------------------------------------------------------ */

function commonHeaders(domain) {
  const origin = billingBase(domain)
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': CLIENT_UA,
  }
}

function billingHeaders(account) {
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (typeof account.uid === 'string' && account.uid.length > 0) headers['X-User-Id'] = account.uid
  if (typeof account.enterpriseId === 'string' && account.enterpriseId.length > 0) {
    headers['X-Enterprise-Id'] = account.enterpriseId
    headers['X-Tenant-Id'] = account.enterpriseId
  }
  if (typeof account.domain === 'string' && account.domain.length > 0) headers['X-Domain'] = account.domain
  return headers
}

function refreshHeaders(account) {
  const headers = {
    ...commonHeaders(account.domain),
    'X-Refresh-Token': account.refreshToken ?? '',
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (typeof account.enterpriseId === 'string' && account.enterpriseId.length > 0) {
    headers['X-Enterprise-Id'] = account.enterpriseId
  }
  return headers
}

/** 刷新访问令牌；成功返回新账号，失败返回 undefined（需要重新登录）。 */
async function refreshAccount(account) {
  if (typeof account.refreshToken !== 'string' || account.refreshToken.length === 0) return undefined
  try {
    const data = await postJson(`${chatBase(account.domain)}${API_PREFIX}/auth/token/refresh`, refreshHeaders(account), '{}')
    if (typeof data.accessToken !== 'string' || data.accessToken.length === 0) return undefined
    const expiresIn = toNumber(data.expiresIn ?? data.expires_in)
    return {
      ...account,
      accessToken: data.accessToken,
      refreshToken: typeof data.refreshToken === 'string' && data.refreshToken.length > 0 ? data.refreshToken : account.refreshToken,
      expiresAtMs: expiresIn > 0 ? Date.now() + expiresIn * 1000 : account.expiresAtMs ?? 0,
      domain: typeof data.domain === 'string' && data.domain.length > 0 ? data.domain : account.domain,
    }
  } catch {
    return undefined
  }
}

/**
 * 取一个可用账号：必要时自动刷新令牌。
 * @returns {Promise<WorkBuddyAccount | undefined>}
 */
async function resolveAccount(deps) {
  const stored = await readAccount(deps.credentials)
  if (stored === undefined) {
    // 首次使用：先看看本机有没有 WorkBuddy 留下的登录态，有就直接接过来。
    const imported = await importLocalVault()
    if (imported === undefined) return undefined
    await writeAccount(deps.credentials, imported)
    return imported
  }
  const expiresAtMs = toNumber(stored.expiresAtMs)
  if (expiresAtMs > 0 && expiresAtMs <= Date.now() + 60_000) {
    const refreshed = await refreshAccount(stored)
    if (refreshed === undefined) return stored
    await writeAccount(deps.credentials, refreshed)
    return refreshed
  }
  return stored
}

/** 读取签到状态。 */
async function fetchCheckinStatus(account) {
  const data = await postJson(
    `${billingBase(account.domain)}/v2/billing/meter/checkin-activity-status`,
    billingHeaders(account),
    '{}',
  )
  return {
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: toNumber(data.streak_days),
    dailyCredit: toNumber(data.daily_credit),
    todayCredit: toNumber(data.today_credit),
    isStreakDay: data.is_streak_day === true,
    nextStreakDay: toNumber(data.next_streak_day),
    streakBonusDays: toNumber(data.streak_bonus_days),
    streakBonusCredit: toNumber(data.streak_bonus_credit),
    claimButtonText: typeof data.claim_button_text === 'string' ? data.claim_button_text : '',
    totalCredits: toNumber(data.total_credits),
    activityName: typeof data.activity_name === 'string' ? data.activity_name : '',
    themeName: typeof data.theme_name === 'string' ? data.theme_name : '',
    startTime: parseLocalInstant(data.start_time),
    endTime: parseLocalInstant(data.end_time),
  }
}

/** 领取每日签到积分。 */
async function claimDailyCheckin(account) {
  const data = await postJson(
    `${billingBase(account.domain)}/v2/billing/meter/daily-checkin`,
    billingHeaders(account),
    '{}',
  )
  return {
    credit: toNumber(data.credit),
    streakDays: toNumber(data.streak_days),
    isStreakDay: data.is_streak_day === true,
  }
}

/** 读取单个福利活动的状态。 */
async function readBenefitStatus(account, kind, path) {
  const data = await postJson(`${billingBase(account.domain)}${path}`, billingHeaders(account), '{}')
  return {
    kind,
    active: data.active === true,
    claimed: data.claimed === true,
    creditNum: toNumber(data.credit_num),
    startsAtMs: parseLocalInstant(data.start_time),
    endsAtMs: parseLocalInstant(data.end_time),
    claimedAtMs: parseLocalInstant(data.claimed_at),
  }
}

/** 读取全部福利活动状态（单个失败不影响其它）。 */
async function fetchBenefits(account) {
  const kinds = Object.keys(BENEFIT_STATUS_PATHS)
  const settled = await Promise.allSettled(
    kinds.map((kind) => readBenefitStatus(account, kind, BENEFIT_STATUS_PATHS[kind])),
  )
  return settled
    .filter((entry) => entry.status === 'fulfilled')
    .map((entry) => entry.value)
}

/** 领取福利活动积分。 */
async function claimBenefit(account, kind) {
  const path = BENEFIT_CLAIM_PATHS[kind]
  if (path === undefined) throw new Error(`未知的福利活动类型：${kind}`)
  await postJson(`${billingBase(account.domain)}${path}`, billingHeaders(account), '{}')
  return true
}

/** 读取积分余额。 */
async function fetchCredits(account) {
  if (typeof account.enterpriseId === 'string' && account.enterpriseId.length > 0) {
    const data = await postJson(
      `${billingBase(account.domain)}/billing/meter/get-enterprise-user-usage`,
      billingHeaders(account),
      '{}',
    )
    const used = toNumber(data.credit)
    const total = toNumber(data.limitNum)
    return { total, remain: Math.max(total - used, 0), enterprise: true, packages: [] }
  }
  const data = await postJson(
    `${billingBase(account.domain)}/v2/billing/meter/get-user-resource`,
    billingHeaders(account),
    JSON.stringify({ PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca' }),
  )
  const response = isPlainObject(data.Response) ? data.Response : {}
  const payload = isPlainObject(response.Data) ? response.Data : {}
  const accounts = Array.isArray(payload.Accounts) ? payload.Accounts : []
  const packages = accounts.map((entry) => ({
    packageName: typeof entry.PackageName === 'string' ? entry.PackageName : '',
    remain: toNumber(entry.CapacityRemain),
    size: toNumber(entry.CapacitySize),
    expiresAtMs: parseLocalInstant(entry.CycleEndTime),
  }))
  const remain = packages.reduce((sum, entry) => sum + entry.remain, 0)
  const total = packages.reduce((sum, entry) => sum + entry.size, 0)
  return { total, remain, enterprise: false, packages }
}

/* ------------------------------------------------------------------ *
 * 网页 OAuth（免客户端的关键）
 * ------------------------------------------------------------------ */

/**
 * 读取本机已有的 WorkBuddy 登录凭据（其它插件留下的 `$DSH_HOME/workbuddy-vault`）。
 *
 * 这些文件是 WorkBuddy 官方客户端/插件自己写的登录态，格式固定：
 * `{ auth: { accessToken, refreshToken, expiresAt, domain }, account: { uid, nickname, uin } }`。
 * 找到就直接复用，省掉一次网页授权。
 */
async function importLocalVault() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const vaultDir = join(home, 'workbuddy-vault')
  const files = []
  // vault 里按区域分子目录（cn/、global/…），所以递归收集所有 json。
  const collect = async (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await collect(join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(join(dir, entry.name))
      }
    }
  }
  await collect(vaultDir, 0)
  for (const file of files) {
    let parsed
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (!isPlainObject(parsed)) continue
    const auth = isPlainObject(parsed.auth) ? parsed.auth : {}
    const account = isPlainObject(parsed.account) ? parsed.account : {}
    const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
    if (accessToken.length === 0) continue
    const expiresAtSec = toNumber(auth.expiresAt)
    const refreshExpiresAtSec = toNumber(auth.refreshExpiresAt)
    return {
      accessToken,
      refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
      expiresAtMs: expiresAtSec > 0 ? expiresAtSec * 1000 : 0,
      refreshExpiresAtMs: refreshExpiresAtSec > 0 ? refreshExpiresAtSec * 1000 : 0,
      domain: typeof auth.domain === 'string' ? auth.domain : 'www.codebuddy.cn',
      uid: typeof account.uid === 'string' ? account.uid : '',
      nickname: typeof account.nickname === 'string' ? account.nickname : '',
      uin: typeof account.uin === 'string' ? account.uin : '',
      enterpriseId: '',
    }
  }
  return undefined
}

/** 第一步：向 WorkBuddy 申请一个登录 state 与网页登录地址。 */
async function oauthStart(region) {
  const base = billingBaseForRegion(region)
  let data
  try {
    data = await postJson(`${base}${API_PREFIX}/auth/state?platform=workbuddy`, {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }, '{}')
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const state = typeof data.state === 'string' ? data.state : typeof data.State === 'string' ? data.State : ''
  if (state.length === 0) return { error: 'WorkBuddy 没有下发登录 state，请稍后再试' }
  const authUrl = typeof data.authUrl === 'string' && data.authUrl.length > 0
    ? data.authUrl
    : typeof data.auth_url === 'string' && data.auth_url.length > 0
      ? data.auth_url
      : typeof data.url === 'string' && data.url.length > 0
        ? data.url
        : `${base}/login?state=${encodeURIComponent(state)}`
  const loginId = `wbo_${randomUUID().replaceAll('-', '')}`
  sessions.set(loginId, { region, base, state, expiresAtMs: Date.now() + OAUTH_TTL_MS })
  return { loginId, verificationUri: authUrl, expiresIn: Math.floor(OAUTH_TTL_MS / 1000) }
}

/** 第二步：轮询登录结果，拿到令牌就落地为凭据。 */
async function oauthPoll(deps, loginId) {
  const session = sessions.get(loginId)
  if (session === undefined) return { done: true, error: '登录会话不存在，请重新发起登录' }
  if (session.expiresAtMs <= Date.now()) {
    sessions.delete(loginId)
    return { done: true, error: '登录已超时，请重新发起登录' }
  }
  let data
  try {
    data = await getJson(
      `${session.base}${API_PREFIX}/auth/token?state=${encodeURIComponent(session.state)}`,
      { Accept: 'application/json' },
    )
  } catch {
    return { done: false }
  }
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
  if (accessToken.length === 0) return { done: false }

  const profile = await fetchProfile(session.base, accessToken, data)
  const expiresIn = toNumber(data.expiresIn ?? data.expires_in)
  const refreshExpiresIn = toNumber(data.refreshExpiresIn ?? data.refresh_expires_in)
  const account = {
    accessToken,
    refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : '',
    expiresAtMs: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    refreshExpiresAtMs: refreshExpiresIn > 0 ? Date.now() + refreshExpiresIn * 1000 : 0,
    domain: typeof data.domain === 'string' && data.domain.length > 0
      ? data.domain
      : typeof profile?.domain === 'string' && profile.domain.length > 0
        ? profile.domain
        : session.region === 'global' ? 'www.workbuddy.ai' : 'www.codebuddy.cn',
    uid: typeof profile?.uid === 'string' ? profile.uid : '',
    nickname: typeof profile?.nickname === 'string' ? profile.nickname : '',
    uin: typeof profile?.uin === 'string' ? profile.uin : '',
    enterpriseId: typeof profile?.enterpriseId === 'string' ? profile.enterpriseId : '',
  }
  await writeAccount(deps.credentials, account)
  sessions.delete(loginId)
  return {
    done: true,
    account: {
      uid: account.uid,
      nickname: account.nickname,
      uin: account.uin,
      domain: account.domain,
      region: regionOfDomain(account.domain),
    },
  }
}

/** 拉取账号资料（失败不影响登录本身）。 */
async function fetchProfile(base, accessToken, tokenData) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  const domain = typeof tokenData?.domain === 'string' ? tokenData.domain : ''
  if (domain.length > 0) headers['X-Domain'] = domain
  try {
    const data = await getJson(`${base}${API_PREFIX}/login/account`, headers)
    return {
      uid: typeof data.uid === 'string' ? data.uid : typeof data.Uid === 'string' ? data.Uid : '',
      nickname: typeof data.nickname === 'string' ? data.nickname : '',
      uin: typeof data.uin === 'string' ? data.uin : '',
      enterpriseId: typeof data.enterpriseId === 'string' ? data.enterpriseId : '',
      domain: typeof data.domain === 'string' ? data.domain : '',
    }
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * 面向用户/Agent 的操作（UI 与 tool 共用同一份实现）
 * ------------------------------------------------------------------ */

/** 汇总状态：是否登录、签到情况、福利活动、积分余额。 */
async function getStatus(deps) {
  const account = await resolveAccount(deps)
  if (account === undefined) {
    return { signedIn: false, region: 'cn', account: undefined, checkin: undefined, benefits: [], credits: undefined }
  }
  const region = regionOfDomain(account.domain)
  const [checkin, benefits, credits] = await Promise.all([
    fetchCheckinStatus(account),
    fetchBenefits(account),
    fetchCredits(account).catch(() => undefined),
  ])
  return {
    signedIn: true,
    region,
    account: {
      uid: account.uid ?? '',
      nickname: account.nickname ?? '',
      uin: account.uin ?? '',
      domain: account.domain ?? '',
      expiresAtMs: toNumber(account.expiresAtMs),
    },
    checkin,
    benefits,
    credits,
  }
}

/** 领取每日签到积分。 */
async function claimCheckin(deps) {
  const account = await resolveAccount(deps)
  if (account === undefined) throw new Error('还没有登录 WorkBuddy 账号')
  const before = await fetchCheckinStatus(account)
  if (before.active !== true) throw new Error('当前没有进行中的签到活动')
  if (before.todayCheckedIn) {
    return { alreadyCheckedIn: true, claim: undefined, checkin: before }
  }
  const claim = await claimDailyCheckin(account)
  const after = await fetchCheckinStatus(account)
  return { alreadyCheckedIn: false, claim, checkin: after }
}

/** 领取福利活动积分。 */
async function claimBenefitAction(deps, kind) {
  if (kind !== 'compensation' && kind !== 'gift') throw new Error(`未知的福利活动类型：${kind}`)
  const account = await resolveAccount(deps)
  if (account === undefined) throw new Error('还没有登录 WorkBuddy 账号')
  if (typeof account.enterpriseId === 'string' && account.enterpriseId.length > 0) {
    throw new Error('企业账号暂不支持领取福利活动积分')
  }
  const status = await readBenefitStatus(account, kind, BENEFIT_STATUS_PATHS[kind])
  if (status.active !== true) throw new Error('该福利活动当前不可领取')
  if (status.claimed) throw new Error('该福利活动已经领过了')
  await claimBenefit(account, kind)
  const benefits = await fetchBenefits(account)
  return { claimed: true, kind, benefits }
}

/* ------------------------------------------------------------------ *
 * HTTP 路由
 * ------------------------------------------------------------------ */

function isLoopbackRequest(request) {
  const remote = request.socket?.remoteAddress
  const remoteOk = remote === undefined
    || remote === '127.0.0.1'
    || remote === '::1'
    || remote === '::ffff:127.0.0.1'
  if (!remoteOk) return false
  const host = request.headers?.host ?? ''
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']') === -1 ? host.length : host.indexOf(']'))
    : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return undefined
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ *
 * Agent tool
 * ------------------------------------------------------------------ */

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    message: { type: 'string', description: '人类可读的结果摘要' },
    detail: { type: 'object', description: '结构化详情' },
    error: { type: 'string', description: '失败原因（成功时为空）' },
  },
  required: ['ok', 'message'],
}

function mountTool(tools, deps) {
  if (tools === undefined || typeof tools.register !== 'function') return () => {}
  return tools.register({
    name: 'workbuddy_daily_credits',
    description:
      '查看或领取 WorkBuddy（国内版 CodeBuddy / 国际版 WorkBuddy）的每日签到积分与福利活动积分。'
      + 'action=status 查看签到状态、连续签到天数、福利活动与积分余额；'
      + 'action=checkin 领取今天的签到积分（当天只能领一次）；'
      + 'action=benefit 领取福利活动积分，kind 可选 compensation（补偿金）或 gift（新人礼）。'
      + 'action=login 发起网页登录授权（返回 verificationUri 登录地址，region 可选 cn/global）；'
      + 'action=poll 用 loginId 轮询登录结果（登录完成后自动保存凭据）。'
      + '首次使用需要先网页登录授权（不需要安装 WorkBuddy 客户端）。',
    timeoutMs: 60_000,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '要执行的操作：status（查看状态）、checkin（领取每日签到）、benefit（领取福利活动）、login（发起网页登录）、poll（轮询登录结果）。',
        },
        kind: {
          type: 'string',
          description: 'action=benefit 时指定福利类型：compensation 或 gift。',
        },
        region: {
          type: 'string',
          description: 'action=login 时指定账号区域：cn（国内版 CodeBuddy）或 global（国际版 WorkBuddy）。',
        },
        loginId: {
          type: 'string',
          description: 'action=poll 时传入 action=login 返回的 loginId。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render(_args, value) {
        const typed = value
        if (typed.ok !== true) {
          return [{ type: 'text', text: `WorkBuddy 积分操作失败：${typed.error ?? '未知原因'}` }]
        }
        const lines = [typed.message]
        const detail = typed.detail
        if (isPlainObject(detail)) {
          if (isPlainObject(detail.checkin)) {
            const checkin = detail.checkin
            lines.push(
              `签到：${checkin.todayCheckedIn ? '今天已领取' : '今天还没领'}；连续 ${String(checkin.streakDays)} 天；`
              + `每日 ${String(checkin.dailyCredit)} 积分${checkin.isStreakDay ? '（今天有连签加成）' : ''}`,
            )
          }
          if (Array.isArray(detail.benefits) && detail.benefits.length > 0) {
            for (const benefit of detail.benefits) {
              lines.push(
                `福利 ${benefit.kind}：${benefit.claimed ? '已领取' : benefit.active ? '可领取' : '未开放'}`
                + `（${String(benefit.creditNum)} 积分）`,
              )
            }
          }
          if (isPlainObject(detail.credits)) {
            lines.push(`积分余额：${String(detail.credits.remain)} / ${String(detail.credits.total)}`)
          }
          if (isPlainObject(detail.claim)) {
            lines.push(`本次领取：${String(detail.claim.credit)} 积分，连续 ${String(detail.claim.streakDays)} 天`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const input = isPlainObject(args) ? args : {}
      const action = typeof input.action === 'string' ? input.action : 'status'
      try {
        if (action === 'status') {
          const status = await getStatus(deps)
          if (status.signedIn !== true) {
            return { ok: false, message: '', error: '还没有登录 WorkBuddy 账号，请先在插件卡片里完成网页登录授权' }
          }
          const checkin = status.checkin
          return toJsonSafe({
            ok: true,
            message: checkin?.todayCheckedIn === true
              ? '今天的 WorkBuddy 签到积分已经领过了'
              : '今天的 WorkBuddy 签到积分还没领，可以调用 action=checkin 领取',
            detail: status,
            error: '',
          })
        }
        if (action === 'checkin') {
          const result = await claimCheckin(deps)
          return toJsonSafe({
            ok: true,
            message: result.alreadyCheckedIn
              ? '今天的签到积分已经领过了'
              : `签到成功，本次获得 ${String(result.claim?.credit ?? 0)} 积分`,
            detail: result,
            error: '',
          })
        }
        if (action === 'benefit') {
          const kind = typeof input.kind === 'string' ? input.kind : 'compensation'
          const result = await claimBenefitAction(deps, kind)
          return toJsonSafe({
            ok: true,
            message: `福利活动 ${kind} 领取成功`,
            detail: result,
            error: '',
          })
        }
        if (action === 'login') {
          const region = input.region === 'global' ? 'global' : 'cn'
          const started = await oauthStart(region)
          if (typeof started.error === 'string') {
            return { ok: false, message: '', error: started.error }
          }
          return toJsonSafe({
            ok: true,
            message: `请在浏览器里打开登录地址完成授权：${started.verificationUri}`,
            detail: {
              loginId: started.loginId,
              verificationUri: started.verificationUri,
              expiresIn: started.expiresIn,
              region,
            },
            error: '',
          })
        }
        if (action === 'poll') {
          const loginId = typeof input.loginId === 'string' ? input.loginId : ''
          if (loginId.length === 0) {
            return { ok: false, message: '', error: '缺少 loginId，请先调用 action=login' }
          }
          const polled = await oauthPoll(deps, loginId)
          if (polled.done !== true) {
            return { ok: true, message: '还没有完成登录，请稍后再轮询一次', detail: { done: false }, error: '' }
          }
          if (typeof polled.error === 'string') {
            return { ok: false, message: '', error: polled.error }
          }
          return toJsonSafe({
            ok: true,
            message: `登录成功：${polled.account?.nickname ?? polled.account?.uid ?? ''}`,
            detail: { done: true, account: polled.account },
            error: '',
          })
        }
        return { ok: false, message: '', error: `未知的 action：${action}（可用：status、checkin、benefit、login、poll）` }
      } catch (error) {
        return { ok: false, message: '', error: errorMessage(error) }
      }
    },
  })
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/**
 * Host 半身入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const deps = { credentials: ctx.get('credentials') }
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : undefined

  const requireAccount = async () => {
    const account = await resolveAccount(deps)
    if (account === undefined) throw new Error('还没有登录 WorkBuddy 账号')
    return account
  }

  // 凭据服务若晚于本插件加载，稍后再取一次。
  ctx.inject(['credentials'], (scoped) => {
    deps.credentials = scoped.credentials
  })

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    const register = (path, label, handler) => {
      scoped.effect(
        () => server.register({ kind: 'exact', path, handler }),
        `workbuddy-daily-credits: ${label}`,
      )
    }

    register(`${ROUTE_PREFIX}/status`, 'status route', async (request, response) => {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method not allowed' })
        return
      }
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { error: 'host-not-trusted' })
        return
      }
      try {
        writeJson(response, 200, await getStatus(deps))
      } catch (error) {
        writeJson(response, 500, { error: errorMessage(error) })
      }
    })

    register(`${ROUTE_PREFIX}/oauth/start`, 'oauth start route', async (request, response) => {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method not allowed' })
        return
      }
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { error: 'host-not-trusted' })
        return
      }
      const body = await readJsonBody(request)
      if (body === undefined) {
        writeJson(response, 400, { error: 'invalid request body' })
        return
      }
      const region = body.region === 'global' ? 'global' : 'cn'
      writeJson(response, 200, await oauthStart(region))
    })

    register(`${ROUTE_PREFIX}/oauth/poll`, 'oauth poll route', async (request, response) => {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method not allowed' })
        return
      }
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { error: 'host-not-trusted' })
        return
      }
      const body = await readJsonBody(request)
      if (body === undefined) {
        writeJson(response, 400, { error: 'invalid request body' })
        return
      }
      const loginId = typeof body.loginId === 'string' ? body.loginId : ''
      if (loginId.length === 0) {
        writeJson(response, 400, { error: 'loginId is required' })
        return
      }
      try {
        writeJson(response, 200, await oauthPoll(deps, loginId))
      } catch (error) {
        writeJson(response, 500, { error: errorMessage(error) })
      }
    })

    register(`${ROUTE_PREFIX}/claim/checkin`, 'check-in route', async (request, response) => {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method not allowed' })
        return
      }
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { error: 'host-not-trusted' })
        return
      }
      try {
        await requireAccount()
        writeJson(response, 200, await claimCheckin(deps))
      } catch (error) {
        writeJson(response, 400, { error: errorMessage(error) })
      }
    })

    register(`${ROUTE_PREFIX}/claim/benefit`, 'benefit route', async (request, response) => {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method not allowed' })
        return
      }
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { error: 'host-not-trusted' })
        return
      }
      const body = await readJsonBody(request)
      if (body === undefined) {
        writeJson(response, 400, { error: 'invalid request body' })
        return
      }
      const kind = typeof body.kind === 'string' ? body.kind : 'compensation'
      try {
        await requireAccount()
        writeJson(response, 200, await claimBenefitAction(deps, kind))
      } catch (error) {
        writeJson(response, 400, { error: errorMessage(error) })
      }
    })

    register(`${ROUTE_PREFIX}/sign-out`, 'sign-out route', async (request, response) => {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method not allowed' })
        return
      }
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { error: 'host-not-trusted' })
        return
      }
      try {
        await clearAccount(deps.credentials)
        writeJson(response, 200, { signedIn: false })
      } catch (error) {
        writeJson(response, 500, { error: errorMessage(error) })
      }
    })
  })

  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => mountTool(scoped.tools, deps), 'workbuddy-daily-credits: tool')
  })

  logger?.info('workbuddy daily credits ready')
}
