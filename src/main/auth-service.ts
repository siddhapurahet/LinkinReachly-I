// ---------------------------------------------------------------------------
// auth-service.ts (main process) — Manages the Firebase ID token received
// from the renderer, user plan state, and provides authenticated headers
// for backend API calls.
// ---------------------------------------------------------------------------

import { appLog } from './app-log'
import { PLAN_LIMITS, TRIAL_LIMITS, TRIAL_DAYS, type UserPlan } from '@core/plan-config'

export type { UserPlan }

let _firebaseIdToken: string | null = null

export interface UserPlanState {
  userId: string | null
  plan: UserPlan
  creditBalance: number
  trialStartedAt: string | null
  trialEndsAt: string | null
  dailyApplyLimit: number
  dailyOutreachLimit: number
  isTrialing: boolean
  trialDaysRemaining: number
}

function computeTrialState(startedAt: string | null): { isTrialing: boolean; daysRemaining: number; endsAt: string | null } {
  if (!startedAt) return { isTrialing: false, daysRemaining: 0, endsAt: null }
  const start = new Date(startedAt)
  const end = new Date(start.getTime() + TRIAL_DAYS * 86_400_000)

  // Calendar-day difference so the counter decrements once per day at midnight,
  // not at the exact hour the trial started (which felt broken to users).
  const now = new Date()
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endMidnight = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  const calendarDays = Math.max(0, Math.round((endMidnight.getTime() - todayMidnight.getTime()) / 86_400_000))

  // Trial is active until the exact timestamp, even if calendarDays rounds to 0
  const isTrialing = end.getTime() > Date.now()
  return { isTrialing, daysRemaining: calendarDays, endsAt: end.toISOString() }
}

let _onPlanStateChanged: ((state: UserPlanState) => void) | null = null
export function onPlanStateChanged(cb: (state: UserPlanState) => void): void { _onPlanStateChanged = cb }

let _planState: UserPlanState = {
  userId: null,
  plan: 'free',
  creditBalance: 0,
  trialStartedAt: null,
  trialEndsAt: null,
  dailyApplyLimit: PLAN_LIMITS.free.apply,
  dailyOutreachLimit: PLAN_LIMITS.free.outreach,
  isTrialing: false,
  trialDaysRemaining: 0,
}

export function setFirebaseToken(token: string | null): void {
  _firebaseIdToken = token
  appLog.info('[auth] Firebase ID token updated', { hasToken: !!token })
}

export function getFirebaseToken(): string | null {
  return _firebaseIdToken
}

export function getAuthHeaders(): Record<string, string> {
  if (!_firebaseIdToken) return {}
  return { Authorization: `Bearer ${_firebaseIdToken}` }
}

export function isAuthenticated(): boolean {
  return !!_firebaseIdToken
}

export function updatePlanState(partial: Partial<UserPlanState>): void {
  _planState = { ..._planState, ...partial }
  const plan = _planState.plan

  const trial = computeTrialState(_planState.trialStartedAt)
  _planState.isTrialing = trial.isTrialing
  _planState.trialDaysRemaining = trial.daysRemaining
  _planState.trialEndsAt = trial.endsAt

  const effectiveLimits = trial.isTrialing ? TRIAL_LIMITS : PLAN_LIMITS[plan]
  _planState.dailyApplyLimit = effectiveLimits.apply
  _planState.dailyOutreachLimit = effectiveLimits.outreach

  appLog.info('[auth] Plan state updated', {
    plan,
    credits: _planState.creditBalance,
    applyLimit: _planState.dailyApplyLimit,
    outreachLimit: _planState.dailyOutreachLimit,
    isTrialing: _planState.isTrialing,
    trialDaysRemaining: _planState.trialDaysRemaining,
  })

  if (_onPlanStateChanged) _onPlanStateChanged({ ..._planState })
}

export function getPlanState(): UserPlanState {
  // Recompute trial state on every read so `trialDaysRemaining` stays
  // accurate as calendar days tick over without requiring a separate
  // `updatePlanState` call.
  const trial = computeTrialState(_planState.trialStartedAt)
  _planState.isTrialing = trial.isTrialing
  _planState.trialDaysRemaining = trial.daysRemaining
  _planState.trialEndsAt = trial.endsAt

  const devPlan = process.env.LR_DEV_PLAN as UserPlan | undefined
  if (devPlan && (devPlan === 'free' || devPlan === 'plus')) {
    const limits = PLAN_LIMITS[devPlan]
    return {
      ..._planState,
      plan: devPlan,
      dailyApplyLimit: limits.apply,
      dailyOutreachLimit: limits.outreach,
      isPlus: devPlan === 'plus',
    } as UserPlanState & { isPlus: boolean }
  }
  return { ..._planState }
}

export function getPlanLimits(plan: UserPlan): { apply: number; outreach: number } {
  return { ...PLAN_LIMITS[plan] }
}
