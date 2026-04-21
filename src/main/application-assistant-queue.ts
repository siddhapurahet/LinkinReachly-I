import type { ApplyQueueItem, ApplyQueueView } from '@core/application-types'
import { getProfileCompleteness } from '@core/application-completeness'
import { loadApplicationHistory } from './application-history-store'
import {
  addToQueue,
  clearQueue,
  loadQueue,
  removeFromQueue,
  retryQueueItems,
  skipQueueItem
} from './apply-queue-store'
import { notifyApplyQueueTick, startApplyQueueRunner, stopApplyQueueRunner } from './apply-queue-runner'
import { thisWeekConnectionCount, todayCount } from './logger'
import { loadSettings } from './settings'
import { getServerUsage } from './api-client'
import { loadApplicantProfile } from './applicant-profile-store'
import {
  blockPendingEasyApplyItemsForStaleExtension,
  getApplicationExtensionHealth
} from './application-assistant-extension-health'

const ALLOWED_QUEUE_HOSTS = new Set([
  'www.linkedin.com', 'linkedin.com',
  'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com',
  'www.myworkdayjobs.com'
])

function isAllowedQueueHost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    if (ALLOWED_QUEUE_HOSTS.has(host)) return true
    return host.endsWith('.myworkdayjobs.com')
  } catch {
    return false
  }
}

export function normalizeQueueItems(raw: unknown): ApplyQueueItem[] {
  if (typeof raw !== 'object' || raw == null) return []
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const out: ApplyQueueItem[] = []
  for (const row of items) {
    if (typeof row !== 'object' || row == null) continue
    const o = row as Partial<ApplyQueueItem>
    const id = String(o.id || '').trim()
    const jobTitle = String(o.jobTitle || '').trim()
    const company = String(o.company || '').trim()
    if (!id || !jobTitle || !company) continue
    const linkedinJobUrl = String(o.linkedinJobUrl || '').trim()
    const applyUrl = String(o.applyUrl || o.linkedinJobUrl || '').trim()
    if (linkedinJobUrl && !isAllowedQueueHost(linkedinJobUrl)) continue
    if (applyUrl && !isAllowedQueueHost(applyUrl)) continue
    out.push({
      id,
      jobTitle,
      company,
      location: String(o.location || '').trim(),
      linkedinJobUrl,
      applyUrl,
      surface: 'linkedin_easy_apply',
      atsId: String(o.atsId || '').trim() || undefined,
      status: 'pending',
      addedAt: String(o.addedAt || new Date().toISOString()),
      descriptionSnippet: String(o.descriptionSnippet || '').trim() || undefined,
      reasonSnippet: String(o.reasonSnippet || '').trim() || undefined
    })
  }
  return out
}

export function handleApplicationQueueState(): {
  ok: true
  state: ReturnType<typeof loadQueue>
  dailyUsage: { sent: number; cap: number; configuredCap: number | undefined }
  dailyOutreach: { sent: number }
  weeklyOutreach: { sent: number; cap: number; pendingWarning: boolean }
} {
  const state = loadQueue()
  const settings = loadSettings()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayIso = todayStart.toISOString()
  const history = loadApplicationHistory()
  const localSentToday = history.filter(
    (r) =>
      r.createdAt >= todayIso &&
      (r.outcome === 'submitted' || r.outcome === 'autofilled')
  ).length
  const { applyUsed: serverApplyUsed, outreachUsed: serverOutreachUsed } = getServerUsage()
  const sentToday = Math.max(localSentToday, serverApplyUsed)
  const effectiveCap = settings.applyDailyCap ?? 25
  const weeklyOutreach = thisWeekConnectionCount()
  const weeklyCap = settings.weeklyConnectionCap ?? 60
  const localOutreachToday = todayCount('connection_invite')
  const outreachToday = Math.max(localOutreachToday, serverOutreachUsed)
  return {
    ok: true,
    state,
    dailyUsage: { sent: sentToday, cap: effectiveCap, configuredCap: effectiveCap },
    dailyOutreach: { sent: outreachToday },
    weeklyOutreach: { sent: weeklyOutreach, cap: weeklyCap, pendingWarning: weeklyOutreach >= weeklyCap * 0.8 }
  }
}

