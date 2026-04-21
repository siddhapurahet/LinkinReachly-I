import { app, dialog, shell, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileFacts, TargetRow } from '@core/types'
import { isLinkedInUrl } from '@core/linkedin-url'
import {
  DEFAULT_EXECUTION_ID,
  getExecutionById,
  sourceConnectionExecutionForLogEntry
} from '@core/executions'
import { parseTargetsCsv } from '@core/csv-targets'
import { appLog, readRuntimeLogTailLines, runtimeLogsDir } from './app-log'
import type { BridgeResultMsg } from './bridge'
import {
  getBridgePort,
  getActiveLinkedInTab,
  isExtensionConnected,
  sendCommand
} from './bridge'
import {
  loadSettings,
  saveSettingsAsync,
  saveSettingsWithApiKeyAsync,
  getApiKey,
  normalizeBridgePort,
  type AppSettings
} from './settings'
import { normalizeJobsSearchHistory } from '@core/job-search-history'
import {
  composeMessageDetailed,
  generateAiFields,
  linkedInPeopleSearchUrl,
  planMission,
  testApiKey
} from './llm'
import {
  appendMainLog,
  clearMainLog,
  loadLogHistory,
  loadRecentConnectionInvites,
  loadRecentLogLines,
  readMainLogText,
  type LogStatus,
  type OutreachLogEntry
} from './logger'
import { getQueueState, isQueueBusy, requestStop, runQueue } from './queue'
import type { UserProfile } from '@core/profile-db'
import { loadUserProfile, saveUserProfile, hasUserProfile } from './profile-store'
import { syncApplicantFromUserProfile } from './user-applicant-sync'
import { persistStructuredProfileFromResumeText } from './profile-sync'
import { uploadResume, clearResume, importResumeFromPath, importResumeFromData } from './resume'
import { isAuthenticated } from './auth-service'
import { getServiceConfig } from './service-config'
import { parseResumeMarkdown } from '@core/resume-parser'
import {
  archiveCampaign,
  createCampaign,
  getCampaignSummary,
  getRemainingTargets,
  loadActiveCampaign,
  markTargetsSent
} from './campaign'
import { runDetectNow, getNewAccepts, clearNewAccepts } from './followup-detector'
import { getPendingFollowUps, cancelFollowUp } from './followup-queue'
import { exportBackup, importBackup } from './backup-restore'
import { openExternalUrl } from './window-security'
import { userDataDir } from './user-data-path'
import {
  handleApplicationAssistantChannel,
  isApplicationAssistantChannel
} from './application-assistant'
import {
  buildUserBackgroundFromLinkedInProfile,
  type LinkedInProfileSnapshot
} from '@core/profile-background'
import { getActiveLinkedInTabUrl } from './bridge'
import { saveSettings } from './settings'

type QueueStartRequest = {
  targets?: TargetRow[]
  dryRun?: boolean
  messageOverride?: string
}

const SETTINGS_PATCH_KEYS = new Set<string>([
  'seenOnboarding', 'bridgePort', 'llmProvider', 'llmBaseUrl', 'llmModel', 'llmEnabled',
  'lastExecutionId', 'lastGoal', 'aiFieldDefinitions', 'templates', 'mustInclude',
  'dailyCap', 'sessionBreaksEnabled', 'sessionBreakEveryMin', 'sessionBreakEveryMax',
  'sessionBreakDurationMin', 'sessionBreakDurationMax', 'delayBetweenRequestsMin',
  'delayBetweenRequestsMax', 'delayBetweenActionsMin', 'delayBetweenActionsMax',
  'resumeText', 'resumeFileName',
  'jobsSearchKeywords', 'jobsSearchLocation', 'jobsSearchHistory', 'userBackground',
  'outreachTone', 'weeklyConnectionCap',
  'jobsSearchRecencySeconds',
  'jobsSearchSortBy', 'jobsSearchDistanceMiles', 'jobsSearchExperienceLevels',
  'jobsSearchJobTypes', 'jobsSearchRemoteTypes', 'jobsSearchSalaryFloor',
  'jobsSearchFewApplicants', 'jobsSearchVerifiedOnly', 'jobsSearchEasyApplyOnly', 'pendingInviteCount',
  'jobsScreeningCriteria', 'customOutreachPrompt', 'easyApplyTailorCoverLetter',
  'easyApplyEnrichCompanyContext'
])

