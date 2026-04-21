import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { AppLogo } from '@/components/AppLogo'
import { WizardFlow } from '@/components/WizardFlow'
import { FollowUpPanel } from '@/components/FollowUpPanel'
import { HistoryPanel } from '@/components/HistoryPanel'
import { JobsPanel } from '@/components/JobsPanel'
import type { SmartSearchProgress } from '@/components/jobs-smart-search-status'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useAppModel } from '@/hooks/useAppModel'
import { useAppPolling } from '@/hooks/useAppPolling'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { getLoa } from '@/loa-client'
import type { JobsSearchFiltersPersisted } from '@/types/app'
import type { DebugLogSide } from '@/components/RuntimeDebugLogDock'
import { RuntimeDebugLogDock } from '@/components/RuntimeDebugLogDock'
import { SettingsPanel } from '@/components/SettingsPanel'
import { LoginScreen } from '@/components/LoginScreen'
import { UpgradeModal, type UpgradeTrigger } from '@/components/UpgradeModal'
import { usePlanState } from '@/hooks/usePlanState'
import { hasShownUpgradeThisSession } from '@/components/upgrade-tracking'
import { initAuth, logout, type AuthUser } from '@/auth'
import { AppRail } from '@/components/AppRail'
import { OnboardingOverlay } from '@/components/OnboardingOverlay'
import { ResumeGateScreen } from '@/components/ResumeGateScreen'
import { ExtensionSetupModal } from '@/components/ExtensionSetupModal'
import { PMFSurvey } from '@/components/PMFSurvey'
import { DashboardPanel } from '@/components/DashboardPanel'
import { DEFAULT_APPLY_DAILY_CAP, PLAN_LIMITS, TRIAL_DAYS } from '@core/plan-config'

const TRIAL_MILESTONE_DAYS: readonly number[] = [2, 1]

