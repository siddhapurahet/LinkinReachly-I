import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyQueueItem } from '@core/application-types'
import { bridgeEvents } from '../../../src/main/bridge'

const mocks = vi.hoisted(() => ({
  handleEasyApply: vi.fn(),
  isExtensionConnected: vi.fn(() => true)
}))

vi.mock('../../../src/main/application-assistant', () => ({
  handleEasyApply: mocks.handleEasyApply
}))

vi.mock('../../../src/main/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/bridge')>()
  return {
    ...actual,
    isExtensionConnected: () => mocks.isExtensionConnected(),
    sendCommand: vi.fn().mockResolvedValue({ ok: false })
  }
})

vi.mock('../../../src/main/auth-service', () => ({
  isAuthenticated: () => false,
  getPlanState: () => ({ dailyApplyLimit: 100 })
}))

vi.mock('../../../src/main/service-config', () => ({
  isBackendConfigured: () => false
}))

vi.mock('../../../src/main/api-client', () => ({
  checkCanAct: vi.fn().mockResolvedValue({ ok: true, data: { allowed: true } }),
  incrementUsage: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../../../src/main/telemetry', () => ({
  trackOutreachSent: vi.fn(),
  trackApplicationSent: vi.fn(),
  trackApplicationFailed: vi.fn(),
  trackQueueStarted: vi.fn(),
  trackQueueCompleted: vi.fn(),
  trackError: vi.fn()
}))

const loadSettingsMock = vi.hoisted(() =>
  vi.fn(() => ({
    dailyCap: 100,
    sessionBreaksEnabled: false,
    sessionBreakEveryMin: 5,
    sessionBreakEveryMax: 8,
    sessionBreakDurationMin: 0,
    sessionBreakDurationMax: 0,
    delayBetweenRequestsMin: 0,
    delayBetweenRequestsMax: 0
  }))
)

vi.mock('../../../src/main/settings', () => ({
  loadSettings: () => loadSettingsMock(),
  getApiKey: () => null
}))

vi.mock('../../../src/main/applicant-profile-store', () => ({
  loadApplicantProfile: () => ({
    basics: {
      fullName: 'Test User',
      email: 'test@test.com',
      phone: '',
      city: '',
      state: '',
      country: '',
      postalCode: '',
      addressLine1: '',
      addressLine2: '',
      currentLocationLine: '',
      currentResidenceAnswer: ''
    },
    links: { linkedInUrl: '', githubUrl: '', portfolioUrl: '', websiteUrl: '' },
    background: { yearsOfExperience: '', educationSummary: '' },
    workAuth: {},
    compensation: {},
    assets: [],
    answerBank: [],
    screeningAnswerCache: {}
  }),
  saveApplicantProfile: vi.fn()
}))

let prevDataDir: string | undefined

function queueItem(id: string, surface: ApplyQueueItem['surface']): ApplyQueueItem {
  return {
    id,
    jobTitle: 'Engineer',
    company: 'Acme',
    location: '',
    linkedinJobUrl: 'https://example.com/j',
    applyUrl: 'https://example.com/j',
    surface,
    status: 'pending',
    addedAt: new Date().toISOString()
  }
}

/** Simulates a legacy queue row with surface "external" (Easy Apply–only builds coerce this on disk). */
function legacyExternalQueueItem(id: string): ApplyQueueItem {
  return {
    ...queueItem(id, 'linkedin_easy_apply'),
    surface: 'external' as unknown as ApplyQueueItem['surface']
  }
}