function publicSettings() {
  const { apiKeyStored: _k, apiKeyIsEncrypted: _e, resumeText: _resumeText, ...rest } = loadSettings()
  const hasLocalKey = !!getApiKey()
  const proxyAvailable = !!(getServiceConfig().llmProxy.url && isAuthenticated())
  return { ...rest, apiKeyPresent: hasLocalKey || proxyAvailable }
}

function mergeSettingsPartial(
  current: AppSettings,
  partial: Record<string, unknown> | Partial<AppSettings> | undefined
): AppSettings {
  if (!partial) return current
  const { apiKeyPresent: _ap, ...rawIn } = partial as Record<string, unknown>
  const rest: Record<string, unknown> = {}
  for (const key of SETTINGS_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(rawIn, key)) rest[key] = rawIn[key]
  }
  const merged = { ...current, ...rest } as AppSettings
  merged.bridgePort = normalizeBridgePort(rest.bridgePort ?? current.bridgePort)
  if (!Array.isArray(merged.templates) || merged.templates.length === 0) {
    merged.templates = current.templates
  } else {
    merged.templates = merged.templates.filter((line): line is string => typeof line === 'string')
  }
  if (!Array.isArray(merged.mustInclude)) {
    merged.mustInclude = current.mustInclude
  } else {
    merged.mustInclude = merged.mustInclude.filter((line): line is string => typeof line === 'string')
  }
  if (typeof merged.lastExecutionId === 'string' && !getExecutionById(merged.lastExecutionId)) {
    merged.lastExecutionId = current.lastExecutionId
  }
  const clampJobSearch = (v: unknown, fallback: string) =>
    typeof v === 'string' ? v.slice(0, 800) : fallback
  merged.jobsSearchKeywords = clampJobSearch(merged.jobsSearchKeywords, current.jobsSearchKeywords)
  merged.jobsSearchLocation = clampJobSearch(merged.jobsSearchLocation, current.jobsSearchLocation)
  merged.jobsSearchHistory = normalizeJobsSearchHistory(merged.jobsSearchHistory)
  merged.llmProvider = 'grok'
  merged.apiKeyStored = current.apiKeyStored
  merged.apiKeyIsEncrypted = current.apiKeyIsEncrypted
  if (typeof merged.pendingInviteCount === 'number' && Number.isFinite(merged.pendingInviteCount)) {
    merged.pendingInviteCount = Math.min(500_000, Math.max(0, Math.floor(merged.pendingInviteCount)))
  } else {
    merged.pendingInviteCount = current.pendingInviteCount
  }
  return merged
}

function filterValidTargets(targets: TargetRow[]): TargetRow[] {
  return targets.filter((t) => {
    const profileUrl = typeof t.profileUrl === 'string' ? t.profileUrl.trim() : ''
    const searchQuery = typeof t.searchQuery === 'string' ? t.searchQuery.trim() : ''
    const personName = typeof t.personName === 'string' ? t.personName.trim() : ''
    const company = typeof t.company === 'string' ? t.company.trim() : ''
    return isLinkedInUrl(profileUrl) || !!searchQuery || !!personName || !!company
  })
}