export default function App() {
  const model = useAppModel()
  const planState = usePlanState()
  const [activePanel, setActivePanel] = useState<'connect' | 'history' | 'settings' | 'jobs' | 'dashboard'>('jobs')
  const [showLogin, setShowLogin] = useState(false)
  const [upgradeTrigger, setUpgradeTrigger] = useState<{ trigger: UpgradeTrigger; context?: { name?: string; count?: number; scores?: string; trialApps?: number; trialResponses?: number } } | null>(null)
  const [firebaseConfig, setFirebaseConfig] = useState<{ apiKey: string; authDomain: string; projectId: string; appId: string } | null>(null)

  // Expose platform to CSS for macOS traffic-light padding
  useEffect(() => {
    if (navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh')) {
      document.documentElement.setAttribute('data-platform', 'darwin')
    }
  }, [])

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const cfg = typeof window !== 'undefined' && window.loa?.authGetServiceConfig
          ? await window.loa.authGetServiceConfig()
          : await getLoa().authGetServiceConfig()

        if (cfg.firebase.apiKey) {
          setFirebaseConfig(cfg.firebase)
          initAuth(cfg.firebase)
        } else {
          initAuth({ apiKey: '', authDomain: '', projectId: '', appId: '' })
        }
      } catch (err) {
        console.error('[auth] Failed to get service config:', err)
        initAuth({ apiKey: '', authDomain: '', projectId: '', appId: '' })
      }
    }
    void fetchConfig()
  }, [])
  const [retryBusy, setRetryBusy] = useState(false)
  const [settingsReloadBusy, setSettingsReloadBusy] = useState(false)
  const [profileDrawerOpen, setProfileDrawerOpen] = useState(false)
  const [jobsPanelTab, setJobsPanelTab] = useState<'results' | 'queue'>('results')
  const [connectStepFromWizard, setConnectStepFromWizard] = useState<string>('connect')
  const [connectCompletedSteps, setConnectCompletedSteps] = useState<ReadonlySet<string>>(new Set())
  const [connectSubView, setConnectSubView] = useState<'outreach' | 'followup'>('outreach')
  const [historySubView, setHistorySubView] = useState<'apps' | 'outreach'>('apps')
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [profileGatePassed, setProfileGatePassed] = useState<boolean | null>(null) // null = checking
  const [showExtSetup, setShowExtSetup] = useState(false)
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; tone: 'info' | 'ok' | 'warn' | 'error'; action?: { label: string; onClick: () => void } }>>([])
  const { dailyProgress, dailyOutreach, weeklyOutreachWarn, answerBankCount, followUpBadge, queuedCount, lifecycleCounts, historyAppliedUrls } = useAppPolling()

  useEffect(() => {
    if (!dailyProgress || hasShownUpgradeThisSession()) return
    if (dailyProgress.applied >= dailyProgress.cap && dailyProgress.cap <= planState.dailyApplyLimit) {
      setUpgradeTrigger({ trigger: 'daily_limit_exhausted' })
    }
  }, [dailyProgress, planState.dailyApplyLimit])

  // Trial milestone: show upgrade nudge at specific days remaining
  useEffect(() => {
    if (hasShownUpgradeThisSession()) return
    if (!planState.isLoggedIn || !planState.isTrialing) return
    const days = planState.trialDaysRemaining
    if (!TRIAL_MILESTONE_DAYS.includes(days)) return
    const key = `loa:trial_warning_shown_${days}`
    if (sessionStorage.getItem(key)) return
    sessionStorage.setItem(key, '1')
    setUpgradeTrigger({
      trigger: 'trial_warning',
      context: { count: days, trialApps: lifecycleCounts.applied },
    })
  }, [planState.isLoggedIn, planState.isTrialing, planState.trialDaysRemaining, lifecycleCounts.applied])

  // Trial expiry: auto-show "trial ended" modal when user's trial just expired
  useEffect(() => {
    if (hasShownUpgradeThisSession()) return
    if (!planState.isLoggedIn || planState.plan !== 'free') return
    if (planState.isTrialing) return
    if (!planState.hadTrial) return
    if (!planState.userId) return
    setUpgradeTrigger({
      trigger: 'trial_ended',
      context: {
        trialApps: lifecycleCounts.applied,
        trialResponses: lifecycleCounts.responded,
      },
    })
  }, [planState.isLoggedIn, planState.plan, planState.isTrialing, planState.hadTrial, planState.userId, lifecycleCounts.applied, lifecycleCounts.responded])

  const handleLogin = useCallback((_user: AuthUser) => {
    setShowLogin(false)
    void planState.refresh()
  }, [planState])

  const handleLogout = useCallback(async () => {
    try {
      await logout()
    } catch (err) {
      console.error('[auth] logout failed:', err)
    }
    void planState.refresh()
  }, [planState])

  const toastIdRef = useRef(0)
  const toastTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const addToast = useCallback((message: string, tone: 'info' | 'ok' | 'warn' | 'error' | 'success' = 'info', action?: { label: string; onClick: () => void }) => {
    const id = ++toastIdRef.current
    const mapped = tone === 'success' ? 'ok' : tone
    setToasts((prev) => [...prev, { id, message, tone: mapped, action }])
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
      toastTimersRef.current.delete(id)
    }, 5000)
    toastTimersRef.current.set(id, timer)
  }, [])
  useEffect(() => () => {
    for (const t of toastTimersRef.current.values()) clearTimeout(t)
    toastTimersRef.current.clear()
  }, [])

  useEffect(() => {
    const unsub = getLoa().onAppToast((toast) => {
      addToast(toast.message, toast.tone)
    })
    return unsub
  }, [addToast])

  useEffect(() => {
    const unsub = getLoa().onUpdateReady((info) => {
      addToast(`Update v${info.version} downloaded \u2014 restart to apply`, 'info', {
        label: 'Restart now',
        onClick: () => {
          void (async () => {
            const result = await getLoa().updaterQuitAndInstall()
            if (result.status === 'error') addToast(`Restart failed: ${result.message || 'Unknown error'}`, 'error')
          })()
        }
      })
    })
    return unsub
  }, [addToast])

  const persistedJobSearchFilters = useMemo((): JobsSearchFiltersPersisted => {
    const s = model.settings
    const sortBy =
      s?.jobsSearchSortBy === 'R' || s?.jobsSearchSortBy === 'DD' ? s.jobsSearchSortBy : 'DD'
    const experienceLevels = Array.isArray(s?.jobsSearchExperienceLevels)
      ? s.jobsSearchExperienceLevels.filter((x): x is string => typeof x === 'string')
      : []
    const jobTypes = Array.isArray(s?.jobsSearchJobTypes)
      ? s.jobsSearchJobTypes.filter((x): x is string => typeof x === 'string')
      : []
    const remoteTypes = Array.isArray(s?.jobsSearchRemoteTypes)
      ? s.jobsSearchRemoteTypes.filter((x): x is string => typeof x === 'string')
      : []
    const recency =
      typeof s?.jobsSearchRecencySeconds === 'number' && Number.isFinite(s.jobsSearchRecencySeconds)
        ? s.jobsSearchRecencySeconds
        : 86400
    const distanceMiles =
      typeof s?.jobsSearchDistanceMiles === 'number' && Number.isFinite(s.jobsSearchDistanceMiles)
        ? s.jobsSearchDistanceMiles
        : 0
    const salaryFloor =
      typeof s?.jobsSearchSalaryFloor === 'number' && Number.isFinite(s.jobsSearchSalaryFloor)
        ? Math.max(0, Math.min(9, Math.floor(s.jobsSearchSalaryFloor)))
        : 0
    return {
      jobsSearchRecencySeconds: recency,
      jobsSearchSortBy: sortBy,
      jobsSearchDistanceMiles: distanceMiles,
      jobsSearchExperienceLevels: [...experienceLevels].sort(),
      jobsSearchJobTypes: [...jobTypes].sort(),
      jobsSearchRemoteTypes: [...remoteTypes].sort(),
      jobsSearchSalaryFloor: salaryFloor,
      jobsSearchFewApplicants: !!s?.jobsSearchFewApplicants,
      jobsSearchVerifiedOnly: !!s?.jobsSearchVerifiedOnly,
      jobsSearchEasyApplyOnly: s?.jobsSearchEasyApplyOnly !== false
    }
  }, [model.settings])

  useEffect(() => {
    if (model.settings && !model.settingsHydrating && model.settings.seenOnboarding === false) {
      setShowOnboarding(true)
    }
  }, [model.settings, model.settingsHydrating])

  // Profile gate: check if name + email + resume exist.
  // Sticky once passed: a transient applicantGet failure (401, race during settings churn,
  // etc.) must not flip the user back to the gate screen mid-session and wipe rendered jobs.
  useEffect(() => {
    if (model.settingsHydrating || !model.settings) return
    void (async () => {
      try {
        const r = await getLoa().applicantGet()
        if (r.ok) {
          const hasName = !!r.profile.basics.fullName?.trim()
          const hasEmail = !!r.profile.basics.email?.trim()
          const hasPhone = !!r.profile.basics.phone?.trim()
          const hasResume = r.profile.assets.some((a: { kind: string }) => a.kind === 'resume')
          const hasEducation = Array.isArray(r.profile.background?.educationHistory) && r.profile.background.educationHistory.length > 0
          const passes = hasName && hasEmail && hasPhone && hasResume && hasEducation
          setProfileGatePassed((prev) => (prev === true && !passes ? true : passes))
        }
        // On !ok / fetch error: leave the gate as-is. We don't downgrade a previously
        // passing profile based on a transient failure.
      } catch {
        // Same reasoning — keep prior state on error.
      }
    })()
  }, [model.settingsHydrating, model.settings, model.settings?.resumeFileName])




  

  // Sprint 3I: fire first-screen-seen event once after auth resolves
  const firstScreenFiredRef = useRef(false)
  useEffect(() => {
    if (model.settingsHydrating || firstScreenFiredRef.current) return
    firstScreenFiredRef.current = true
    const screen = showOnboarding ? 'onboarding' : showLogin ? 'login' : 'main'
    void getLoa().trackEvent('First Screen Seen', { screen }).catch(() => {})
  }, [model.settingsHydrating, showOnboarding, showLogin])

  const chromeReady = model.bridgeReady
  const desktopBackendReady = model.desktopBackendReady
  const previewOnlyMode = !desktopBackendReady
  const followUpMode = model.followUpRunWithoutList
  const noteReady = followUpMode ? true : model.noteOptions.some((text) => text.trim().length > 0)
  const listReady = model.followUpRunWithoutList ? true : model.targets.length > 0
  const hasPlannedSearch = !!(
    model.missionPlan?.ok &&
    model.missionPlan.executionId !== 'post_accept_followup'
  )
  const aiConfigured = !!(model.settings?.llmEnabled && model.settings.apiKeyPresent)
  const [jobsInitialSearch, setJobsInitialSearch] = useState<{ keywords: string; location?: string } | null>(null)
  const [connectSmartSearch, setConnectSmartSearch] = useState<{
    smartSearching: boolean
    smartProgress: SmartSearchProgress | null
  } | null>(null)
  const [smartSearchCancelPending, setSmartSearchCancelPending] = useState(false)
  const [debugLogOpen, setDebugLogOpen] = useState(false)
  const [debugLogSide, setDebugLogSide] = useState<DebugLogSide>('right')

  // PMF survey: estimate active days from trial state
  const pmfActiveDays = planState.isTrialing
    ? TRIAL_DAYS - planState.trialDaysRemaining
    : planState.hadTrial ? TRIAL_DAYS + 1 : 0



  useEffect(() => {
    if (model.jobSearchRequest) {
      setJobsInitialSearch(model.jobSearchRequest)
      model.clearJobSearchRequest()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- model.clearJobSearchRequest is stable
  }, [model.jobSearchRequest])

  useEffect(() => {
    if (connectSmartSearch?.smartSearching) return
    setSmartSearchCancelPending(false)
  }, [connectSmartSearch?.smartSearching])

  const cancelConnectSmartSearch = useCallback(async () => {
    if (!connectSmartSearch?.smartSearching || smartSearchCancelPending) return
    setSmartSearchCancelPending(true)
    try {
      const loa = getLoa() as { jobsCancelSearch?: () => Promise<unknown> }
      if (typeof loa.jobsCancelSearch === 'function') {
        await loa.jobsCancelSearch()
      }
    } finally {
      setSmartSearchCancelPending(false)
    }
  }, [connectSmartSearch?.smartSearching, smartSearchCancelPending])

  useKeyboardShortcuts(activePanel, setActivePanel, setDebugLogOpen)

  const PANELS_WITH_SURFACE_STYLES = new Set(['jobs', 'history'])
  const panelSurfaceClass =
    previewOnlyMode || !PANELS_WITH_SURFACE_STYLES.has(activePanel) ? '' : ` app-shell--surface-${activePanel}`

  const [devSkipAuth, setDevSkipAuth] = useState(false)
  const isDevMode = import.meta.env.DEV
  const requiresAuth = firebaseConfig?.apiKey && planState.authState.status === 'unauthenticated' && !devSkipAuth

  if (requiresAuth && firebaseConfig) {
    return (
      <LoginScreen
        firebaseConfig={firebaseConfig}
        onLogin={handleLogin}
        onDevSkip={isDevMode ? () => setDevSkipAuth(true) : undefined}
      />
    )
  }

  if (profileGatePassed === false && !model.settingsHydrating) {
    return (
      <ResumeGateScreen
        onReady={() => {
          setProfileGatePassed(true)
        }}
      />
    )
  }

  return (
    <div className={`app-shell${panelSurfaceClass}`}>
      <a href="#main-content" className="skip-link" onClick={model.skipToMain}>
        Skip to main content
      </a>

      {/* Single unified bar: logo + tabs + stats + chrome status */}
      <header className="app-bar" aria-describedby="nav-keyboard-hint">
        <p id="nav-keyboard-hint" className="sr-only">
          Keyboard: Command or Control plus 1 Jobs, 2 Outreach, 3 History, 4 Settings. Command or Control plus S saves settings. Command or Control plus D toggles the runtime log.
        </p>

        <AppLogo />
        <span className="app-bar__title">LinkinReachly</span>

        {!previewOnlyMode && (
          <nav
            className="app-bar__tabs nav"
            role="tablist"
            aria-label="Main sections"
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
                const currentIdx = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')
                if (currentIdx < 0) return
                const nextIdx = e.key === 'ArrowRight'
                  ? (currentIdx + 1) % tabs.length
                  : (currentIdx - 1 + tabs.length) % tabs.length
                tabs[nextIdx]?.click()
                tabs[nextIdx]?.focus()
              }
              if (e.key === 'Home') {
                e.preventDefault()
                const first = e.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')
                first?.click()
                first?.focus()
              }
              if (e.key === 'End') {
                e.preventDefault()
                const all = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                const last = all[all.length - 1]
                last?.click()
                last?.focus()
              }
            }}
          >
            <button
              type="button"
              role="tab"
              id="tab-jobs"
              className="tab-primary"
              aria-selected={activePanel === 'jobs'}
              aria-controls="panel-jobs"
              tabIndex={activePanel === 'jobs' ? 0 : -1}
              title="Search and apply to jobs (\u2318 1)"
              onClick={() => setActivePanel('jobs')}
            >
              Jobs
            </button>
            <button
              type="button"
              role="tab"
              id="tab-connect"
              className="tab-primary"
              aria-selected={activePanel === 'connect'}
              aria-controls="panel-connect"
              tabIndex={activePanel === 'connect' ? 0 : -1}
              title="Outreach, networking, and follow-ups (\u2318 2)"
              onClick={() => setActivePanel('connect')}
            >
              Outreach
              {followUpBadge > 0 && activePanel !== 'connect' && (
                <span className="tab-badge tab-badge--count" aria-label={`${followUpBadge} new connections this week`}>{followUpBadge}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              id="tab-dashboard"
              className="tab-secondary"
              aria-selected={activePanel === 'dashboard'}
              aria-controls="panel-dashboard"
              tabIndex={activePanel === 'dashboard' ? 0 : -1}
              title="Efficiency dashboard"
              onClick={() => setActivePanel('dashboard')}
            >
              Dashboard
            </button>
            <button
              type="button"
              role="tab"
              id="tab-history"
              className="tab-secondary"
              aria-selected={activePanel === 'history'}
              aria-controls="panel-history"
              tabIndex={activePanel === 'history' ? 0 : -1}
              title="Full outreach and application history (\u2318 3)"
              onClick={() => setActivePanel('history')}
            >
              History
            </button>
            <button
              type="button"
              role="tab"
              id="tab-settings"
              className="tab-secondary"
              aria-selected={activePanel === 'settings'}
              aria-controls="panel-settings"
              tabIndex={activePanel === 'settings' ? 0 : -1}
              title="App configuration (\u2318 4)"
              onClick={() => setActivePanel('settings')}
            >
              Settings
            </button>
          </nav>
        )}

        <div className="app-bar__right">
          {planState.authState.status === 'authenticated' ? (
            <>
              <span
                className="app-bar__segment app-bar__segment--plan"
                role="status"
                title={`${planState.isPlus ? 'Plus' : planState.isTrialing ? 'Trial' : 'Free'}${planState.creditBalance > 0 ? ` \u2014 ${planState.creditBalance} applications left today` : ''}`}
              >
                {planState.isPlus ? 'Plus' : planState.isTrialing ? 'TRIAL' : 'Free'}
              </span>
              <span className="app-bar__segment app-bar__segment--user">
                <button
                  type="button"
                  className="app-bar__segment-avatar"
                  onClick={() => void handleLogout()}
                  title="Sign out"
                  aria-label={`Signed in as ${planState.authState.user.email || planState.authState.user.displayName || 'user'}. Click to sign out.`}
                >
                  {planState.authState.user.displayName?.[0]?.toUpperCase() || planState.authState.user.email?.[0]?.toUpperCase() || '\u2713'}
                </button>
              </span>
            </>
          ) : firebaseConfig ? (
            <span className="app-bar__segment">
              <button
                type="button"
                className="hdr-signin-btn"
                onClick={() => setShowLogin(true)}
                title="Sign in with Google"
              >
                Sign in
              </button>
            </span>
          ) : null}
        </div>
      </header>

      {/* Trial banner — shown for users in their 3-day Plus trial; trust text merged inline */}
      {!previewOnlyMode && planState.isTrialing && planState.trialDaysRemaining > 0 ? (
        <div className="app-trial-bar" role="status">
          <span className="app-trial-bar__left">
            <span>Day {TRIAL_DAYS + 1 - planState.trialDaysRemaining} of {TRIAL_DAYS}</span>
            <span className="app-trial-bar__sep" aria-hidden="true">{'\u00b7'}</span>
            <span>{planState.trialDaysRemaining} day{planState.trialDaysRemaining === 1 ? '' : 's'} left in your Plus trial</span>
            <span className="app-trial-bar__pipe" aria-hidden="true" />
            <span className="app-trial-bar__trust">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a4 4 0 0 0-4 4v2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4zm2 6H6V5a2 2 0 1 1 4 0v2z"/></svg>
              All data stays on your device. No passwords stored. No LinkedIn credentials needed.
            </span>
          </span>
          <button type="button" className="app-trial-bar__cta" onClick={() => setUpgradeTrigger({ trigger: 'trial_warning' })}>Upgrade to Plus</button>
        </div>
      ) : (
        <div className="trust-banner" role="status">
          <svg className="trust-banner__icon" width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a4 4 0 0 0-4 4v2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4zm2 6H6V5a2 2 0 1 1 4 0v2z"/></svg>
          All data stays on your device. No passwords stored. No LinkedIn credentials needed.
        </div>
      )}

      {/* Free-plan and Chrome alert now consolidated in bottom status bar */}

      <div className="app-shell__body-row">
      {!previewOnlyMode && (
        <AppRail
          activePanel={activePanel}
          jobsSubView={jobsPanelTab}
          onJobsSubViewChange={setJobsPanelTab}
          connectStep={connectStepFromWizard}
          onConnectStepChange={setConnectStepFromWizard}
          connectCompletedSteps={connectCompletedSteps}
          connectSubView={connectSubView}
          onConnectSubViewChange={setConnectSubView}
          historySubView={historySubView}
          onHistorySubViewChange={setHistorySubView}
          appliedToday={dailyProgress?.applied ?? 0}
          applyCap={dailyProgress?.cap ?? model.settings?.applyDailyCap ?? DEFAULT_APPLY_DAILY_CAP}
          queuedCount={queuedCount}
          weeklyOutreachSent={weeklyOutreachWarn?.sent}
          userName={planState.authState.status === 'authenticated' ? (planState.authState.user.displayName || planState.authState.user.email || undefined) : undefined}
        />
      )}
      <div className="app-shell__main-wrap">
      <main id="main-content" className="main" tabIndex={-1}>
        {previewOnlyMode && (
          <section className="card" aria-labelledby="desktop-app-required-title">
            <div className="wizard-feedback wizard-feedback--warn" role="status">
              <strong id="desktop-app-required-title">Open the LinkinReachly app window.</strong> This tab cannot reach Chrome or the extension.
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={retryBusy}
                aria-busy={retryBusy}
                onClick={async () => {
                  setRetryBusy(true)
                  try { await model.refreshBridge() } finally { setRetryBusy(false) }
                }}
              >
                {retryBusy ? 'Retrying\u2026' : 'Retry'}
              </button>
            </div>
          </section>
        )}

        {!previewOnlyMode && activePanel === 'settings' && (
          <ErrorBoundary>
          <SettingsPanel
            model={model}
            planState={planState}
            answerBankCount={answerBankCount}
            addToast={addToast}
            onRestartSetup={() => { void model.showGettingStartedAgain(); setShowOnboarding(true); setActivePanel('jobs') }}
          />
          </ErrorBoundary>
        )}

        {model.settingsLoadError && (
          <div className="wizard-feedback wizard-feedback--warn settings-error-banner" role="alert">
            Could not load settings. Some features may use defaults until resolved.
            <div className="mt-xs">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={settingsReloadBusy}
                aria-busy={settingsReloadBusy}
                onClick={() => {
                  setSettingsReloadBusy(true)
                  void model
                    .reloadSettings()
                    .finally(() => setSettingsReloadBusy(false))
                }}
              >
                {settingsReloadBusy ? 'Retrying\u2026' : 'Retry'}
              </button>
            </div>
          </div>
        )}

        {/* Keep Connect mounted so wizard step + state survive tab switches */}
        {!previewOnlyMode && !model.settingsHydrating && (
          <ErrorBoundary>
          <div role="tabpanel" id="panel-connect" aria-labelledby="tab-connect" aria-describedby="panel-connect-desc" hidden={activePanel !== 'connect'}>
            <p id="panel-connect-desc" className="sr-only">
              Plan your outreach, craft messages, send connection invites, and manage follow-ups.
            </p>
            {connectSubView === 'followup' ? (
              <FollowUpPanel chromeReady={model.bridgeReady} />
            ) : (
              <WizardFlow
                model={model}
                chromeReady={chromeReady}
                noteReady={noteReady}
                listReady={listReady}
                followUpMode={followUpMode}
                hasPlannedSearch={hasPlannedSearch}
                aiConfigured={aiConfigured}
                followUpBadge={followUpBadge}
                smartSearchActivity={connectSmartSearch}
                onCancelSmartSearch={() => void cancelConnectSmartSearch()}
                smartSearchCancelPending={smartSearchCancelPending}
                onViewHistory={() => setActivePanel('history')}
                onStepChange={setConnectStepFromWizard}
                onCompletedStepsChange={setConnectCompletedSteps}
                externalStep={connectStepFromWizard}
              />
            )}
          </div>
          </ErrorBoundary>
        )}

        {/* Keep Jobs mounted while navigating other tabs so in-flight search + inputs survive tab switches */}
        {!previewOnlyMode && (
          <ErrorBoundary>
          <div
            role="tabpanel"
            id="panel-jobs"
            aria-labelledby="tab-jobs"
            hidden={activePanel !== 'jobs'}
          >
            <JobsPanel
              aiConfigured={aiConfigured}
              chromeReady={chromeReady}
              extensionConnected={model.bridge.extensionConnected}
              resumeFileName={model.settings?.resumeFileName}
              settingsReady={!model.settingsHydrating && model.settings != null}
              persistedJobKeywords={model.settings?.jobsSearchKeywords ?? ''}
              plan={planState.plan}
              persistedJobLocation={model.settings?.jobsSearchLocation ?? ''}
              persistedJobSearchFilters={persistedJobSearchFilters}
              persistedJobSearchHistory={model.settings?.jobsSearchHistory}
              onPublicSettings={model.setSettings}
              initialSearch={jobsInitialSearch}
              onSearchConsumed={() => setJobsInitialSearch(null)}
              onSmartSearchActivity={setConnectSmartSearch}
              onOpenProfile={() => setProfileDrawerOpen(prev => !prev)}
              profileExpanded={profileDrawerOpen}
              activeTab={jobsPanelTab}
              onActiveTabChange={setJobsPanelTab}
              historyAppliedUrls={historyAppliedUrls}
              onExtSetupNeeded={() => setShowExtSetup(true)}
              onNavigateToSettings={(section) => {
                setActivePanel('settings')
                requestAnimationFrame(() => {
                  const id = section === 'answers' ? 'settings-answer-bank' : 'settings-limits'
                  const el = document.getElementById(id)
                  if (el) {
                    if (el.tagName === 'DETAILS' && !(el as HTMLDetailsElement).open) (el as HTMLDetailsElement).open = true
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                })
              }}
              answerBankCount={answerBankCount ?? undefined}
              reviewBeforeSubmit={model.settings?.reviewBeforeSubmit}
              applyDailyCap={model.settings?.applyDailyCap}
              appliedToday={dailyProgress?.applied ?? 0}
              applyCap={dailyProgress?.cap ?? model.settings?.applyDailyCap ?? DEFAULT_APPLY_DAILY_CAP}
              showFirstSessionGuide={!!(model.settings?.seenOnboarding && !model.settings?.firstSessionGuideDismissed)}
              onDismissGuide={() => model.setSettings({ ...model.settings!, firstSessionGuideDismissed: true })}
            />
          </div>
          </ErrorBoundary>
        )}

        {!previewOnlyMode && (
          <ErrorBoundary>
          <div role="tabpanel" id="panel-dashboard" aria-labelledby="tab-dashboard" hidden={activePanel !== 'dashboard'}>
            <DashboardPanel />
          </div>
          </ErrorBoundary>
        )}

        {!previewOnlyMode && (
          <ErrorBoundary>
          <div role="tabpanel" id="panel-history" aria-labelledby="tab-history" aria-describedby="panel-history-desc" hidden={activePanel !== 'history'}>
            <p id="panel-history-desc" className="sr-only">
              Track your job applications and outreach activity.
            </p>
            <HistoryPanel
              model={model}
              initialTab={historySubView === 'apps' ? 'applications' : 'campaign'}
              onTabChange={(tab) => setHistorySubView(tab === 'applications' ? 'apps' : 'outreach')}
              plan={planState.plan}
              onNavigateToAnswerBank={() => { setActivePanel('settings'); requestAnimationFrame(() => { const el = document.getElementById('settings-answer-bank'); if (el) { if (el.tagName === 'DETAILS' && !(el as HTMLDetailsElement).open) (el as HTMLDetailsElement).open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }) } }) }}
            />
          </div>
          </ErrorBoundary>
        )}

      </main>
      </div>
      {import.meta.env.DEV && (
        <RuntimeDebugLogDock
          open={debugLogOpen}
          side={debugLogSide}
          onSideChange={setDebugLogSide}
          onClose={() => setDebugLogOpen(false)}
        />
      )}
      </div>
      {showExtSetup && (
        <ExtensionSetupModal
          extensionConnected={model.bridge.extensionConnected}
          onDismiss={() => setShowExtSetup(false)}
          onConnected={() => setShowExtSetup(false)}
        />
      )}
      {showOnboarding && (
        <OnboardingOverlay
          model={model}
          onComplete={(initialSearch) => {
            setShowOnboarding(false)
            if (initialSearch) {
              setJobsInitialSearch(initialSearch)
              setActivePanel('jobs')
            }
          }}
        />
      )}
      {showLogin && firebaseConfig && (
        <LoginScreen
          firebaseConfig={firebaseConfig}
          onLogin={handleLogin}
          onSkip={() => setShowLogin(false)}
        />
      )}
      {upgradeTrigger && (
        <UpgradeModal
          trigger={upgradeTrigger.trigger}
          context={upgradeTrigger.context}
          plan={planState.plan}
          creditBalance={planState.creditBalance}
          onDismiss={() => setUpgradeTrigger(null)}
          onPlanRefresh={() => void planState.refresh()}
        />
      )}
      {!previewOnlyMode && planState.isLoggedIn && (
        <PMFSurvey activeDays={pmfActiveDays} />
      )}
      {toasts.length > 0 && (
        <div className="app-toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`app-toast app-toast--${t.tone}`} role="status">
              {t.message}
              {t.action && (
                <button type="button" className="btn btn-ghost btn-xs app-toast__action" onClick={t.action.onClick}>
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!previewOnlyMode && (() => {
        const barTone = !chromeReady ? 'amber' : (planState.isPlus || planState.isTrialing) && chromeReady ? 'dark' : 'green'
        const chromeLabel = chromeReady ? 'Chrome ready' : 'Chrome disconnected'
        const applyLimit = planState.dailyApplyLimit
        const outreachLimit = planState.dailyOutreachLimit
        const applySent = dailyProgress?.applied ?? 0
        const outreachSent = dailyOutreach
        const applyPct = Math.min(applySent / applyLimit, 1) * 100
        const outreachPct = Math.min(outreachSent / outreachLimit, 1) * 100
        const allDone = applySent >= applyLimit && outreachSent >= outreachLimit
        const weeklyWarn = weeklyOutreachWarn && weeklyOutreachWarn.sent >= weeklyOutreachWarn.cap * 0.8
          ? `Weekly invites: ${weeklyOutreachWarn.sent} of ${weeklyOutreachWarn.cap}`
          : null
        return (
          <div className={`app-status-bar app-status-bar--${barTone}`} role="status" aria-live="polite">
            <span className="app-status-bar__left">
              <span className="app-status-bar__section app-status-bar__section--health">
                <span className={`app-status-bar__dot app-status-bar__dot--${chromeReady ? 'ok' : 'warn'}`} aria-hidden="true" />
                <span>{chromeReady ? 'Ready' : 'Disconnected'}</span>
                {!chromeReady && (
                  <button type="button" className="app-status-bar__action app-status-bar__action--inline" onClick={() => setShowExtSetup(true)}>Fix</button>
                )}
              </span>
              <span className="app-status-bar__divider" aria-hidden="true" />
              <span className="app-status-bar__section app-status-bar__section--progress">
                {allDone ? (
                  <span className="app-status-bar__done">{'\u2713'} Daily goals complete</span>
                ) : (
                  <>
                    <span className="app-status-bar__progress">
                      <span className="app-status-bar__progress-label">Apply</span>
                      <span className="app-status-bar__track"><span className="app-status-bar__fill" style={{ width: `${applyPct}%` }} /></span>
                      <span className="app-status-bar__progress-val">{applySent}/{applyLimit}</span>
                    </span>
                    <span className="app-status-bar__progress">
                      <span className="app-status-bar__progress-label">Outreach</span>
                      <span className="app-status-bar__track"><span className="app-status-bar__fill" style={{ width: `${outreachPct}%` }} /></span>
                      <span className="app-status-bar__progress-val">{outreachSent}/{outreachLimit}</span>
                    </span>
                  </>
                )}
                {weeklyWarn && <><span className="app-status-bar__sep" aria-hidden="true">{'\u00b7'}</span><span>{weeklyWarn}</span></>}
              </span>
            </span>
            <span className="app-status-bar__right">
              {!planState.isPlus && (
                <span className="app-status-bar__plan-link">
                  {planState.isTrialing ? 'Trial' : 'Free'}{' \u00b7 '}
                  <button type="button" className="app-status-bar__action app-status-bar__action--subtle" onClick={() => setUpgradeTrigger({ trigger: 'upgrade_cta' })}>Upgrade</button>
                </span>
              )}
            </span>
          </div>
        )
      })()}
    </div>
  )
}