export function handleApplicationQueueAdd(payload: unknown): ApplyQueueView {
  const items = normalizeQueueItems(payload)
  if (!items.length) {
    return { ok: false, detail: 'No valid queue items.' } satisfies ApplyQueueView
  }
  const result = addToQueue(items)
  notifyApplyQueueTick()
  return {
    ok: true,
    state: result.state,
    added: result.added,
    skippedDuplicate: result.skippedDuplicate,
    skippedAlreadyApplied: result.skippedAlreadyApplied,
    skippedNames: result.skippedNames
  } satisfies ApplyQueueView
}

export async function handleApplicationQueueStart(): Promise<ApplyQueueView> {
  const profile = loadApplicantProfile()
  const completeness = getProfileCompleteness(profile)
  if (!completeness.readyToApply) {
    const missing = completeness.missingRequired
    return {
      ok: false,
      detail: `Missing info before applying: ${missing.join(', ')}. Upload your resume and fill in the required fields in the Application profile tab.`
    } satisfies ApplyQueueView
  }

  const queue = loadQueue()
  const hasPendingEasyApply = queue.items.some(
    (item) => item.status === 'pending' && item.surface === 'linkedin_easy_apply'
  )
  if (hasPendingEasyApply) {
    let health = await getApplicationExtensionHealth()

    // Race-condition guard: if bridge is disconnected, wait up to 10s for reconnect
    if (health.status === 'bridge_disconnected') {
      const RECONNECT_WAIT_MS = 10_000
      const POLL_INTERVAL_MS = 1_000
      const deadline = Date.now() + RECONNECT_WAIT_MS
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        health = await getApplicationExtensionHealth()
        if (health.status !== 'bridge_disconnected') break
      }
    }

    // Block on any unhealthy extension state — not just stale
    if (!health.ok) {
      if (health.status === 'stale_extension') {
        return blockPendingEasyApplyItemsForStaleExtension(health.detail)
      }
      return {
        ok: false,
        detail: health.detail || 'Chrome extension not ready. Open a LinkedIn tab and try again.'
      } satisfies ApplyQueueView
    }
  }
  startApplyQueueRunner()
  return { ok: true, state: loadQueue() } satisfies ApplyQueueView
}

export function handleApplicationQueueStop(): ApplyQueueView {
  stopApplyQueueRunner()
  return { ok: true, state: loadQueue() } satisfies ApplyQueueView
}

export function handleApplicationQueueRetry(payload: unknown): ApplyQueueView {
  const current = loadQueue()
  if (current.running) {
    return { ok: false, detail: 'Pause the queue first, then retry.' } satisfies ApplyQueueView
  }
  const body = (payload || {}) as { id?: string; ids?: string[]; all?: boolean } | undefined
  const ids = new Set<string>()
  const singleId = String(body?.id || '').trim()
  if (singleId) ids.add(singleId)
  if (Array.isArray(body?.ids)) {
    for (const id of body.ids) {
      const normalized = String(id || '').trim()
      if (normalized) ids.add(normalized)
    }
  }
  const next = ids.size > 0 ? retryQueueItems([...ids]) : retryQueueItems()
  notifyApplyQueueTick()
  return { ok: true, state: next } satisfies ApplyQueueView
}

export function handleApplicationQueueSkip(payload: unknown): ApplyQueueView {
  const current = loadQueue()
  if (current.running) {
    return { ok: false, detail: 'Pause the queue before skipping items.' } satisfies ApplyQueueView
  }
  const id = String((payload as { id?: string } | undefined)?.id || '').trim()
  if (!id) return { ok: false, detail: 'Item id required.' } satisfies ApplyQueueView
  const state = skipQueueItem(id)
  notifyApplyQueueTick()
  return { ok: true, state } satisfies ApplyQueueView
}

export function handleApplicationQueueRemove(payload: unknown): ApplyQueueView {
  const id = String((payload as { id?: string } | undefined)?.id || '').trim()
  if (!id) return { ok: false, detail: 'Item id required.' } satisfies ApplyQueueView
  const state = removeFromQueue(id)
  notifyApplyQueueTick()
  return { ok: true, state } satisfies ApplyQueueView
}

export function handleApplicationQueueClear(): ApplyQueueView {
  const prev = loadQueue()
  if (prev.running) {
    return {
      ok: false,
      state: prev,
      detail: 'Queue is running. Stop it before clearing.'
    } satisfies ApplyQueueView
  }
  const state = clearQueue()
  notifyApplyQueueTick()
  return { ok: true, state } satisfies ApplyQueueView
}