function csvEscape(value: string | undefined): string {
  const text = String(value || '')
  if (!/[",\n]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function targetsToCsv(targets: TargetRow[]): string {
  const header = ['profileUrl', 'firstName', 'company', 'headline']
  const lines = targets.map((t) => [csvEscape(t.profileUrl), csvEscape(t.firstName), csvEscape(t.company), csvEscape(t.headline)].join(','))
  return [header.join(','), ...lines].join('\n')
}

function appendHistoryEvent(entry: Omit<OutreachLogEntry, 'timestamp' | 'status'> & { status?: LogStatus }): void {
  appendMainLog({ ...entry, timestamp: new Date().toISOString(), status: entry.status || 'info' })
}

function previewTargetForExecution(executionId: string): TargetRow {
  const ex = getExecutionById(executionId) ?? getExecutionById(DEFAULT_EXECUTION_ID)!
  const parsed = ex.starterCsv ? parseTargetsCsv(ex.starterCsv) : []
  return parsed[0] || { profileUrl: 'https://www.linkedin.com/in/demo-avery-chen/', firstName: 'Avery', company: 'Northbridge Labs', headline: 'VP Product' }
}

function latestFollowUpPreviewSource() {
  const invites = loadRecentConnectionInvites(600)
  for (let i = invites.length - 1; i >= 0; i--) {
    const entry = invites[i]!
    const sourceExecution = sourceConnectionExecutionForLogEntry(entry)
    if (!sourceExecution) continue
    const fallback = previewTargetForExecution(sourceExecution.id)
    return {
      execution: sourceExecution,
      target: { ...fallback, profileUrl: entry.profileUrl || fallback.profileUrl, firstName: entry.name?.split(/\s+/)[0] || fallback.firstName, company: entry.company || fallback.company }
    }
  }
  return null
}

function normalizePreviewTarget(input: TargetRow | undefined, fallback: TargetRow): TargetRow {
  if (!input) return fallback
  return {
    ...fallback, ...input,
    profileUrl: String(input.profileUrl || fallback.profileUrl || '').trim() || fallback.profileUrl,
    firstName: String(input.firstName || fallback.firstName || '').trim() || fallback.firstName,
    company: String(input.company || fallback.company || '').trim() || fallback.company,
    headline: String(input.headline || fallback.headline || '').trim() || fallback.headline
  }
}

function extensionDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'extension')
  return join(process.cwd(), 'extension')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function extractOwnLinkedInProfileBackground(options?: { persist?: boolean; restoreAfter?: boolean }) {
  const ping = await sendCommand('PING', {}, 15_000)
  if (!ping.ok) return { ok: false as const, detail: ping.detail === 'open_a_linkedin_tab' ? 'Open a linkedin.com tab in Chrome first.' : ping.detail }

  const currentUrl = options?.restoreAfter ? getActiveLinkedInTabUrl() : ''
  const profileUrl = 'https://www.linkedin.com/in/me/'
  try {
    const nav = await sendCommand('NAVIGATE', { url: profileUrl }, 45_000)
    if (!nav.ok) return { ok: false as const, detail: nav.detail || 'Could not open your LinkedIn profile.' }
    await wait(2600)
    const extracted = await sendCommand('EXTRACT_PROFILE', {}, 15_000)
    if (!extracted.ok) return { ok: false as const, detail: extracted.detail || 'Could not read your LinkedIn profile.' }

    const profile = ((extracted.data as LinkedInProfileSnapshot | undefined) || {}) as LinkedInProfileSnapshot
    const background = buildUserBackgroundFromLinkedInProfile(profile)
    if (!background || background.length < 24) return { ok: false as const, detail: 'Your LinkedIn profile did not expose enough information to build a useful background summary.' }

    let nextSettings: ReturnType<typeof publicSettings> | undefined
    if (options?.persist) {
      const current = loadSettings()
      saveSettings({ ...current, userBackground: background })
      nextSettings = publicSettings()
    }
    try {
      const parsed = parseResumeMarkdown(background)
      if (parsed.name || parsed.email) { saveUserProfile(parsed); syncApplicantFromUserProfile(parsed, background) }
    } catch (e) { appLog.debug('[index] applicant profile sync failed', e instanceof Error ? e.message : String(e)) }

    return { ok: true as const, background, profile, settings: nextSettings, detail: options?.persist ? 'profile_imported_and_saved' : 'profile_imported' }
  } finally {
    if (options?.restoreAfter && currentUrl && currentUrl !== profileUrl && /linkedin\.com/i.test(currentUrl)) {
      try { await sendCommand('NAVIGATE', { url: currentUrl }, 45_000) } catch (e) { appLog.debug('[index] NAVIGATE restore failed', e instanceof Error ? e.message : String(e)) }
    }
  }
}

export function registerGeneralHandlers(ctx: {
  restartBridgeIfNeeded: (port: number) => void
  getMainWindow: () => BrowserWindow | null
}): Map<string, (payload: unknown) => Promise<unknown>> {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()

  handlers.set('settings:get', async () => publicSettings())
  handlers.set('settings:save', async (payload) => {
    const cur = loadSettings()
    const merged = mergeSettingsPartial(cur, payload as Record<string, unknown>)
    await saveSettingsAsync(merged)
    ctx.restartBridgeIfNeeded(merged.bridgePort)
    if (merged.telemetryOptIn !== cur.telemetryOptIn) {
      const { setTelemetryEnabled } = await import('./telemetry')
      setTelemetryEnabled(!!merged.telemetryOptIn)
    }
    return publicSettings()
  })
  handlers.set('settings:saveBundle', async (payload) => {
    const bundle = payload as { settings: Record<string, unknown>; apiKey?: string | null } | undefined
    const cur = loadSettings()
    const merged = mergeSettingsPartial(cur, bundle?.settings ?? {})
    const apiKeyUpdate = bundle && Object.prototype.hasOwnProperty.call(bundle, 'apiKey') ? bundle.apiKey : undefined
    const next = await saveSettingsWithApiKeyAsync(merged, apiKeyUpdate)
    ctx.restartBridgeIfNeeded(next.bridgePort)
    return publicSettings()
  })
  handlers.set('settings:setApiKey', async (payload) => {
    const key = payload as string | null
    await saveSettingsWithApiKeyAsync(loadSettings(), key && key.trim() ? key.trim() : null)
    return publicSettings()
  })
  handlers.set('bridge:status', async () => {
    const base = { port: getBridgePort(), extensionConnected: isExtensionConnected(), activeLinkedInTab: getActiveLinkedInTab(), pendingInviteCount: undefined as number | undefined }
    if (base.extensionConnected) {
      try {
        const r = await sendCommand('CHECK_PENDING_INVITES', {}, 3_000)
        if (r.ok && typeof (r.data as Record<string, unknown>)?.pendingCount === 'number') {
          base.pendingInviteCount = (r.data as Record<string, unknown>).pendingCount as number
        }
      } catch { /* silently skip — user may not be on the right page */ }
    }
    return base
  })
  handlers.set('bridge:reloadExtension', async () => {
    try { await sendCommand('RELOAD_EXTENSION', {}, 5_000); return { ok: true, detail: 'Extension reload triggered.' } }
    catch (e) { return { ok: false, detail: String(e instanceof Error ? e.message : e) } }
  })
  handlers.set('bridge:reloadTab', async () => {
    try { await sendCommand('RELOAD_TAB', {}, 10_000); return { ok: true, detail: 'LinkedIn tab reloaded.' } }
    catch (e) { return { ok: false, detail: String(e instanceof Error ? e.message : e) } }
  })
  handlers.set('bridge:ping', async () => {
    try { const r = await sendCommand('PING', {}, 15_000); return { ok: r.ok, detail: r.detail } }
    catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) } }
  })
  handlers.set('bridge:diagnoseEasyApply', async () => {
    try { return await sendCommand('DIAGNOSE_EASY_APPLY', {}, 10_000) }
    catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) } }
  })
  handlers.set('bridge:rawCommand', async (payload) => {
    const p = payload as { action?: string; payload?: unknown; timeoutMs?: number } | undefined
    const action = String(p?.action || '').trim()
    if (!action) return { ok: false, detail: 'missing action' }
    try { return await sendCommand(action, (p?.payload || {}) as Record<string, unknown>, p?.timeoutMs || 15_000) }
    catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) } }
  })
  handlers.set('prospects:collectFromPlan', async (payload) => {
    const query = String((payload as { query?: string } | undefined)?.query || '').trim()
    if (!query) return { ok: false as const, detail: 'Describe who you want to reach first.' }
    const searchUrl = linkedInPeopleSearchUrl(query)
    try {
      const ping = await sendCommand('PING', {}, 15_000)
      if (!ping.ok) {
        const detail = ping.detail === 'open_a_linkedin_tab' ? 'Open a linkedin.com tab in Chrome before finding people.' : ping.detail
        appendHistoryEvent({ profileUrl: searchUrl, status: 'error', detail, eventType: 'prospects_search', summary: 'LinkedIn people search could not start.', searchQuery: query, searchUrl, resultCount: 0, people: [] })
        return { ok: false as const, searchUrl, detail }
      }
      const nav = await sendCommand('NAVIGATE', { url: searchUrl }, 45_000)
      if (!nav.ok) {
        appendHistoryEvent({ profileUrl: searchUrl, status: 'error', detail: nav.detail || 'Could not open LinkedIn search.', eventType: 'prospects_search', summary: 'LinkedIn people search failed to open.', searchQuery: query, searchUrl, resultCount: 0, people: [] })
        return { ok: false as const, searchUrl, detail: nav.detail || 'Could not open LinkedIn search.' }
      }
      let results = await sendCommand('EXTRACT_SEARCH_RESULTS', { scrollPasses: 2 }, 45_000)
      if (!results.ok) {
        await new Promise((r) => setTimeout(r, 3000))
        results = await sendCommand('EXTRACT_SEARCH_RESULTS', { scrollPasses: 2 }, 45_000)
      }
      if (!results.ok) {
        appendHistoryEvent({ profileUrl: searchUrl, status: 'error', detail: results.detail || 'Could not read LinkedIn search results.', eventType: 'prospects_search', summary: 'LinkedIn people search loaded, but results could not be read.', searchQuery: query, searchUrl, resultCount: 0, people: [] })
        return { ok: false as const, searchUrl, detail: results.detail || 'Could not read LinkedIn search results.' }
      }
      const rawItems = Array.isArray((results.data as { items?: unknown[] } | undefined)?.items) ? ((results.data as { items?: unknown[] }).items as Record<string, unknown>[]) : []
      const deduped = new Map<string, TargetRow & { foundName?: string }>()
      for (const item of rawItems) {
        const row: TargetRow & { foundName?: string } = {
          profileUrl: String(item.profileUrl || '').trim(),
          foundName: typeof item.displayName === 'string' ? item.displayName.trim() : undefined,
          firstName: typeof item.firstName === 'string' ? item.firstName.trim() : undefined,
          company: typeof item.company === 'string' ? item.company.trim() : undefined,
          headline: typeof item.headline === 'string' ? item.headline.trim() : undefined
        }
        if (!isLinkedInUrl(row.profileUrl)) continue
        if (!deduped.has(row.profileUrl)) deduped.set(row.profileUrl, row)
      }
      const targets = filterValidTargets([...deduped.values()]).slice(0, 50)
      appendHistoryEvent({
        profileUrl: searchUrl, detail: targets.length > 0 ? 'prospects_search_completed' : 'prospects_search_empty',
        eventType: 'prospects_search', summary: targets.length > 0 ? `Saved ${targets.length} people from LinkedIn search.` : 'Ran LinkedIn people search but found no saved matches.',
        searchQuery: query, searchUrl, resultCount: targets.length,
        people: targets.map((target) => { const et = target as TargetRow & { foundName?: string }; return { profileUrl: target.profileUrl, name: et.foundName, firstName: target.firstName, company: target.company, headline: target.headline } })
      })
      return { ok: true as const, searchUrl, count: targets.length, csvText: targetsToCsv(targets) }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      appendHistoryEvent({ profileUrl: searchUrl, status: 'error', detail, eventType: 'prospects_search', summary: 'LinkedIn people search failed unexpectedly.', searchQuery: query, searchUrl, resultCount: 0, people: [] })
      return { ok: false as const, searchUrl, detail }
    }
  })
  handlers.set('logs:recent', async () => loadLogHistory())
  handlers.set('logs:runtime:tail', async (payload) => {
    const maxLines = typeof (payload as { maxLines?: unknown } | undefined)?.maxLines === 'number' ? Math.floor(Number((payload as { maxLines: number }).maxLines)) : 400
    return { ok: true as const, lines: readRuntimeLogTailLines(maxLines) }
  })
  handlers.set('logs:export', async (payload) => {
    const exportPayload = payload as { headless?: boolean } | undefined
    const mw = ctx.getMainWindow()
    if (exportPayload?.headless || !mw || mw.isDestroyed()) {
      const tmpPath = join(app.getPath('temp'), `linkinreachly-${Date.now()}.jsonl`)
      writeFileSync(tmpPath, readMainLogText(), 'utf8')
      return { ok: true as const, path: tmpPath }
    }
    const suggestedName = `linkinreachly-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
    const { canceled, filePath } = await dialog.showSaveDialog(mw, {
      title: 'Export outreach log', defaultPath: suggestedName,
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }, { name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { ok: false as const, canceled: true as const }
    writeFileSync(filePath, readMainLogText(), 'utf8')
    return { ok: true as const, path: filePath }
  })
  handlers.set('logs:clear', async () => clearMainLog())
  handlers.set('cache:clearAll', async () => {
    const { rmSync, existsSync: existsSyncCheck } = require('fs') as typeof import('fs')
    const dataDir = userDataDir()
    const targets = [
      join(dataDir, 'logs'), join(dataDir, 'config', 'apply-queue.json'),
      join(dataDir, 'followup-queue.json'), join(dataDir, 'known-accepts.json'),
      join(dataDir, 'followup-state.json'), join(dataDir, 'sequence-state.json'),
      join(dataDir, 'campaigns'), join(dataDir, 'tmp')
    ]
    let cleared = 0
    for (const t of targets) {
      try { if (existsSyncCheck(t)) { rmSync(t, { recursive: true, force: true }); cleared++ } }
      catch (e) { appLog.debug('[index] cache path removal failed', e instanceof Error ? e.message : String(e)) }
    }
    try {
      const { loadApplicantProfile, saveApplicantProfile } = require('./applicant-profile-store') as typeof import('./applicant-profile-store')
      const profile = loadApplicantProfile()
      if (profile.screeningAnswerCache && Object.keys(profile.screeningAnswerCache).length > 0) { saveApplicantProfile({ screeningAnswerCache: {} }); cleared++ }
    } catch (e) { appLog.debug('[index] screening cache clear failed', e instanceof Error ? e.message : String(e)) }
    return { ok: true, detail: `Cleared ${cleared} cache locations. Restart the app for a clean state.` }
  })
  handlers.set('mission:plan', async (payload) => {
    const planPayload = payload as { prompt?: string; draft?: Partial<AppSettings>; apiKey?: string | null } | undefined
    try {
      const prompt = String(planPayload?.prompt || '').trim()
      if (!prompt) return { ok: false as const, detail: 'Describe who you want to reach and why before building a plan.' }
      const settings = mergeSettingsPartial(loadSettings(), planPayload?.draft)
      const recentLogs = loadRecentLogLines(200)
      let outreachSummary: string | undefined
      if (recentLogs.length > 0) {
        const companies = new Map<string, number>()
        for (const log of recentLogs) { const co = String((log as unknown as Record<string, unknown>)?.company || '').trim(); if (co) companies.set(co, (companies.get(co) || 0) + 1) }
        if (companies.size > 0) { const top = [...companies.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10); outreachSummary = `Previously reached out to ${recentLogs.length} people. Top companies: ${top.map(([co, n]) => `${co} (${n})`).join(', ')}.` }
      }
      return { ok: true as const, ...(await planMission(settings, prompt, planPayload?.apiKey, outreachSummary)) }
    } catch (e) { return { ok: false as const, detail: e instanceof Error ? e.message : String(e) } }
  })
  handlers.set('compose:preview', async (payload) => {
    const cp = payload as { draft?: Partial<AppSettings>; apiKey?: string | null; target?: TargetRow } | undefined
    try {
      const settings = mergeSettingsPartial(loadSettings(), cp?.draft)
      const selectedExecution = getExecutionById(settings.lastExecutionId) ?? getExecutionById(DEFAULT_EXECUTION_ID)!
      const followUpPreviewSource = selectedExecution.queueKind === 'post_accept_dm' ? latestFollowUpPreviewSource() : null
      const previewExecution = followUpPreviewSource?.execution || selectedExecution
      const fallbackTarget = followUpPreviewSource?.target || previewTargetForExecution(previewExecution.id)
      const target = normalizePreviewTarget(cp?.target, fallbackTarget)
      const facts: ProfileFacts = { firstName: target.firstName, company: target.company, headline: target.headline }
      const preview = await composeMessageDetailed(settings, target, facts, { executionId: previewExecution.id, forFollowUp: selectedExecution.queueKind === 'post_accept_dm', apiKeyOverride: cp?.apiKey })
      return { ok: true as const, ...preview, resolvedExecutionId: previewExecution.id, resolvedExecutionLabel: previewExecution.label, resolvedFromFollowUpSource: !!followUpPreviewSource, sampleTarget: { profileUrl: target.profileUrl, firstName: target.firstName || facts.firstName || 'there', company: target.company || facts.company || 'your firm', headline: target.headline || facts.headline || '' } }
    } catch (e) { return { ok: false as const, detail: e instanceof Error ? e.message : String(e) } }
  })
  handlers.set('queue:state', async () => getQueueState())
  handlers.set('queue:start', async (payload) => {
    if (isQueueBusy()) return { ok: false as const, reason: 'already_running' as const }
    const ex = getExecutionById(loadSettings().lastExecutionId)
    const queuePayload = payload as TargetRow[] | QueueStartRequest
    const rawTargets = Array.isArray(queuePayload) ? queuePayload : (queuePayload?.targets ?? [])
    const dryRun = !Array.isArray(queuePayload) && !!queuePayload?.dryRun
    const messageOverride = !Array.isArray(queuePayload) ? String(queuePayload?.messageOverride || '').trim() || undefined : undefined
    const list = filterValidTargets(Array.isArray(rawTargets) ? rawTargets : [])
    const allowEmptyFollowUp = list.length === 0 && ex?.queueKind === 'post_accept_dm'
    if (list.length === 0 && !allowEmptyFollowUp) return { ok: false as const, reason: 'no_targets' as const }
    if (!dryRun) {
      try {
        const ping = await sendCommand('PING', {}, 15_000)
        if (!ping.ok) return { ok: false as const, reason: 'bridge_not_ready' as const, detail: ping.detail === 'open_a_linkedin_tab' ? 'Open a linkedin.com tab in Chrome before starting the run.' : ping.detail }
      } catch (e) { return { ok: false as const, reason: 'bridge_not_ready' as const, detail: e instanceof Error ? e.message : String(e) } }
    }
    const mw = ctx.getMainWindow()
    const notify = () => mw?.webContents.send('queue:tick', getQueueState())
    runQueue(allowEmptyFollowUp ? [] : list, notify, { dryRun, messageOverride }).catch((err) => appLog.error('[loa] runQueue unhandled error:', err))
    return { ok: true as const }
  })
  handlers.set('queue:stop', async () => { requestStop(); return { ok: true } })
  handlers.set('profile:mine', async (payload) => {
    const p = payload as { persist?: boolean; restoreAfter?: boolean } | undefined
    return extractOwnLinkedInProfileBackground({ persist: p?.persist !== false, restoreAfter: p?.restoreAfter !== false })
  })
  handlers.set('llm:testKey', async (payload) => {
    const tp = payload as { apiKey?: string | null } | undefined
    return testApiKey(loadSettings(), tp?.apiKey)
  })
  handlers.set('campaign:active', async () => {
    const active = loadActiveCampaign()
    if (!active) return { ok: true as const, campaign: null }
    return { ok: true as const, campaign: getCampaignSummary(active) }
  })
  handlers.set('campaign:create', async (payload) => {
    const cp = payload as { goal: string; plan: { title: string; summary: string; executionId: string; searchQuery: string }; targets: TargetRow[] } | undefined
    if (!cp?.goal || !cp?.plan || !cp?.targets?.length) return { ok: false as const, detail: 'Missing campaign data.' }
    return { ok: true as const, campaign: getCampaignSummary(createCampaign(cp.goal, cp.plan, cp.targets)) }
  })
  handlers.set('campaign:resume', async () => {
    const active = loadActiveCampaign()
    if (!active) return { ok: false as const, detail: 'No active campaign.' }
    return { ok: true as const, campaign: getCampaignSummary(active), remainingTargets: getRemainingTargets(active), plan: active.plan }
  })
  handlers.set('campaign:markSent', async (payload) => {
    const mp = payload as { campaignId: string; profileUrls: string[] } | undefined
    if (!mp?.campaignId) return { ok: false as const }
    markTargetsSent(mp.campaignId, mp.profileUrls || [])
    return { ok: true as const }
  })
  handlers.set('campaign:archive', async (payload) => {
    const ap = payload as { campaignId: string } | undefined
    if (!ap?.campaignId) return { ok: false as const }
    archiveCampaign(ap.campaignId)
    return { ok: true as const }
  })
  handlers.set('shell:openExtensionFolder', async () => { const dir = extensionDir(); const err = await shell.openPath(dir); if (err) throw new Error(err); return dir })
  handlers.set('shell:openUserData', async () => { const err = await shell.openPath(userDataDir()); if (err) throw new Error(err); return undefined })
  handlers.set('shell:openLogsFolder', async () => { const dir = runtimeLogsDir(); const err = await shell.openPath(dir); if (err) throw new Error(err); return dir })
  handlers.set('shell:openExternal', async (payload) => openExternalUrl(String(payload || '')))
  handlers.set('resume:tailor', async (payload) => {
    const tp = payload as { currentHeadline?: string; currentSummary?: string; jobDescription?: string; jobTitle?: string; company?: string }
    if (!tp?.jobDescription || !tp?.jobTitle) return { ok: false, headline: '', summary: '', tailored: false, detail: 'Missing job description or title.' }
    const { tailorResumeHeadlineSummary } = await import('./llm')
    return { ok: true, ...(await tailorResumeHeadlineSummary(loadSettings(), tp.currentHeadline || '', tp.currentSummary || '', tp.jobDescription, tp.jobTitle, tp.company || '')) }
  })
  handlers.set('ai:generateFields', async (payload) => {
    const ap = payload as { fields?: Array<{ name: string; instruction: string; source: 'auto' | 'ai' }>; target?: TargetRow; apiKey?: string | null } | undefined
    if (!ap?.fields?.length || !ap?.target) return { ok: false, values: {}, detail: 'Missing fields or target.' }
    const settings = loadSettings()
    const facts: ProfileFacts = { firstName: ap.target.firstName || ap.target.personName?.split(/\s+/)[0], company: ap.target.company, headline: ap.target.headline }
    return generateAiFields(settings, ap.fields, ap.target, facts, settings.userBackground || settings.resumeText || undefined, ap.apiKey)
  })
  handlers.set('profile:parse', async (payload) => {
    const pp = payload as { resumeText?: string } | undefined
    const text = String(pp?.resumeText || '').trim()
    if (!text) return { ok: false as const, detail: 'No resume text provided.' }
    try { return { ok: true as const, profile: await persistStructuredProfileFromResumeText(text) } }
    catch (e) { return { ok: false as const, detail: `Parse failed: ${e instanceof Error ? e.message : String(e)}` } }
  })
  handlers.set('profile:get', async () => {
    let profile = loadUserProfile()
    let hasProfile = hasUserProfile()
    // Lazy hydration: if no local profile but user is authenticated, try Firestore
    if (!hasProfile) {
      try {
        const { loadProfileFromFirestore } = await import('./firestore-profile')
        const remote = await loadProfileFromFirestore()
        if (remote) {
          const { saveUserProfile: saveUp } = await import('./profile-store')
          profile = saveUp(remote)
          const { syncApplicantFromUserProfile: syncAp } = await import('./user-applicant-sync')
          syncAp(profile, loadSettings().resumeText || '')
          hasProfile = true
          appLog.info('[profile:get] hydrated profile from Firestore', { name: profile.name })
        }
      } catch (e) {
        appLog.debug('[profile:get] Firestore hydration failed', e instanceof Error ? e.message : String(e))
      }
    }
    return { ok: true as const, profile, hasProfile }
  })
  handlers.set('profile:save', async (payload) => {
    const sp = payload as Partial<UserProfile> | undefined
    if (!sp) return { ok: false as const, detail: 'No profile data provided.' }
    const current = loadUserProfile()
    const saved = saveUserProfile({ ...current, ...sp })
    syncApplicantFromUserProfile(saved, loadSettings().resumeText || '')
    // Fire-and-forget Firestore sync
    import('./firestore-profile').then(({ syncProfileToFirestore }) =>
      syncProfileToFirestore(saved).catch(() => {})
    ).catch(() => {})
    return { ok: true as const, profile: saved }
  })
  handlers.set('resume:upload', async () => {
    const result = await uploadResume()
    if (result.ok) { try { const s = loadSettings(); if (s.resumeText) await persistStructuredProfileFromResumeText(s.resumeText) } catch (e) { appLog.debug('[index] structured profile sync after resume upload failed', e instanceof Error ? e.message : String(e)) } }
    return result
  })
  handlers.set('resume:importPath', async (payload) => {
    const result = await importResumeFromPath(String(payload || ''))
    if (result.ok) { try { const s = loadSettings(); if (s.resumeText) await persistStructuredProfileFromResumeText(s.resumeText) } catch (e) { appLog.debug('[index] structured profile extraction failed', e instanceof Error ? e.message : String(e)) } }
    return result
  })
  handlers.set('resume:importData', async (payload) => {
    const dp = payload as { fileName?: string; dataBase64?: string } | undefined
    const result = await importResumeFromData(String(dp?.fileName || ''), String(dp?.dataBase64 || ''))
    if (result.ok) { try { const s = loadSettings(); if (s.resumeText) await persistStructuredProfileFromResumeText(s.resumeText) } catch (e) { appLog.debug('[index] structured profile sync after resume import failed', e instanceof Error ? e.message : String(e)) } }
    return result
  })
  handlers.set('resume:clear', async () => clearResume())
  handlers.set('followup:detectNow', async () => runDetectNow())
  handlers.set('followup:newAccepts', async () => ({ accepts: getNewAccepts() }))
  handlers.set('followup:clearAccepts', async () => { clearNewAccepts(); return { ok: true } })
  handlers.set('followup:pendingQueue', async () => ({ items: getPendingFollowUps() }))
  handlers.set('followup:cancelQueued', async (payload) => {
    const cp = payload as { id?: string }
    if (!cp?.id) return { ok: false, detail: 'No id provided.' }
    return { ok: cancelFollowUp(cp.id) }
  })
  handlers.set('backup:export', async () => exportBackup())
  handlers.set('backup:import', async () => importBackup())

  return handlers
}