beforeEach(() => {
  prevDataDir = process.env['LOA_USER_DATA_DIR']
  process.env['LOA_USER_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'loa-runner-'))
  loadSettingsMock.mockImplementation(() => ({
    dailyCap: 100,
    sessionBreaksEnabled: false,
    sessionBreakEveryMin: 5,
    sessionBreakEveryMax: 8,
    sessionBreakDurationMin: 0,
    sessionBreakDurationMax: 0,
    delayBetweenRequestsMin: 0,
    delayBetweenRequestsMax: 0
  }))
  mocks.handleEasyApply.mockReset()
  mocks.handleEasyApply.mockResolvedValue({
    ok: true,
    phase: 'done' as const,
    detail: 'ok',
    recordId: 'rec-mock-1'
  })
})

afterEach(async () => {
  try {
    const { stopApplyQueueRunner, isApplyQueueRunnerBusy } = await import('../../../src/main/apply-queue-runner')
    stopApplyQueueRunner()
    await vi.waitUntil(() => !isApplyQueueRunnerBusy(), { timeout: 4000 })
  } catch {
    /* allow teardown after a stuck runner */
  }
  const d = process.env['LOA_USER_DATA_DIR']
  if (d && existsSync(d)) {
    rmSync(d, { recursive: true, force: true })
  }
  if (prevDataDir === undefined) delete process.env['LOA_USER_DATA_DIR']
  else process.env['LOA_USER_DATA_DIR'] = prevDataDir
})

describe('apply-queue-runner', () => {
  it('exports notifier and idle state before run', async () => {
    const { configureApplyQueueNotifier, isApplyQueueRunnerBusy } = await import(
      '../../../src/main/apply-queue-runner'
    )
    configureApplyQueueNotifier(() => {})
    expect(isApplyQueueRunnerBusy()).toBe(false)
  })

  it('processes Easy Apply item when handleEasyApply succeeds', async () => {
    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    addToQueue([queueItem('job-1', 'linkedin_easy_apply')])
    startApplyQueueRunner()
    await vi.waitUntil(() => loadQueue().items[0]?.status === 'done', { timeout: 5000 })
    expect(mocks.handleEasyApply).toHaveBeenCalledTimes(1)
    expect(loadQueue().items[0]?.status).toBe('done')
  })

  it('marks Easy Apply error (not done) when submit was not confirmed despite recordId', async () => {
    mocks.handleEasyApply.mockResolvedValue({
      ok: false,
      phase: 'submit' as const,
      detail:
        'Automatic submission was not confirmed. Filled 0/0 fields. Please verify manually.',
      recordId: 'rec-needs-verify',
      fieldsAttempted: 0,
      fieldsFilled: 0
    })
    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    addToQueue([queueItem('job-unconfirmed', 'linkedin_easy_apply')])
    startApplyQueueRunner()
    await vi.waitUntil(() => loadQueue().items[0]?.status === 'error', { timeout: 5000 })
    expect(loadQueue().items[0]?.detail || '').toMatch(/not confirmed/)
    expect(loadQueue().items[0]?.status).toBe('error')
    expect(mocks.handleEasyApply).toHaveBeenCalledTimes(1)
  })

  it('updates existing needs_review record to failed for unavailable Easy Apply without duplicating history', async () => {
    const { appendApplicationRecord, loadApplicationHistory } = await import('../../../src/main/application-history-store')
    const existing = appendApplicationRecord({
      company: 'Acme',
      title: 'Engineer',
      location: '',
      jobUrl: 'https://example.com/j',
      easyApply: true,
      source: 'linkedin_easy_apply',
      outcome: 'needs_review',
      detail: "The Easy Apply form didn't open on this page. The job may have been removed or may not support Easy Apply. Filled 0/0 fields."
    })

    mocks.handleEasyApply.mockResolvedValue({
      ok: false,
      phase: 'submit' as const,
      detail: "The Easy Apply form didn't open on this page. The job may have been removed or may not support Easy Apply. Filled 0/0 fields.",
      recordId: existing.id
    })

    const { clearQueue, loadQueue, saveQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    saveQueue({
      items: [queueItem('job-sdui-modal', 'linkedin_easy_apply')],
      running: false,
      currentIndex: 0
    })
    startApplyQueueRunner()

    // Failed apply no longer removes the item from Ready to apply — it stays as 'error' so the user can retry.
    await vi.waitUntil(() => loadQueue().items[0]?.status === 'error', { timeout: 5000 })
    const recordsForJob = loadApplicationHistory().filter((r) => r.jobUrl === 'https://example.com/j')
    expect(recordsForJob.length).toBe(1)
    expect(recordsForJob[0]?.id).toBe(existing.id)
    expect(recordsForJob[0]?.outcome).toBe('blocked')
    expect(loadQueue().items[0]?.applicationRecordId).toBe(existing.id)
  })

  it('upgrades matching needs_review record when unavailable Easy Apply result is missing recordId', async () => {
    const { appendApplicationRecord, loadApplicationHistory } = await import('../../../src/main/application-history-store')
    const jobUrl = 'https://example.com/j-missing-id'
    const detail = "The Easy Apply form didn't open on this page. The job may have been removed or may not support Easy Apply. Filled 0/0 fields."
    const existing = appendApplicationRecord({
      company: 'Acme',
      title: 'Engineer',
      location: '',
      jobUrl,
      easyApply: true,
      source: 'linkedin_easy_apply',
      outcome: 'needs_review',
      detail: `${detail} sessionId=99`
    })

    mocks.handleEasyApply.mockResolvedValue({
      ok: false,
      phase: 'submit' as const,
      detail
    })

    const { clearQueue, loadQueue, saveQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    const item = queueItem('job-sdui-modal-missing-id', 'linkedin_easy_apply')
    item.linkedinJobUrl = jobUrl
    item.applyUrl = jobUrl
    saveQueue({
      items: [item],
      running: false,
      currentIndex: 0
    })
    startApplyQueueRunner()

    // Failed apply no longer removes the item from Ready to apply — it stays as 'error' so the user can retry.
    await vi.waitUntil(() => loadQueue().items[0]?.status === 'error', { timeout: 5000 })
    const recordsForJob = loadApplicationHistory().filter((r) => r.jobUrl === jobUrl)
    expect(recordsForJob.length).toBe(1)
    expect(recordsForJob[0]?.id).toBe(existing.id)
    expect(recordsForJob[0]?.outcome).toBe('blocked')
    expect(loadQueue().items[0]?.applicationRecordId).toBe(existing.id)
  })

  it('does not treat unavailable Easy Apply auto-skip as a hard failure', async () => {
    mocks.handleEasyApply.mockResolvedValue({
      ok: false,
      phase: 'click_apply' as const,
      detail: 'easy_apply_button_not_found'
    })

    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    addToQueue([queueItem('job-skip-hardfail', 'linkedin_easy_apply')])
    startApplyQueueRunner()

    // Failed apply no longer removes the item from Ready to apply — it stays as 'error' so the user can retry.
    await vi.waitUntil(() => loadQueue().items[0]?.status === 'error', { timeout: 5000 })
    expect(loadQueue().lastErrorCode).not.toBe('easy_apply_failed')
  })

  it('stops queue and sets lastError when bridge disconnects mid-run', async () => {
    mocks.handleEasyApply.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                phase: 'done' as const,
                detail: 'ok',
                recordId: 'rec-late'
              }),
            2000
          )
        })
    )
    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier, setBridgeReconnectGraceMs, isApplyQueueRunnerBusy: isBusy } = await import('../../../src/main/apply-queue-runner')
    setBridgeReconnectGraceMs(80)
    configureApplyQueueNotifier(() => {})
    clearQueue()
    addToQueue([queueItem('job-dc', 'linkedin_easy_apply')])
    startApplyQueueRunner()
    await new Promise((r) => setTimeout(r, 40))
    mocks.isExtensionConnected.mockReturnValue(false)
    bridgeEvents.emit('disconnected')
    await new Promise((r) => setTimeout(r, 200))
    expect(loadQueue().lastError || '').toMatch(/disconnect|Chrome/i)
    setBridgeReconnectGraceMs(8_000)
    mocks.isExtensionConnected.mockReturnValue(true)
    await vi.waitUntil(() => !isBusy(), { timeout: 4000 })
  })

  it('marks legacy external surface item error without opening a browser', async () => {
    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    addToQueue([legacyExternalQueueItem('job-ext')])
    startApplyQueueRunner()
    await vi.waitUntil(() => loadQueue().items[0]?.status === 'error', { timeout: 5000 })
    expect(loadQueue().items[0]?.status).toBe('error')
    expect(loadQueue().items[0]?.detail || '').toMatch(/Easy Apply only|not supported/i)
    expect(mocks.handleEasyApply).not.toHaveBeenCalled()
  })

  it('hard-stops queue when preflight detail mentions extension reload (no blockReason)', async () => {
    mocks.handleEasyApply.mockResolvedValue({
      ok: false,
      phase: 'preflight' as const,
      detail: 'Extension outdated. Reload LinkinReachly at chrome://extensions, then retry.'
    })
    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    addToQueue([queueItem('job-preflight-text', 'linkedin_easy_apply')])
    startApplyQueueRunner()
    await vi.waitUntil(() => loadQueue().lastErrorCode === 'extension_stale', { timeout: 5000 })
    expect(loadQueue().running).toBe(false)
  })

  it('hard-stops queue on extension stale from Easy Apply', async () => {
    mocks.handleEasyApply.mockResolvedValue({
      ok: false,
      phase: 'preflight' as const,
      detail: 'Extension outdated. Reload LinkinReachly at chrome://extensions, then retry.',
      blockReason: 'extension_stale' as const,
      blockStage: 'content_version'
    })
    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { loadApplicationHistory } = await import('../../../src/main/application-history-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    addToQueue([queueItem('job-stale', 'linkedin_easy_apply')])
    startApplyQueueRunner()
    await vi.waitUntil(() => loadQueue().lastErrorCode === 'extension_stale', { timeout: 5000 })
    expect(loadQueue().running).toBe(false)
    const rec = loadApplicationHistory().find((r) => r.reasonSnippet === 'extension_stale')
    expect(rec?.outcome).toBe('failed')
    expect(rec?.detail).toBe('extension_stale')
    expect(mocks.handleEasyApply).toHaveBeenCalledTimes(1)
  })

  it('stops after daily cap with second item still pending', async () => {
    loadSettingsMock.mockImplementation(() => ({
      dailyCap: 1,
      sessionBreaksEnabled: false,
      sessionBreakEveryMin: 5,
      sessionBreakEveryMax: 8,
      sessionBreakDurationMin: 0,
      sessionBreakDurationMax: 0,
      delayBetweenRequestsMin: 0,
      delayBetweenRequestsMax: 0
    }))
    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    addToQueue([queueItem('job-a', 'linkedin_easy_apply'), queueItem('job-b', 'linkedin_easy_apply')])
    startApplyQueueRunner()
    await vi.waitUntil(
      () => loadQueue().lastErrorCode === 'daily_cap' && loadQueue().items[0]?.status === 'done',
      { timeout: 5000 }
    )
    expect(loadQueue().items[1]?.status).toBe('pending')
    expect(mocks.handleEasyApply).toHaveBeenCalledTimes(1)
  })

  it('stops queue on challenge-like Easy Apply failure', async () => {
    mocks.handleEasyApply.mockResolvedValue({
      ok: false,
      phase: 'fill_fields' as const,
      detail: 'LinkedIn showed a security check (CAPTCHA).'
    })
    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    addToQueue([queueItem('job-chal', 'linkedin_easy_apply')])
    startApplyQueueRunner()
    await vi.waitUntil(() => loadQueue().lastErrorCode === 'verification_required', { timeout: 5000 })
    expect(loadQueue().running).toBe(false)
  })

  it('marks legacy external item error even when URLs look like LinkedIn', async () => {
    const { clearQueue, addToQueue, loadQueue } = await import('../../../src/main/apply-queue-store')
    const { startApplyQueueRunner, configureApplyQueueNotifier } = await import('../../../src/main/apply-queue-runner')
    configureApplyQueueNotifier(() => {})
    clearQueue()
    const item = legacyExternalQueueItem('job-ext-linkedin')
    item.linkedinJobUrl = 'https://www.linkedin.com/jobs/view/123456/'
    item.applyUrl = 'https://www.linkedin.com/jobs/view/123456/'
    addToQueue([item])
    startApplyQueueRunner()
    await vi.waitUntil(() => loadQueue().items[0]?.status === 'error', { timeout: 5000 })
    expect(loadQueue().items[0]?.detail || '').toMatch(/Easy Apply only|not supported/i)
    expect(mocks.handleEasyApply).not.toHaveBeenCalled()
  })
})
