if (!_lrDormant) {

function inferEasyApplyFromCard(card) {
  if (!card) return false
  const markers = card.querySelectorAll(
    [
      '.job-card-container__apply-method',
      '.job-card-list__easy-apply-label',
      '.job-card-container__footer-item--highlighted',
      '[aria-label*="Easy Apply" i]',
      '[aria-label*="easy apply" i]',
      '[title*="Easy Apply" i]',
      '[data-test-id*="easy-apply" i]',
      '[data-test-id*="easyApply" i]',
      '[class*="easy-apply" i]',
      '[class*="easyApply" i]',
      '[class*="jobs-easy-apply" i]',
      'svg[aria-label*="easy apply" i]',
      'svg[aria-label*="Easy Apply" i]'
    ].join(', ')
  )
  for (const marker of markers) {
    if (!elementVisible(marker)) continue
    const text = `${readCardText(marker)} ${nodeAria(marker)}`.toLowerCase()
    if (text.includes('easy apply')) return true
  }
  const footerSelectors = [
    '.job-card-list__footer-wrapper',
    '.job-card-container__footer-wrapper',
    '.job-card-list__footer',
    '.job-card-container__footer',
    '[class*="job-card-list__footer" i]',
    '[class*="job-card-container__footer" i]',
    '[class*="apply-method" i]'
  ].join(', ')
  const footer = card.querySelector(footerSelectors)
  const footerText = compactText(footer?.textContent || '').toLowerCase()
  if (footerText.includes('easy apply')) return true

  // LinkedIn refreshes often move/rename nodes; whole-card scan is a stable fallback for one job per card.
  const cardText = compactText(card.textContent || '').toLowerCase()
  if (/\beasy apply\b/.test(cardText)) return true
  return false
}

function inferApplyCtaSearchRoots(scope) {
  if (scope !== document) return [scope]
  const roots = [document]
  const sr = sduiShadowRoot()
  if (sr) roots.push(sr)
  try {
    const preload = document.querySelector('iframe[src*="preload"]')
    const doc = preload?.contentDocument
    if (doc) roots.push(doc)
  } catch {
    /* cross-origin */
  }
  return roots
}

function inferApplyCta(scope = document) {
  const selectors = [
    'button.jobs-apply-button',
    'a.jobs-apply-button',
    '.jobs-apply-button button',
    '.jobs-apply-button a',
    'button[aria-label*="easy apply" i]',
    'a[aria-label*="easy apply" i]',
    'button[aria-label*="apply" i]',
    'a[aria-label*="apply" i]',
    'a[href*="offsite"]'
  ]
  const seen = new Set()
  let fallbackApplyUrl = ''
  let fallbackButtonText = ''
  for (const root of inferApplyCtaSearchRoots(scope)) {
    if (!root) continue
    for (const selector of selectors) {
      for (const el of root.querySelectorAll(selector)) {
        if (seen.has(el)) continue
        seen.add(el)
        const text = compactText(`${readCardText(el)} ${nodeAria(el)}`)
        const lower = text.toLowerCase()
        const href = typeof el.getAttribute === 'function' ? String(el.getAttribute('href') || '') : ''
        const outbound = extractOutboundUrl((el.href || href || '').trim())
        const hasApplySignal =
          lower.includes('easy apply') ||
          /\bapply\b/i.test(lower) ||
          lower.includes('submit application') ||
          lower.includes('apply on company website') ||
          String(el.className || '').toLowerCase().includes('jobs-apply-button')
        if (!hasApplySignal) continue
        if (lower.includes('easy apply')) {
          return {
            easyApply: true,
            applyUrl: normalizeJobUrl(window.location.href),
            buttonText: text
          }
        }
        if (outbound && !isLinkedInUrlCandidate(outbound)) {
          return {
            easyApply: false,
            applyUrl: outbound,
            buttonText: text
          }
        }
        if (!fallbackApplyUrl && outbound) fallbackApplyUrl = outbound
        if (!fallbackButtonText && text) fallbackButtonText = text
      }
    }
  }
  return {
    easyApply: false,
    applyUrl: fallbackApplyUrl,
    buttonText: fallbackButtonText
  }
}

let cachedEasyApplyModalRoot = null
let cachedEasyApplyModalAt = 0
const EASY_APPLY_MODAL_CACHE_MS = 2500

function invalidateEasyApplyModalCache() {
  cachedEasyApplyModalRoot = null
  cachedEasyApplyModalAt = 0
}

/** LinkedIn often flips validation a tick after paint; also covers aria-disabled and artdeco disabled styling. */
function easyApplyAdvanceControlLooksDisabled(el) {
  if (!el) return true
  if ('disabled' in el && el.disabled) return true
  if (String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return true
  if (el.classList?.contains('artdeco-button--disabled')) return true
  return false
}

function sduiShadowRoot() {
  const host = document.querySelector('#interop-outlet')
  return host?.shadowRoot || null
}

/** True when dialog text looks like Easy Apply form flow OR the post-submit confirmation (LinkedIn often swaps copy before "apply to" is present). */
function easyApplyModalTextLooksRelevant(rawText) {
  const text = compactText(rawText || '').toLowerCase()
  if (!text) return false
  const inFlow =
    text.includes('apply to') ||
    text.includes('easy apply') ||
    text.includes('submit application') ||
    text.includes('review your application') ||
    text.includes('continue to next step') ||
    text.includes('contact info') ||
    text.includes('application powered by') ||
    text.includes('resume') ||
    text.includes('cover letter') ||
    text.includes('work experience') ||
    text.includes('phone number') ||
    text.includes('years of experience') ||
    text.includes('education') ||
    text.includes('first name') ||
    text.includes('last name')
  const successOrSent =
    text.includes('application sent') ||
    text.includes('your application was sent') ||
    text.includes('application was sent') ||
    text.includes('application has been sent') ||
    text.includes('application submitted') ||
    text.includes('you applied') ||
    text.includes("you've applied") ||
    text.includes('you’ve applied') ||
    text.includes('successfully applied') ||
    text.includes('thanks for applying') ||
    text.includes('thank you for applying') ||
    text.includes('keep track of your application') ||
    text.includes('applied tab') ||
    (text.includes('your application') && text.includes('sent'))
  return inFlow || successOrSent
}

function easyApplyModalRootFind() {
  // Priority 1: ARIA role-based detection (survives LinkedIn class renames)
  const roleDialogs = document.querySelectorAll('[role="dialog"]')
  for (const dialog of roleDialogs) {
    const rect = dialog.getBoundingClientRect()
    if (rect.width < 200 || rect.height < 200) continue
    const text = compactText(dialog.textContent || '').toLowerCase()
    if (!text) continue
    if (easyApplyModalTextLooksRelevant(text)) return dialog
  }

  // Priority 2: LinkedIn's own Easy Apply modal class (supplementary)
  const easyModal = document.querySelector('.jobs-easy-apply-modal')
  if (easyModal) return easyModal

  // Priority 3: artdeco-modal fallback (may rename)
  const artdecoDialogs = document.querySelectorAll('.artdeco-modal')
  for (const dialog of artdecoDialogs) {
    const rect = dialog.getBoundingClientRect()
    if (rect.width < 200 || rect.height < 200) continue
    const text = compactText(dialog.textContent || '').toLowerCase()
    if (!text) continue
    if (easyApplyModalTextLooksRelevant(text)) return dialog
  }

  // Priority 4: Check inside #interop-outlet shadow DOM (LinkedIn SDUI architecture)
  const sr = sduiShadowRoot()
  if (sr) {
    const sduiRoleDialogs = sr.querySelectorAll('[role="dialog"]')
    for (const dialog of sduiRoleDialogs) {
      const rect = dialog.getBoundingClientRect()
      if (rect.width < 200 || rect.height < 200) continue
      const text = compactText(dialog.textContent || '').toLowerCase()
      if (!text) continue
      if (easyApplyModalTextLooksRelevant(text)) return dialog
    }
    const sduiModal = sr.querySelector('.jobs-easy-apply-modal')
    if (sduiModal) return sduiModal
    const sduiDialogs = sr.querySelectorAll('.artdeco-modal')
    for (const dialog of sduiDialogs) {
      const rect = dialog.getBoundingClientRect()
      if (rect.width < 200 || rect.height < 200) continue
      const text = compactText(dialog.textContent || '').toLowerCase()
      if (!text) continue
      if (easyApplyModalTextLooksRelevant(text)) return dialog
    }
    // Priority 3b: SDUI form containers — fb-dash-form-element is the SDUI form primitive
    const sduiForms = sr.querySelectorAll('.fb-dash-form-element')
    if (sduiForms.length > 0) {
      // Walk up from a form element to find the nearest modal-like ancestor
      let candidate = sduiForms[0].closest('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="apply"]')
      if (candidate) return candidate
      // If no modal-like ancestor, find the outermost container with form elements
      candidate = sduiForms[0]
      while (candidate.parentElement && candidate.parentElement !== sr) {
        candidate = candidate.parentElement
      }
      if (candidate) return candidate
    }
    // Priority 3c: any <form> inside the shadow root with relevant text
    const sduiFormTags = sr.querySelectorAll('form')
    for (const form of sduiFormTags) {
      const text = compactText(form.textContent || '').toLowerCase()
      if (easyApplyModalTextLooksRelevant(text)) return form
    }
    // Priority 3d: broad search inside shadow root — relaxed condition (just needs relevant text)
    const allDivs = sr.querySelectorAll('div')
    for (const div of allDivs) {
      const rect = div.getBoundingClientRect()
      if (rect.width < 300 || rect.height < 300) continue
      const text = compactText(div.textContent || '').toLowerCase()
      if (easyApplyModalTextLooksRelevant(text)) {
        return div
      }
    }
    // Priority 3e: SDUI overlay container with actual content (form loaded inside it)
    // Use exact class match only — [class*="application-outlet"] is too broad and can
    // match parent containers that also hold messaging widgets.
    const overlayContainer = sr.querySelector('.application-outlet__overlay-container')
    if (overlayContainer) {
      const oRect = overlayContainer.getBoundingClientRect()
      // Only use this container if it's actually visible (modal is open).
      // When h=0, the Easy Apply modal hasn't rendered yet — the container is just
      // an empty placeholder and its descendant inputs belong to messaging.
      if (oRect.height > 100) {
        const overlayFields = overlayContainer.querySelectorAll('input, select, textarea')
        if (overlayFields.length > 0) return overlayContainer
      }
      // Overlay exists but empty/collapsed — don't return it
    }
    // Priority 3f: SDUI shadow root has form fields but no recognized modal wrapper.
    // LinkedIn SDUI modals may lack standard .artdeco-modal / role=dialog markers and
    // text may not contain "easy apply" / "apply to". Fall back to the largest container
    // inside the shadow root that holds form inputs.
    // IMPORTANT: Exclude messaging overlay inputs (msg-* classes, checkbox-msg-* IDs,
    // search-typeahead inputs) — these are always present and are NOT apply form fields.
    const isMessagingInput = (el) => {
      const cls = el.className || ''
      const id = el.id || ''
      return cls.includes('msg-') || id.includes('msg-') ||
        cls.includes('search-typeahead') || id.includes('search-typeahead') ||
        el.placeholder === 'Search messages'
    }
    const sduiAllInputs = [...sr.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, textarea')]
      .filter((el) => !isMessagingInput(el))
    if (sduiAllInputs.length >= 2) {
      // Find the tightest common ancestor of the form fields
      let ancestor = sduiAllInputs[0].parentElement
      while (ancestor && ancestor !== sr) {
        const childInputs = [...ancestor.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, textarea')]
          .filter((el) => !isMessagingInput(el))
        if (childInputs.length >= sduiAllInputs.length) {
          // This ancestor contains all (or most) form fields — use it
          return ancestor
        }
        ancestor = ancestor.parentElement
      }
      // If no good ancestor, return the shadow root's first child that contains inputs
      for (const child of sr.children) {
        const childInputs = [...child.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, textarea')]
          .filter((el) => !isMessagingInput(el))
        if (childInputs.length >= 2) return child
      }
    }
  }

  // Priority 4: Recursive shadow DOM walk — LinkedIn may nest shadow roots
  // (e.g., #interop-outlet > sr > div.theme--light > sr > .artdeco-modal)
  {
    const visited = new WeakSet()
    function walkShadowRoots(node) {
      if (!node || visited.has(node)) return null
      visited.add(node)
      const stars = node.querySelectorAll ? node.querySelectorAll('*') : []
      for (const el of stars) {
        if (el.shadowRoot && !visited.has(el.shadowRoot)) {
          const sr = el.shadowRoot
          const modal = sr.querySelector('.jobs-easy-apply-modal')
          if (modal) return modal
          const dialogs = sr.querySelectorAll('.artdeco-modal, [role="dialog"]')
          for (const dialog of dialogs) {
            const rect = dialog.getBoundingClientRect()
            if (rect.width < 200 || rect.height < 200) continue
            const text = compactText(dialog.textContent || '').toLowerCase()
            if (easyApplyModalTextLooksRelevant(text)) return dialog
          }
          // SDUI form containers inside nested shadow roots
          const nestedForms = sr.querySelectorAll('.fb-dash-form-element')
          if (nestedForms.length > 0) {
            let candidate = nestedForms[0].closest('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="apply"]')
            if (candidate) return candidate
            candidate = nestedForms[0]
            while (candidate.parentElement && candidate.parentElement !== sr) candidate = candidate.parentElement
            if (candidate) return candidate
          }
          const deeper = walkShadowRoots(sr)
          if (deeper) return deeper
        }
      }
      return null
    }
    const deepResult = walkShadowRoots(document)
    if (deepResult) return deepResult
  }

  // Priority 5: Check inside preload iframe (LinkedIn SPA architecture)
  try {
    const preload = document.querySelector('iframe[src*="preload"]')
    const doc = preload?.contentDocument
    if (doc) {
      const innerModal = doc.querySelector('.jobs-easy-apply-modal')
      if (innerModal) return innerModal
      const innerDialogs = doc.querySelectorAll('.artdeco-modal, [role="dialog"]')
      for (const dialog of innerDialogs) {
        const rect = dialog.getBoundingClientRect()
        if (rect.width < 200 || rect.height < 200) continue
        const text = compactText(dialog.textContent || '').toLowerCase()
        if (easyApplyModalTextLooksRelevant(text)) return dialog
      }
    }
  } catch { /* cross-origin iframe, ignore */ }

  return null
}

function easyApplyModalRoot() {
  const now = Date.now()
  // Shadow DOM elements are not contained by document — use isConnected instead
  const cacheStillAttached = cachedEasyApplyModalRoot && cachedEasyApplyModalRoot.isConnected
  if (
    cacheStillAttached &&
    now - cachedEasyApplyModalAt < EASY_APPLY_MODAL_CACHE_MS
  ) {
    // Don't serve cached root if it has no form fields (SDUI still loading)
    const cachedFields = cachedEasyApplyModalRoot.querySelectorAll('input, select, textarea')
    if (cachedFields.length > 0) {
      return cachedEasyApplyModalRoot
    }
    // Cache is stale (empty container) — re-run finder
  }
  const found = easyApplyModalRootFind()
  if (found) {
    cachedEasyApplyModalRoot = found
    cachedEasyApplyModalAt = now
    return found
  }
  if (cachedEasyApplyModalRoot && cachedEasyApplyModalRoot.isConnected) {
    return cachedEasyApplyModalRoot
  }
  cachedEasyApplyModalRoot = null
  return null
}

function fieldContainer(el) {
  return (
    el.closest('fieldset') ||
    el.closest('[role="group"]') ||
    el.closest('.fb-dash-form-element') ||
    el.closest('.jobs-easy-apply-form-section__grouping') ||
    el.closest('.artdeco-form__group') ||
    el.closest('.jobs-easy-apply-content__question') ||
    el.closest('li') ||
    el.parentElement
  )
}

function inferFieldLabel(el) {
  const id = String(el.getAttribute('id') || '').trim()
  if (id) {
    const direct = document.querySelector(`label[for="${id}"]`)
    if (direct) {
      const text = cleanFieldLabelText(compactText(direct.textContent || ''))
      if (text) return text
    }
  }
  const aria = compactText(el.getAttribute('aria-label') || '')
  if (aria) return aria
  const placeholder = compactText(el.getAttribute('placeholder') || '')
  if (placeholder) return placeholder
  const container = fieldContainer(el)
  if (container) {
    const label = container.querySelector('label, legend, [role="heading"], .fb-dash-form-element__label, .jobs-easy-apply-form-section__group-title')
    if (label) {
      const text = cleanFieldLabelText(compactText(label.textContent || ''))
      if (text) return text
    }
  }
  const name = compactText(el.getAttribute('name') || '')
  if (name) return name
  return ''
}

/** Option text for a radio/checkbox (avoids fieldset-wide `label` matching the wrong node). */
function inferControlOptionLabel(el) {
  const typ = String(el.getAttribute('type') || '').toLowerCase()
  if (typ === 'radio') {
    const al = compactText(el.getAttribute('aria-label') || '')
    if (al && !optionLabelLooksOpaqueUuid(al)) return al
    const sib = el.nextElementSibling
    if (sib) {
      const st = compactText(sib.textContent || '')
      if (st && st.length > 0 && st.length < 120 && !optionLabelLooksOpaqueUuid(st)) return st
    }
    const li = el.closest('li')
    if (li) {
      const clone = li.cloneNode(true)
      clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove())
      const t = compactText(clone.textContent || '')
      if (t && t.length > 0 && t.length < 500 && !optionLabelLooksOpaqueUuid(t)) return t
    }
  }
  const wrap = el.closest('label')
  if (wrap) {
    const clone = wrap.cloneNode(true)
    clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove())
    const t = compactText(clone.textContent || '')
    if (t) return t
  }
  return inferFieldLabel(el)
}

/** When every radio "option" string duplicates the group question (LinkedIn SDUI), fall back to value / index. */
function normalizeRadioGroupOptionStrings(groupLabel, radios, rawOptionStrings) {
  if (!radios.length || !rawOptionStrings.length) return rawOptionStrings
  const gl = compactText(groupLabel).toLowerCase()
  const uniq = new Set(rawOptionStrings.map((s) => compactText(s).toLowerCase()).filter(Boolean))
  const allIdentical = uniq.size <= 1 && rawOptionStrings.length > 1
  const eachEchoesGroup =
    gl.length > 0 &&
    rawOptionStrings.every((s) => {
      const sl = compactText(s).toLowerCase()
      if (!sl) return true
      if (sl === gl) return true
      if (sl.length >= gl.length * 0.85 && gl.length > 12 && sl.startsWith(gl.slice(0, Math.min(48, gl.length)))) return true
      return false
    })
  if (!allIdentical && !eachEchoesGroup) return rawOptionStrings
  return radios.map((r, i) => {
    const v = compactText(String(r.value || '').trim())
    if (v && v.toLowerCase() !== gl) return v
    const ra = compactText(r.getAttribute('aria-label') || '')
    if (ra && ra.toLowerCase() !== gl) return ra
    return `Option ${i + 1}`
  })
}

function fieldType(el) {
  if (!el) return 'text'
  const tag = String(el.tagName || '').toLowerCase()
  if (tag === 'textarea') return 'textarea'
  if (tag === 'select') return 'select'
  if (tag === 'input') {
    const inputType = String(el.getAttribute('type') || 'text').toLowerCase()
    if (inputType === 'hidden') return 'hidden'
    if (inputType === 'email' || inputType === 'tel' || inputType === 'number' || inputType === 'file' || inputType === 'checkbox' || inputType === 'radio') {
      return inputType
    }
    return 'text'
  }
  return 'text'
}

/** LinkedIn sometimes nests ATS markup (preload / same-origin iframe) with file inputs outside the main field scan. */
function allFileInputsUnderRoot(root) {
  const list = [...root.querySelectorAll('input[type="file"]')]
  const seen = new Set(list)
  for (const fr of root.querySelectorAll('iframe')) {
    try {
      const doc = fr.contentDocument
      if (!doc) continue
      for (const el of doc.querySelectorAll('input[type="file"]')) {
        if (!seen.has(el)) {
          seen.add(el)
          list.push(el)
        }
      }
    } catch {
      /* cross-origin — extension may run in ATS frame separately */
    }
  }
  return list
}

function inferRadioGroupQuestion(firstRadio) {
  const fs = firstRadio.closest('fieldset')
  if (fs) {
    const leg = fs.querySelector('legend')
    const t = cleanFieldLabelText(compactText(leg?.textContent || ''))
    if (t.length > 2) return t
  }
  const container = fieldContainer(firstRadio)
  if (container) {
    const title = container.querySelector(
      '.jobs-easy-apply-form-section__group-title, .fb-dash-form-element__label, .artdeco-form__label, legend'
    )
    if (title) {
      const t = cleanFieldLabelText(compactText(title.textContent || ''))
      if (t.length > 2) return t
    }
  }
  return inferFieldLabel(firstRadio)
}

/**
 * Clean up duplicated question text and trailing "Required" from LinkedIn label strings.
 * LinkedIn's legend elements often contain the question text twice (visible + aria/hidden)
 * plus a trailing "Required" span, producing labels like:
 * "Do you have X?Do you have X? Required"
 */
function cleanFieldLabelText(raw) {
  let s = raw
  // Strip trailing "Required" (standalone or stuck to a question mark)
  s = s.replace(/\s*\bRequired\s*$/i, '').trim()
  // Deduplicate: if the string is two identical halves glued together, keep one
  const len = s.length
  if (len >= 6 && len % 2 === 0) {
    const half = len / 2
    if (s.slice(0, half) === s.slice(half)) {
      s = s.slice(0, half)
    }
  }
  // Also handle case where second copy starts after a ? with no space
  const qIdx = s.indexOf('?')
  if (qIdx > 2 && qIdx < len - 3) {
    const before = s.slice(0, qIdx + 1).trim()
    const after = s.slice(qIdx + 1).trim()
    if (before === after || before === after.replace(/\?$/, '').trim()) {
      s = before
    }
  }
  return s.trim()
}

/** Repeater cards (SmartRecruiters, etc.) show `--` until "Edit" opens inline fields. */
function easyApplyRepeaterCardFromEditButton(editBtn) {
  let n = editBtn.parentElement
  for (let depth = 0; depth < 14 && n; depth++, n = n.parentElement) {
    const t = compactText(n.textContent || '')
    if (t.length < 28 || t.length > 14000) continue
    const entryOf = /\bentry\s+\d+\s+of\s+\d+/i.test(t)
    const hasPair = /\bedit\b/i.test(t) && /\bremove\b/i.test(t)
    const eduOrWork =
      /(school|university|college|degree|major|dates attended|field of study)/i.test(t) ||
      /(employer|company|position|job title|employment)/i.test(t)
    if (eduOrWork && (hasPair || entryOf)) return n
  }
  return null
}

function easyApplyCardShowsEmptyPlaceholders(card) {
  const raw = String(card.textContent || '')
  if (/:\s*--\s|:\s*—\s|:\s*–\s/i.test(raw)) return true
  if (/\b--\s*\n|--\s*$/m.test(raw)) return true
  if (/(\u2013|\u2014)\s*(\u2013|\u2014)/.test(raw)) return true
  return false
}

/**
 * Click "Edit" on repeater rows that still show empty placeholders so inputs mount for EXTRACT/FILL.
 */
var expandEasyApplyRepeatableCards = async function() {
  const root = easyApplyModalRoot()
  if (!root) return { ok: false, detail: 'easy_apply_modal_not_found', data: { clicked: 0 } }

  const candidates = [...root.querySelectorAll('button, [role="button"], a')].filter(elementVisible)
  const byCard = new Map()

  for (const el of candidates) {
    const visibleLabel = compactText(el.innerText || '')
    const aria = compactText(el.getAttribute('aria-label') || '')
    const editPair = `${visibleLabel} ${aria}`.toLowerCase()
    if (/\bedit\s+(profile|resume|visibility|settings)\b/.test(editPair)) continue
    const isEdit =
      /^edit$/i.test(visibleLabel) ||
      /^edit$/i.test(aria) ||
      (visibleLabel.length <= 24 && /^\s*edit\s*$/i.test(visibleLabel)) ||
      (visibleLabel.length === 0 && aria.length > 0 && aria.length < 56 && /\bedit\b/i.test(aria))
    if (!isEdit) continue

    const card = easyApplyRepeaterCardFromEditButton(el)
    if (!card || !easyApplyCardShowsEmptyPlaceholders(card)) continue
    if (!byCard.has(card)) byCard.set(card, el)
  }

  let clicked = 0
  for (const el of byCard.values()) {
    try {
      el.scrollIntoView({ block: 'center' })
      await sleep(90)
      el.click()
      clicked++
      await sleep(420)
    } catch {
      /* continue */
    }
  }

  return { ok: true, detail: `expand_repeatable_cards:${clicked}`, data: { clicked } }
}

function fieldElementLooksEmptyForTieBreak(entry) {
  const t = entry.type
  const el = entry.element
  if (!el) return false
  if (t === 'text' || t === 'email' || t === 'tel' || t === 'number' || t === 'textarea') {
    return !String(el.value || '').trim()
  }
  if (t === 'select') {
    const v = String(el.value || '').trim()
    if (!v) return true
    const opt = el.selectedOptions?.[0]
    const tx = compactText(opt?.textContent || '').toLowerCase()
    if (!tx || /^select|^choose|^\.\.\./.test(tx)) return true
    return false
  }
  return false
}

function collectApplicationFields(root) {
  const scope = root || document
  const fields = []
  const seen = new Set()
  const radioHandledNames = new Set()
  const labelOrdinal = new Map()

  const disambiguateLabel = (type, label) => {
    if (!label) return label
    const k = `${type}:${label.toLowerCase()}`
    const n = labelOrdinal.get(k) ?? 0
    labelOrdinal.set(k, n + 1)
    if (n === 0) return label
    return `${label} · #${n + 1}`
  }

  const byRadioName = new Map()
  for (const el of scope.querySelectorAll('input[type="radio"]')) {
    if (el.disabled) continue
    const name = String(el.getAttribute('name') || '').trim()
    if (!name) continue
    if (!byRadioName.has(name)) byRadioName.set(name, [])
    byRadioName.get(name).push(el)
  }
  for (const [grpName, radios] of byRadioName.entries()) {
    if (!radios.length) continue
    const first = radios[0]
    const rawLabel = inferRadioGroupQuestion(first)
    if (!rawLabel) continue
    const grpSeen = `radio:group:${grpName}`
    if (seen.has(grpSeen)) continue
    seen.add(grpSeen)
    radioHandledNames.add(grpName)
    const anyChecked = radios.some((r) => r.checked)
    const value = anyChecked ? 'true' : 'false'
    let options = radios
      .map((r) => compactText(inferControlOptionLabel(r)) || String(r.value || '').trim())
      .filter(Boolean)
      .slice(0, 15)
    options = normalizeRadioGroupOptionStrings(rawLabel, radios, options)
    const required =
      radios.some(
        (r) => r.required || String(r.getAttribute('aria-required') || '').toLowerCase() === 'true'
      ) || /\*\s*$/.test(rawLabel)
    const label = disambiguateLabel('radio', rawLabel)
    fields.push({ element: first, label, type: 'radio', value, required, options })
  }

  let candidates = [...scope.querySelectorAll('input, textarea, select')]
  const seenCand = new Set(candidates)
  for (const fr of scope.querySelectorAll('iframe')) {
    try {
      const doc = fr.contentDocument
      if (!doc) continue
      for (const el of doc.querySelectorAll('input[type="file"]')) {
        if (!seenCand.has(el)) {
          seenCand.add(el)
          candidates.push(el)
        }
      }
    } catch {
      /* cross-origin */
    }
  }
  for (const el of candidates) {
    if (el.disabled) continue
    const type = fieldType(el)
    if (type === 'hidden') continue
    if (type === 'radio') {
      const n = String(el.getAttribute('name') || '').trim()
      if (n && radioHandledNames.has(n)) continue
    }
    const rawFieldLabel = inferFieldLabel(el)
    if (type === 'checkbox') {
      const radioCbKey = `${type}:${String(el.getAttribute('name') || '')}:${rawFieldLabel.toLowerCase()}`
      if (seen.has(radioCbKey)) continue
      seen.add(radioCbKey)
    }
    const required =
      !!el.required ||
      String(el.getAttribute('aria-required') || '').toLowerCase() === 'true' ||
      /\*\s*$/.test(rawFieldLabel)
    const label = disambiguateLabel(type, rawFieldLabel)
    const value =
      type === 'checkbox' || type === 'radio'
        ? (el.checked ? 'true' : 'false')
        : String(el.value || '')
    const key = `${type}:${label.toLowerCase()}`
    if (!label || seen.has(key)) continue
    seen.add(key)
    const options = type === 'select' ? [...el.options].map(o => compactText(o.textContent || '') || o.value).filter(Boolean).slice(0, 15) : undefined
    fields.push({ element: el, label, type, value, required, options })
  }
  return fields
}

/** Documents / roots to search for LinkedIn typeahead listboxes (modal, SDUI shadow, iframe). */
function easyApplyQueryRoots() {
  const roots = []
  const push = (r) => {
    if (r && !roots.includes(r)) roots.push(r)
  }
  push(document)
  const modal = easyApplyModalRoot()
  if (modal) push(modal)
  const sr = sduiShadowRoot()
  if (sr) push(sr)
  try {
    const preload = document.querySelector('iframe[src*="preload"]')
    const doc = preload?.contentDocument
    if (doc) push(doc)
  } catch {
    /* cross-origin */
  }
  return roots
}

function visibleTypeaheadListboxes() {
  const list = []
  for (const root of easyApplyQueryRoots()) {
    let nodes = []
    try {
      nodes = root.querySelectorAll ? [...root.querySelectorAll('[role="listbox"]')] : []
    } catch {
      nodes = []
    }
    for (const lb of nodes) {
      if (!elementVisible(lb)) continue
      const rect = lb.getBoundingClientRect()
      if (rect.width < 20 || rect.height < 8) continue
      list.push(lb)
    }
  }
  return list
}

function typeaheadListboxOptions(lb) {
  let opts = [...lb.querySelectorAll('[role="option"]')].filter(elementVisible)
  if (opts.length) return opts
  const liCandidates = [...lb.querySelectorAll('li')].filter(elementVisible)
  const out = []
  for (const li of liCandidates) {
    const btn = li.querySelector('button, [role="button"]')
    if (btn && elementVisible(btn)) out.push(btn)
    else out.push(li)
  }
  return out.filter(elementVisible).slice(0, 40)
}

function typeaheadOptionMatchScore(optionText, wanted) {
  const o = compactText(optionText).toLowerCase()
  const w = compactText(wanted).toLowerCase()
  if (!o || !w) return 0
  if (o === w) return 100
  if (o.startsWith(w + ',') || o.startsWith(w + ' ·') || o.startsWith(w + '•')) return 95
  if (o.startsWith(w)) return 92
  if (o.includes(w)) return 82
  const head = o.split(/[,·•|]/)[0].trim()
  if (head === w || head.startsWith(w)) return 88
  const wTokens = new Set(w.split(/\s+/).filter((t) => t.length > 1))
  const oTokens = new Set(o.split(/\s+/).filter((t) => t.length > 1))
  if (!wTokens.size) return 0
  let hit = 0
  for (const t of wTokens) if (oTokens.has(t)) hit++
  if (hit / wTokens.size >= 0.51) return 45 + Math.round(25 * (hit / wTokens.size))
  return 0
}

function easyApplyInputIsTypeahead(el, labelRaw) {
  if (!el || String(el.tagName || '').toLowerCase() !== 'input') return false
  const t = String(el.getAttribute('type') || 'text').toLowerCase()
  if (t === 'hidden' || t === 'checkbox' || t === 'radio' || t === 'file' || t === 'button') return false
  const label = compactText(labelRaw).toLowerCase()
  const role = String(el.getAttribute('role') || '').toLowerCase()
  if (role === 'combobox') return true
  const ac = String(el.getAttribute('aria-autocomplete') || '').toLowerCase()
  if (ac === 'list' || ac === 'both') return true
  const popup = String(el.getAttribute('aria-haspopup') || '').toLowerCase()
  if (popup === 'listbox') return true
  if (
    /location|city|based in|where do you live|current city|home city|metro\s+area|geographic/.test(label)
  )
    return true
  return false
}

function setInputValueNoBlur(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }))
}

var collectTypeaheadOptionsAfterTyping = async function(el, text) {
  el.scrollIntoView({ block: 'center' })
  el.focus()
  el.click()
  await sleep(40)
  setInputValueNoBlur(el, '')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(60)

  setInputValueNoBlur(el, text)
  await sleep(380)

  let boxes = visibleTypeaheadListboxes()
  let flat = boxes.flatMap(typeaheadListboxOptions)
  if (flat.length) return flat

  setInputValueNoBlur(el, '')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(50)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = String(el.value || '') + ch
    if (setter) setter.call(el, next)
    else el.value = next
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }))
    await sleep(28 + Math.floor(Math.random() * 28))
  }
  await sleep(420)
  boxes = visibleTypeaheadListboxes()
  flat = boxes.flatMap(typeaheadListboxOptions)
  return flat
}

var fillEasyApplyTypeaheadField = async function(el, value, fieldLabel) {
  const wanted = String(value || '').trim()
  if (!wanted) return { ok: false, detail: 'typeahead_empty_value' }

  const options = await collectTypeaheadOptionsAfterTyping(el, wanted)
  if (!options.length) {
    return { ok: false, detail: `typeahead_no_suggestions:${compactText(fieldLabel).slice(0, 80)}` }
  }

  let best = null
  let bestScore = 0
  for (const opt of options) {
    const labelText = compactText(
      `${opt.textContent || ''} ${opt.getAttribute?.('aria-label') || ''}`
    )
    const s = typeaheadOptionMatchScore(labelText, wanted)
    if (s > bestScore) {
      bestScore = s
      best = opt
    }
  }

  if (best && bestScore >= 35) {
    best.scrollIntoView({ block: 'nearest' })
    best.click()
    el.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(120)
    return { ok: true, detail: `filled_typeahead:${compactText(fieldLabel).slice(0, 80)}` }
  }

  el.focus()
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }))
  await sleep(60)
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
  await sleep(120)
  return { ok: true, detail: `filled_typeahead_key:${compactText(fieldLabel).slice(0, 80)}` }
}

function dialogDocs(primaryDoc) {
  const out = []
  const seen = new Set()
  const add = (doc) => {
    if (!doc || seen.has(doc)) return
    seen.add(doc)
    out.push(doc)
  }
  const maybeAddPreloadDoc = (doc) => {
    if (!doc) return
    try {
      const preload = doc.querySelector('iframe[src*="preload"]')
      if (preload?.contentDocument) add(preload.contentDocument)
    } catch { /* cross-origin */ }
  }
  add(primaryDoc || document)
  maybeAddPreloadDoc(primaryDoc || document)
  if (primaryDoc !== document) {
    add(document)
    maybeAddPreloadDoc(document)
  }
  // Include shadow DOM from LinkedIn SDUI (#interop-outlet)
  const sr = sduiShadowRoot()
  if (sr) add(sr)
  return out
}

function dismissSaveDraftDialogIfPresent(primaryDoc) {
  for (const doc of dialogDocs(primaryDoc || document)) {
    const dialogs = doc.querySelectorAll('[role="dialog"], .artdeco-modal')
    for (const dialog of dialogs) {
      if (!elementVisible(dialog)) continue
      const text = compactText(dialog.textContent || '').toLowerCase()
      if (!text.includes('save this application')) continue
      const buttons = dialog.querySelectorAll('button')
      let discard = null
      let closeBtn = null
      for (const btn of buttons) {
        const bText = compactText(`${readCardText(btn)} ${nodeAria(btn)}`).toLowerCase()
        if (!bText) continue
        if (!closeBtn && (bText.includes('dismiss') || bText.includes('close') || bText === 'x')) {
          closeBtn = btn
        }
        if (bText.includes('discard')) {
          discard = btn
          break
        }
      }
      const target = discard || closeBtn
      if (!target || target.disabled) return false
      target.scrollIntoView({ block: 'center' })
      target.click()
      return true
    }
  }
  return false
}

var dismissSaveDraftDialogWithRetry = async function(primaryDoc, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    if (dismissSaveDraftDialogIfPresent(primaryDoc)) return true
    await sleep(200 + i * 100)
  }
  return false
}

/**
 * Close the Easy Apply modal and dismiss the "save draft" dialog that follows.
 * Used as cleanup when an application fails mid-flow.
 */
var dismissEasyApplyModal = async function() {
  invalidateEasyApplyModalCache()
  const root = easyApplyModalRoot()
  if (!root) return { ok: true, detail: 'no_modal_to_dismiss' }
  if (isEasyApplySuccessScreen(root)) return { ok: true, detail: 'success_screen_no_dismiss_needed' }
  const closeBtns = root.querySelectorAll('button[data-test-modal-close-btn], button[aria-label="Dismiss"], button[aria-label="Close"]')
  let clicked = false
  for (const btn of closeBtns) {
    if (elementVisible(btn) && !btn.disabled) {
      btn.click()
      clicked = true
      break
    }
  }
  if (!clicked) {
    const allBtns = root.querySelectorAll('button')
    for (const btn of allBtns) {
      const text = compactText(`${readCardText(btn)} ${nodeAria(btn)}`).toLowerCase()
      if ((text.includes('dismiss') || text.includes('close') || text === 'x') && elementVisible(btn)) {
        btn.click()
        clicked = true
        break
      }
    }
  }
  if (!clicked) return { ok: true, detail: 'no_close_button_found' }
  await sleep(500)
  await dismissSaveDraftDialogWithRetry(document, 8)
  return { ok: true, detail: 'modal_dismissed' }
}

/**
 * Detect whether the current job page indicates the listing is closed
 * (e.g., "No longer accepting applications"). Checks both regular DOM
 * and SDUI shadow root.
 */
function detectJobClosed() {
  const closedPatterns = [
    /no longer accepting applications/i,
    /this job is no longer available/i,
    /job has been closed/i,
    /position has been filled/i,
    /application deadline has passed/i,
    /unable to load the page[\s\S]{0,100}job id provided may not be valid/i,
    /job id provided may not be valid[\s\S]{0,100}unable to load/i,
    /job posting has been removed/i,
    /this page doesn.?t exist/i
  ]
  // Check regular DOM
  const pageText = document.body ? document.body.innerText : ''
  for (const pat of closedPatterns) {
    if (pat.test(pageText)) return true
  }
  // Check SDUI shadow root
  const sr = sduiShadowRoot()
  if (sr) {
    const srText = sr.textContent || ''
    for (const pat of closedPatterns) {
      if (pat.test(srText)) return true
    }
  }
  return false
}

/**
 * Detect LinkedIn restriction/temporary ban pages.
 * Returns a detail string if detected, or null.
 */
function detectLinkedInRestriction() {
  const restrictionPatterns = [
    /your account has been restricted/i,
    /account is temporarily restricted/i,
    /we've restricted your account/i,
    /unusual activity/i,
    /security verification required/i,
    /you've reached the .* limit/i,
    /too many requests/i,
    /please try again later/i,
    /we.?ve temporarily limited/i
  ]
  const pageText = document.body ? document.body.innerText : ''
  for (const pat of restrictionPatterns) {
    if (pat.test(pageText)) return 'linkedin_account_restricted'
  }
  const sr = sduiShadowRoot()
  if (sr) {
    const srText = sr.textContent || ''
    for (const pat of restrictionPatterns) {
      if (pat.test(srText)) return 'linkedin_account_restricted'
    }
  }
  return null
}

var clickEasyApply = async function() {
  // Early check: detect LinkedIn restriction/ban before attempting anything
  const restriction = detectLinkedInRestriction()
  if (restriction) {
    return { ok: false, detail: restriction }
  }
  // Early check: detect job removed/closed before trying to find button
  if (detectJobClosed()) {
    return { ok: false, detail: 'job_closed_no_longer_accepting' }
  }

  // Targeted selectors only — never fall back to bare 'button' to avoid clicking random UI.
  // IMPORTANT: Search <button> elements FIRST, then <a>.  LinkedIn often renders
  // BOTH a <button> (works with any click) AND an <a> tag with openSDUIApplyFlow
  // (requires CDP trusted click that is fragile). querySelectorAll returns DOM
  // order, not selector order, so we must query buttons and anchors separately
  // to ensure we always prefer the <button> when both exist.
  const buttonSelectors = [
    'button.jobs-apply-button',
    'button[aria-label*="easy apply" i]',
    'button[aria-label*="Easy Apply" i]'
  ]
  const anchorSelectors = [
    'a.jobs-apply-button',
    'a[aria-label*="easy apply" i]',
    'a[aria-label*="Easy Apply" i]'
  ]
  // Search buttons first, then anchors — guarantees <button> priority.
  // Poll for the button — on search-results pages the detail panel loads async.
  let foundEl = null
  for (let locPoll = 0; locPoll < 16; locPoll++) {
    if (locPoll > 0) await sleep(500)
    const candidates = [
      ...document.querySelectorAll(buttonSelectors.join(', ')),
      ...document.querySelectorAll(anchorSelectors.join(', '))
    ]
    let foundAlreadyApplied = false
    for (const el of candidates) {
      if (!elementVisible(el)) continue
      // Skip filter-pill radio buttons ("Easy Apply filter." on search pages)
      if (el.getAttribute('role') === 'radio') continue
      if (el.classList && el.classList.contains('artdeco-pill')) continue
      const text = compactText(`${readCardText(el)} ${nodeAria(el)}`).toLowerCase()
      if (text.includes('applied')) { foundAlreadyApplied = true; continue }
      if (text.includes('easy apply')) {
        foundEl = el
        break
      }
    }
    if (foundEl) break
    if (foundAlreadyApplied) return { ok: false, detail: 'already_applied' }
  }
  if (!foundEl) {
    // Check SDUI shadow root as last resort
    const sr = sduiShadowRoot()
    if (sr) {
      const sduiCandidates = [
        ...sr.querySelectorAll(buttonSelectors.join(', ')),
        ...sr.querySelectorAll(anchorSelectors.join(', '))
      ]
      for (const el of sduiCandidates) {
        if (!elementVisible(el)) continue
        if (el.getAttribute('role') === 'radio') continue
        const text = compactText(`${readCardText(el)} ${nodeAria(el)}`).toLowerCase()
        if (text.includes('easy apply')) { foundEl = el; break }
      }
    }
  }
  if (!foundEl) {
    if (detectJobClosed()) return { ok: false, detail: 'job_closed_no_longer_accepting' }
    return { ok: false, detail: 'easy_apply_button_not_found' }
  }
  {
    const el = foundEl
    if (el.disabled) return { ok: false, detail: 'easy_apply_button_disabled' }
    el.scrollIntoView({ block: 'center' })
    const sduiApplyUrl = (el.tagName === 'A' && el.href && el.href.includes('openSDUIApplyFlow'))
        ? el.href : undefined

      // For SDUI Easy Apply <a> tags: use CDP trusted click via the background script.
      // el.click() doesn't trigger LinkedIn's SPA handler (isTrusted=false).
      // The background script uses chrome.debugger → Input.dispatchMouseEvent (trusted).
      if (sduiApplyUrl) {
        const rect = el.getBoundingClientRect()
        const cx = Math.round(rect.left + rect.width / 2)
        const cy = Math.round(rect.top + rect.height / 2)
        const clickSelector = el.getAttribute('href')
          ? `a[href="${el.getAttribute('href').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
          : 'a[aria-label*="Easy Apply" i]'
        const clickExpectedText = 'easy apply'
        try {
          const cdpResult = await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 8000)
            try {
              chrome.runtime.sendMessage(
                { action: 'CDP_TRUSTED_CLICK', x: cx, y: cy, selector: clickSelector, expectedText: clickExpectedText },
                (resp) => {
                  clearTimeout(timeout)
                  if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message })
                  } else {
                    resolve(resp || { ok: false, error: 'null_response' })
                  }
                }
              )
            } catch (e) {
              clearTimeout(timeout)
              resolve({ ok: false, error: 'sendMessage_threw: ' + (e?.message || e) })
            }
          })
          // CDP result logged at warn level only on failure (below)
          if (!cdpResult.ok) {
            console.warn('[LOA] CDP trusted click failed, trying focus+Enter fallback')
            // Focus + Enter: when <a> has focus and receives Enter, the browser
            // activates the link natively — same handler as a real click
            try {
              el.focus()
              await sleep(150 + Math.random() * 150)
              const enterResult = await new Promise((resolve) => {
                const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000)
                chrome.runtime.sendMessage(
                  { action: 'CDP_TRUSTED_ENTER' },
                  (r) => { clearTimeout(t); resolve(r || { ok: false }) }
                )
              })
              if (!enterResult.ok) {
                console.warn('[LOA] CDP Enter also failed, trying el.click()')
                el.click()
              }
            } catch { el.click() }
          }
        } catch (e) {
          console.warn('[LOA] CDP click error, using el.click() fallback:', e)
          el.click()
        }
        // Poll for the modal to appear (up to 8s)
        // Check BOTH regular DOM and SDUI shadow root — modal may open in either
        for (let wait = 0; wait < 16; wait++) {
          await sleep(500)
          // Check regular DOM first (non-SDUI pages)
          const docModal = document.querySelector('.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"]')
          if (docModal) {
            const rect = docModal.getBoundingClientRect()
            if (rect.width > 200 && rect.height > 200) {
              const mText = compactText(docModal.textContent || '').toLowerCase()
              if (easyApplyModalTextLooksRelevant(mText)) {
                const dismissedDraft = await dismissSaveDraftDialogWithRetry(el.ownerDocument || document)
                return {
                  ok: true,
                  detail: dismissedDraft ? 'clicked_sdui_discarded_draft' : 'clicked_sdui_modal_opened',
                  data: { sduiApplyUrl }
                }
              }
            }
          }
          // Check SDUI shadow root
          const sr = sduiShadowRoot()
          if (sr) {
            const modal = sr.querySelector('.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"]')
            if (modal) {
              const rect = modal.getBoundingClientRect()
              if (rect.width > 200 && rect.height > 200) {
                const dismissedDraft = await dismissSaveDraftDialogWithRetry(el.ownerDocument || document)
                return {
                  ok: true,
                  detail: dismissedDraft ? 'clicked_sdui_discarded_draft' : 'clicked_sdui_modal_opened',
                  data: { sduiApplyUrl }
                }
              }
            }
            // Check for actual Easy Apply form fields — exclude messaging inputs
            // (checkboxes, msg-* classes, search-typeahead) which are always present.
            const allFields = sr.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, textarea')
            let applyFieldCount = 0
            for (const f of allFields) {
              const cls = f.className || ''
              const fid = f.id || ''
              if (cls.includes('msg-') || fid.includes('msg-') ||
                  cls.includes('search-typeahead') || fid.includes('search-typeahead') ||
                  f.placeholder === 'Search messages') continue
              applyFieldCount++
            }
            if (applyFieldCount > 0) {
              return {
                ok: true,
                detail: 'clicked_sdui_form_appeared',
                data: { sduiApplyUrl }
              }
            }
          }
        }
        // Modal didn't appear after 8s — try SPA-style navigation before falling back.
        // window.location.href causes a server-side redirect that strips /apply/.
        // history.pushState triggers LinkedIn's client-side SPA router which may
        // open the SDUI modal without a server round-trip.
        try {
          const spaTarget = new URL(sduiApplyUrl)
          console.log('[LOA] SDUI: trying SPA navigate via history.pushState', spaTarget.pathname)
          window.history.pushState({}, '', spaTarget.pathname + spaTarget.search)
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
          // Wait for modal after SPA navigate
          for (let spaWait = 0; spaWait < 12; spaWait++) {
            await sleep(500)
            const sr = sduiShadowRoot()
            if (sr) {
              const modal = sr.querySelector('.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"]')
              if (modal) {
                const rect = modal.getBoundingClientRect()
                if (rect.width > 200 && rect.height > 200) {
                  const dismissedDraft = await dismissSaveDraftDialogWithRetry(el.ownerDocument || document)
                  return {
                    ok: true,
                    detail: dismissedDraft ? 'sdui_spa_discarded_draft' : 'sdui_spa_modal_opened',
                    data: { sduiApplyUrl }
                  }
                }
              }
              // Check for form fields in SDUI shadow root
              const allFields = sr.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, textarea')
              let applyFieldCount = 0
              for (const f of allFields) {
                const cls = f.className || ''
                const fid = f.id || ''
                if (cls.includes('msg-') || fid.includes('msg-') ||
                    cls.includes('search-typeahead') || fid.includes('search-typeahead') ||
                    f.placeholder === 'Search messages') continue
                applyFieldCount++
              }
              if (applyFieldCount > 0) {
                return {
                  ok: true,
                  detail: 'sdui_spa_form_appeared',
                  data: { sduiApplyUrl }
                }
              }
            }
            // Also check regular DOM
            const docModal = document.querySelector('.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"]')
            if (docModal) {
              const rect = docModal.getBoundingClientRect()
              if (rect.width > 200 && rect.height > 200 && easyApplyModalTextLooksRelevant(compactText(docModal.textContent || '').toLowerCase())) {
                const dismissedDraft = await dismissSaveDraftDialogWithRetry(el.ownerDocument || document)
                return {
                  ok: true,
                  detail: dismissedDraft ? 'sdui_spa_discarded_draft' : 'sdui_spa_modal_opened',
                  data: { sduiApplyUrl }
                }
              }
            }
          }
          console.warn('[LOA] SDUI SPA navigate: modal still not found after 6s')
        } catch (spaErr) {
          console.warn('[LOA] SDUI SPA navigate failed:', spaErr)
        }
        // Final fallback — return URL for main process NAVIGATE
        return {
          ok: true,
          detail: 'sdui_click_no_modal',
          data: { sduiApplyUrl, needsSPANavigate: true }
        }
      }

      // For regular <button> Easy Apply (non-SDUI), use human-like Bezier
      // mouse approach + click with natural press/release timing
      try {
        await simulateNativeClickWithApproach(el)
      } catch {
        el.click()
      }
      // For SDUI links, the .click() may not trigger the modal (SPA intercepts).
      // Wait for modal to appear, then check if we need to force-navigate.
      if (sduiApplyUrl) {
        // Give the SPA 3s to open the modal after click
        for (let wait = 0; wait < 6; wait++) {
          await sleep(500)
          const sr = sduiShadowRoot()
          if (sr) {
            const modal = sr.querySelector('.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"]')
            if (modal) {
              const dismissedDraft = await dismissSaveDraftDialogWithRetry(el.ownerDocument || document)
              return {
                ok: true,
                detail: dismissedDraft ? 'clicked_easy_apply_discarded_draft' : 'clicked_easy_apply',
                data: { sduiApplyUrl }
              }
            }
            // Check if form fields appeared (SDUI without traditional modal classes)
            if (sr.querySelectorAll('input, select, textarea').length > 2) {
              return { ok: true, detail: 'clicked_easy_apply', data: { sduiApplyUrl } }
            }
          }
        }
        // Modal didn't open after 3s — SPA swallowed the click. Return with sduiApplyUrl
        // so the main process can force-navigate via window.location.href
        return {
          ok: true,
          detail: 'clicked_easy_apply_sdui_no_modal',
          data: { sduiApplyUrl, needsForceNavigate: true }
        }
      }
      const dismissedDraft = await dismissSaveDraftDialogWithRetry(el.ownerDocument || document)
      return {
        ok: true,
        detail: dismissedDraft ? 'clicked_easy_apply_discarded_draft' : 'clicked_easy_apply'
      }
    }
}

/**
 * Locate the Easy Apply button and return its center coordinates + metadata
 * WITHOUT clicking. The main process can use CDP Input.dispatchMouseEvent
 * for isTrusted:true clicks that LinkedIn's React handlers actually process.
 */
async function locateEasyApplyButton() {
  // IMPORTANT: Search <button> elements FIRST, then <a>.  LinkedIn often renders
  // BOTH a <button> (works with any click) AND an <a> tag with openSDUIApplyFlow
  // (requires CDP trusted click that is fragile). querySelectorAll returns DOM
  // order, not selector order, so we must query buttons and anchors separately
  // to ensure we always prefer the <button> when both exist.
  const buttonSelectors = [
    'button.jobs-apply-button',
    'button[aria-label*="easy apply" i]',
    'button[aria-label*="Easy Apply" i]'
  ]
  const anchorSelectors = [
    'a.jobs-apply-button',
    'a[aria-label*="easy apply" i]',
    'a[aria-label*="Easy Apply" i]'
  ]
  // Poll for the button — on search-results pages the detail panel loads
  // asynchronously after navigation, so the button may not exist yet.
  var maxLocatePolls = 16 // 16 × 500ms = 8s
  for (var locatePoll = 0; locatePoll < maxLocatePolls; locatePoll++) {
    if (locatePoll > 0) await sleep(500)
    var candidates = [
      ...document.querySelectorAll(buttonSelectors.join(', ')),
      ...document.querySelectorAll(anchorSelectors.join(', '))
    ]
    var foundAlreadyApplied = false
    for (var ci = 0; ci < candidates.length; ci++) {
      var el = candidates[ci]
      if (!elementVisible(el)) continue
      // Skip filter-pill radio buttons ("Easy Apply filter." on search pages)
      if (el.getAttribute('role') === 'radio') continue
      if (el.classList && el.classList.contains('artdeco-pill')) continue
      var text = compactText((readCardText(el) || '') + ' ' + (nodeAria(el) || '')).toLowerCase()
      if (text.includes('applied')) { foundAlreadyApplied = true; continue }
      if (text.includes('easy apply')) {
        if (el.disabled) return { ok: false, detail: 'easy_apply_button_disabled' }
        el.scrollIntoView({ block: 'center' })
        var rect = el.getBoundingClientRect()
        var sduiApplyUrl = (el.tagName === 'A' && el.href && el.href.includes('openSDUIApplyFlow'))
          ? el.href : undefined
        return {
          ok: true,
          detail: 'located',
          data: {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            tag: el.tagName,
            sduiApplyUrl
          }
        }
      }
    }
    // If we found "already applied" and nothing else, don't keep polling
    if (foundAlreadyApplied) return { ok: false, detail: 'already_applied' }
  }
  // Check inside SDUI shadow root
  const sr = sduiShadowRoot()
  if (sr) {
    const sduiCandidates = [
      ...sr.querySelectorAll(buttonSelectors.join(', ')),
      ...sr.querySelectorAll(anchorSelectors.join(', '))
    ]
    for (const el of sduiCandidates) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (el.getAttribute('role') === 'radio') continue
      if (el.classList && el.classList.contains('artdeco-pill')) continue
      const text = compactText(`${readCardText(el)} ${nodeAria(el)}`).toLowerCase()
      if (text.includes('applied')) return { ok: false, detail: 'already_applied' }
      if (text.includes('easy apply')) {
        if (el.disabled) return { ok: false, detail: 'easy_apply_button_disabled' }
        el.scrollIntoView({ block: 'center' })
        const sduiApplyUrl = (el.tagName === 'A' && el.href && el.href.includes('openSDUIApplyFlow'))
          ? el.href : undefined
        return {
          ok: true,
          detail: 'located',
          data: {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            tag: el.tagName,
            sduiApplyUrl,
            inShadowRoot: true
          }
        }
      }
    }
  }
  if (detectJobClosed()) {
    return { ok: false, detail: 'job_closed_no_longer_accepting' }
  }
  return { ok: false, detail: 'easy_apply_button_not_found' }
}

function extractApplicationFields() {
  const root = easyApplyModalRoot()
  if (!root) return { ok: false, detail: 'easy_apply_modal_not_found', data: [] }
  const fields = collectApplicationFields(root).map((entry) => ({
    label: entry.label,
    type: entry.type,
    value: entry.value,
    required: entry.required,
    ...(entry.options ? { options: entry.options } : {})
  }))
  return { ok: true, detail: `fields_${fields.length}`, data: fields }
}

var fillApplicationField = async function(payload) {
  const root = easyApplyModalRoot()
  if (!root) return { ok: false, detail: 'easy_apply_modal_not_found' }
  const needle = String(payload.label || '').trim()
  const value = String(payload.value || '')
  const allowEmpty = !!payload.allowEmpty
  const requestedIndex =
    Number.isInteger(payload.fieldIndex) && Number(payload.fieldIndex) >= 0
      ? Number(payload.fieldIndex)
      : null
  if (!needle) return { ok: false, detail: 'field_label_required' }
  if (!value && !allowEmpty) return { ok: false, detail: 'field_value_required' }

  const fields = collectApplicationFields(root)
  let best = null
  let bestScore = 0
  let bestLockedByIndex = false
  if (requestedIndex != null && requestedIndex < fields.length) {
    const indexed = fields[requestedIndex]
    const indexedScore = scoreLabelMatch(needle, indexed?.label || '')
    if (indexed && indexedScore >= 20) {
      best = indexed
      bestScore = indexedScore
      bestLockedByIndex = true
    }
  }
  for (const entry of fields) {
    if (bestLockedByIndex) break
    const score = scoreLabelMatch(needle, entry.label)
    if (score < 20) continue
    if (score > bestScore) {
      best = entry
      bestScore = score
      continue
    }
    if (score === bestScore && best) {
      const a = fieldElementLooksEmptyForTieBreak(entry)
      const b = fieldElementLooksEmptyForTieBreak(best)
      if (a && !b) best = entry
    }
  }
  if (!best || bestScore < 20) return { ok: false, detail: `field_not_found:${needle}` }

  const entry = best
  const lowerValue = value.trim().toLowerCase()
  if (entry.type === 'select') {
    const opts = [...entry.element.options]
    if (!lowerValue) {
      const placeholder = opts.find((opt) => {
        const text = compactText(opt.textContent || '').toLowerCase()
        const val = String(opt.value || '').trim().toLowerCase()
        return !val || /^select\b|^choose\b|^please\b|^\.\.\.$/.test(text)
      })
      if (!placeholder) return { ok: false, detail: `select_clear_not_supported:${entry.label}` }
      entry.element.value = placeholder.value
      entry.element.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(fieldTypeDelay('select'))
      return { ok: true, detail: `cleared_select:${entry.label}` }
    }
    const exact = opts.find((opt) => compactText(opt.textContent || '').toLowerCase() === lowerValue || String(opt.value || '').trim().toLowerCase() === lowerValue)
    const partial = opts.find((opt) => {
      const text = compactText(opt.textContent || '').toLowerCase()
      const val = String(opt.value || '').trim().toLowerCase()
      return text.includes(lowerValue) || lowerValue.includes(text) || val.includes(lowerValue) || lowerValue.includes(val)
    })
    let selected = exact || partial
    if (!selected && opts.length) {
      const real = opts.filter((opt) => {
        const v = String(opt.value || '').trim()
        const tx = compactText(opt.textContent || '').toLowerCase()
        if (!v) return false
        if (/^select\b|^choose\b|^please\b|^\.\.\.$/.test(tx)) return false
        return true
      })
      const preferred = real.find((opt) =>
        /linkedin|company website|career site|job board|indeed|glassdoor|referr|employee|internet|search|other/i.test(
          compactText(opt.textContent || '')
        )
      )
      selected = preferred || real[0]
    }
    if (!selected) return { ok: false, detail: `select_option_not_found:${entry.label}` }
    entry.element.value = selected.value
    entry.element.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(fieldTypeDelay('select'))
    return { ok: true, detail: `filled_select:${entry.label}` }
  }

  if (entry.type === 'checkbox') {
    const shouldCheck = !!lowerValue && !['false', 'no', '0', 'n'].includes(lowerValue)
    if (!!entry.element.checked !== shouldCheck) entry.element.click()
    await sleep(fieldTypeDelay('checkbox'))
    return { ok: true, detail: `filled_checkbox:${entry.label}` }
  }

  if (entry.type === 'radio') {
    if (!lowerValue) return { ok: false, detail: `radio_clear_not_supported:${entry.label}` }
    const groupName = String(entry.element.getAttribute('name') || '')
    const radios = [...root.querySelectorAll('input[type="radio"]')].filter((node) => String(node.getAttribute('name') || '') === groupName)
    const yn = normalizeEasyApplyYesNoToken(value)
    let target = radios.find((node) => {
      const radioLabel = compactText(inferControlOptionLabel(node)).toLowerCase()
      const radioValue = compactText(node.value || '').toLowerCase()
      return radioLabel === lowerValue || radioValue === lowerValue || radioLabel.includes(lowerValue) || radioValue.includes(lowerValue)
    })
    if (!target && yn && radios.length >= 2) {
      target = radios.find((node) => {
        const lab = compactText(inferControlOptionLabel(node)).toLowerCase()
        if (yn === 'yes') return /\byes\b|^y$|\byeah\b|\btrue\b/i.test(lab)
        if (yn === 'no') return /\bno\b|^n$|\bnone\b|\bneither\b|\bn\/a\b|\bfalse\b/i.test(lab)
        return false
      })
    }
    if (!target && yn && radios.length === 2) {
      target = yn === 'yes' ? radios[0] : radios[1]
    }
    if (!target && yn === 'no' && radios.length === 3) {
      target = radios.find((node) =>
        /\bno\b|\bnone\b|\bneither\b|\bnot applicable\b|\bn\/a\b/i.test(compactText(inferControlOptionLabel(node)).toLowerCase())
      )
      if (!target) target = radios[radios.length - 1]
    }
    if (!target && radios.length) {
      const shouldAffirmative =
        yn !== 'no' && !['false', 'no', '0', 'n'].includes(lowerValue)
      target = shouldAffirmative ? radios[0] : radios[radios.length - 1]
    }
    if (!target) return { ok: false, detail: `radio_option_not_found:${entry.label}` }
    target.click()
    target.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(fieldTypeDelay('radio'))
    return { ok: true, detail: `filled_radio:${entry.label}` }
  }

  const tag = String(entry.element.tagName || '').toLowerCase()
  if (tag === 'input' && easyApplyInputIsTypeahead(entry.element, entry.label)) {
    return await fillEasyApplyTypeaheadField(entry.element, value, entry.label)
  }

  // Use humanized typing for text fields, instant for everything else
  await setValueHumanized(entry.element, value)
  await sleep(fieldTypeDelay(tag === 'textarea' ? 'textarea' : entry.element.type || 'text'))
  return { ok: true, detail: `filled_field:${entry.label}` }
}

function labelScoreForFileTarget(labelRaw, target) {
  const lab = String(labelRaw || '').toLowerCase()
  let score = 0
  if (target === 'cover_letter') {
    if (/\bcover\b|\bcover\s*letter\b|letter\s+of\s+(?:intent|interest)/i.test(lab)) score += 100
    else if (/\bletter\b/.test(lab)) score += 35
  } else if (target === 'resume') {
    if (/\bresume\b|\bcv\b|curriculum|résumé|c\.v\./i.test(lab)) score += 100
    else if (/upload/i.test(lab) && !/cover/i.test(lab)) score += 15
  }
  return score
}

function pickFileInputForTarget(fileInputs, target) {
  const list = [...fileInputs].filter((el) => !el.disabled)
  if (!list.length) return null
  const scored = list.map((el) => {
    const lab = inferFieldLabel(el)
    const hasFile = !!(el.files && el.files.length > 0)
    const base = labelScoreForFileTarget(lab, target)
    const sc = base + (hasFile ? -12 : 10)
    return { el, lab, sc }
  })
  scored.sort((a, b) => b.sc - a.sc)
  const best = scored[0]
  if (best && best.sc >= 28) return best.el
  const empty = list.filter((el) => !el.files || !el.files.length)
  if (target === 'resume' && empty.length) return empty[0] || list[0]
  if (target === 'cover_letter' && empty.length === 1) return empty[0]
  if (target === 'cover_letter' && empty.length > 1) {
    const ranked = empty
      .map((el) => ({ el, sc: labelScoreForFileTarget(inferFieldLabel(el), 'cover_letter') }))
      .sort((a, b) => b.sc - a.sc)
    if (ranked[0] && ranked[0].sc > 0) return ranked[0].el
    return empty[0]
  }
  return null
}

var uploadEasyApplyFile = async function(payload) {
  const fileName = String(payload.fileName || '').trim()
  const mimeType = String(payload.mimeType || 'application/octet-stream').trim()
  const b64 = String(payload.base64 || '').trim()
  let target = String(payload.target || 'resume').toLowerCase().replace(/-/g, '_')
  if (target === 'coverletter') target = 'cover_letter'
  if (!['resume', 'cover_letter', 'auto'].includes(target)) target = 'resume'

  if (!fileName || !b64) {
    return { ok: false, detail: 'upload_payload_incomplete' }
  }

  let bytes
  try {
    const bin = atob(b64.replace(/\s/g, ''))
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch {
    return { ok: false, detail: 'upload_base64_invalid' }
  }

  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' })
  const file = new File([blob], fileName, { type: mimeType || blob.type, lastModified: Date.now() })

  const root = easyApplyModalRoot()
  if (!root) return { ok: false, detail: 'easy_apply_modal_not_found' }
  const fileInputs = allFileInputsUnderRoot(root)
  if (!fileInputs.length) return { ok: false, detail: 'file_input_not_found' }

  let pickTarget = target
  if (target === 'auto') {
    pickTarget = 'resume'
  }
  const inputEl = pickFileInputForTarget(fileInputs, pickTarget)
  if (!inputEl) return { ok: false, detail: `file_input_not_found:${pickTarget}` }

  try {
    const dt = new DataTransfer()
    dt.items.add(file)
    inputEl.files = dt.files
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    inputEl.dispatchEvent(new Event('change', { bubbles: true }))
  } catch (e) {
    return { ok: false, detail: `assignment_failed:${String(e?.message || e)}` }
  }
  return {
    ok: true,
    detail: `assigned_file:${pickTarget}:${compactText(inferFieldLabel(inputEl)).slice(0, 120)}`
  }
}

function uploadResumeFile(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  if (String(p.base64 || '').trim() && String(p.fileName || '').trim()) {
    return uploadEasyApplyFile({ ...p, target: 'resume' })
  }
  const root = easyApplyModalRoot()
  if (!root) return { ok: false, detail: 'easy_apply_modal_not_found' }
  const fileInputs = allFileInputsUnderRoot(root)
  if (!fileInputs.length) return { ok: false, detail: 'resume_input_not_found' }
  for (const input of fileInputs) {
    if (input.files && input.files.length > 0) {
      return { ok: true, detail: 'resume_already_attached' }
    }
  }
  const first = fileInputs[0]
  first.click()
  return { ok: false, detail: 'resume_manual_upload_required' }
}

/** LinkedIn post-submit / confirmation copy (Classic + SDUI). Must stay conservative to avoid mid-flow false positives. */
function isEasyApplySuccessScreen(root) {
  if (!root) return false
  const t = compactText(root.textContent || '').toLowerCase()
  if (!t) return false
  const MARKERS = [
    'your application was sent',
    'application was sent',
    'application sent',
    'application has been sent',
    'you applied',
    "you've applied",
    'you’ve applied',
    'successfully applied',
    'thanks for applying',
    'thank you for applying',
    'we received your application',
    'we have received your application',
    'submitted your application',
    // LinkedIn job card + confirmation: "Application submitted — now" (modal may already be gone)
    'application submitted'
  ]

  // For small roots (modals, SDUI panels <2000 chars), full-text matching is safe.
  // For large roots (document.body), restrict to heading/banner elements AND
  // application-status containers to avoid matching stale copy elsewhere on the page.
  if (t.length < 2000) {
    if (MARKERS.some((m) => t.includes(m))) return true
    if (t.length < 900 && /application\s+(\w+\s+){0,3}sent|sent\s+(\w+\s+){0,3}application/.test(t) && !t.includes('submit application')) return true
  } else {
    const statusSelectors = 'h1, h2, h3, h4, [role="alert"], [role="status"], .artdeco-inline-feedback, ' +
      '[class*="apply-status"], [class*="application-status"], [class*="post-apply"], ' +
      '[class*="feedback"], [class*="submitted"], [class*="confirmation"], ' +
      '[data-test-application-status], section[class*="apply"]'
    const headings = root.querySelectorAll(statusSelectors)
    for (const el of headings) {
      const ht = compactText(el.textContent || '').toLowerCase()
      if (ht && MARKERS.some((m) => ht.includes(m))) return true
    }
  }
  return false
}

/**
 * Standalone check: is the Easy Apply success screen currently visible?
 * Called as a post-loop safety net when the orchestrator is unsure if
 * submission went through.  Checks both the modal root AND the full page body.
 */
function checkSuccessScreen() {
  // 1. Check inside the modal (dialog)
  const root = easyApplyModalRoot()
  if (root && isEasyApplySuccessScreen(root)) {
    return { ok: true, detail: 'success_screen_in_modal', data: 'submit' }
  }
  // 2. Check the full page body (SDUI sometimes replaces the page)
  if (isEasyApplySuccessScreen(document.body)) {
    return { ok: true, detail: 'success_screen_in_body', data: 'submit' }
  }
  // 3. Check inside SDUI shadow root
  const sduiRoot = sduiShadowRoot()
  if (sduiRoot && isEasyApplySuccessScreen(sduiRoot)) {
    return { ok: true, detail: 'success_screen_in_sdui', data: 'submit' }
  }
  // 4. Look for the "Application submitted" status badge on the job page
  const badgeSelectors =
    '.jobs-details-top-card__apply-status, .artdeco-inline-feedback--success, ' +
    '.jobs-unified-top-card__apply-status, [class*="apply-status"], ' +
    '[class*="application-status"], [class*="post-apply"], [class*="applied-status"], ' +
    '[class*="feedback--success"], [data-test-application-status]'
  const badgeRoots = [document]
  if (sduiRoot) badgeRoots.push(sduiRoot)
  for (const badgeRoot of badgeRoots) {
  const statusBadges = badgeRoot.querySelectorAll(badgeSelectors)
  for (const statusBadge of statusBadges) {
    const badgeText = (statusBadge.textContent || '').toLowerCase()
    if (badgeText.includes('not submitted') || badgeText.includes('submit application')) continue
    if (
      badgeText.includes('application submitted') ||
      badgeText.includes('you applied') ||
      badgeText.includes("you've applied") ||
      badgeText.includes('you’ve applied') ||
      badgeText.includes('successfully applied') ||
      badgeText.includes('application was sent') ||
      badgeText.includes('application has been sent') ||
      badgeText.includes('application status') ||
      (badgeText.includes('submitted') && badgeText.includes('application')) ||
      (badgeText.includes('applied') && /\b(now|today|\d+\s*(h|hr|d|min|minute|second|moment))\b/.test(badgeText)) ||
      /\bapplication\b.{0,24}\bsent\b|\bsent\b.{0,24}\bapplication\b/i.test(badgeText)
    ) {
      return { ok: true, detail: `success_badge_on_page${badgeRoot === document ? '' : '_sdui'}`, data: 'submit' }
    }
  }
  }
  return { ok: false, detail: 'no_success_screen_found' }
}

/**
 * Buttons that advance Easy Apply, including inside one level of nested shadow roots
 * (some SDUI / ATS embeds hide the real primary button from a flat querySelectorAll).
 */
function collectEasyApplyAdvanceButtonElements(root) {
  // Include SDUI custom elements: fb-dash-* buttons, hue-web-* buttons, and any clickable with aria-label
  const sel =
    'button, [role="button"], a.artdeco-button--primary, a.artdeco-button--secondary, input[type="submit"], [class*="artdeco-button"], [data-test-modal-close-btn], footer button, [class*="footer"] button, [class*="action"] button'
  const seen = new Set()
  const out = []
  const pushFrom = (r) => {
    if (!r || !r.querySelectorAll) return
    let nodes = []
    try {
      nodes = [...r.querySelectorAll(sel)]
    } catch {
      return
    }
    for (const n of nodes) {
      if (!seen.has(n)) {
        seen.add(n)
        out.push(n)
      }
    }
  }
  const walk = (r) => {
    pushFrom(r)
    let stars
    try {
      stars = r.querySelectorAll ? r.querySelectorAll('*') : []
    } catch {
      return
    }
    for (const el of stars) {
      if (el && el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(root)
  return out
}

var submitApplicationStep = async function() {
  const maxAttempts = 12
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Always re-resolve modal root: LinkedIn swaps form → success UI; a cached
    // form root would miss confirmation copy until the cache TTL expires.
    invalidateEasyApplyModalCache()
    if (attempt > 0) {
      await sleep(Math.min(2200, 280 + attempt * 180))
    }

    const root = easyApplyModalRoot()
    if (!root) {
      const pageSuccess = checkSuccessScreen()
      if (pageSuccess.ok) return pageSuccess
      if (attempt === maxAttempts - 1) return { ok: false, detail: 'easy_apply_modal_not_found' }
      continue
    }
    if (isEasyApplySuccessScreen(root)) {
      return { ok: true, detail: 'application_success_screen', data: 'submit' }
    }

    // Collect button candidates from modal root.
    // On SDUI /apply/ pages (after FORCE_NAVIGATE), the form is inline page content —
    // the submit button may be outside the detected modal root (e.g., in a footer bar).
    // Always search the full SDUI shadow root as well.
    let candidates = collectEasyApplyAdvanceButtonElements(root)
    const sr = sduiShadowRoot()
    if (sr && sr !== root) {
      const srCandidates = collectEasyApplyAdvanceButtonElements(sr)
      const seen = new Set(candidates)
      for (const c of srCandidates) {
        if (!seen.has(c)) candidates.push(c)
      }
    }
    const ranked = []
    for (const btn of candidates) {
      if (!elementVisible(btn)) continue
      // Combine textContent + aria-label + aria-description for matching
      const ariaLabel = (btn.getAttribute('aria-label') || '').trim()
      const text = compactText(`${readCardText(btn)} ${nodeAria(btn)} ${ariaLabel}`).toLowerCase()
      if (!text) continue
      if (text.includes('cancel') || text.includes('discard') || text.includes('close') ||
          text.includes('save as draft') || text.includes('save application') || text === 'save' ||
          (text.includes('save') && !text.includes('save and continue')))
        continue
      if (
        !text.includes('submit') && !text.includes('review') && !text.includes('continue') &&
        !text.includes('proceed') && !text.includes('save and continue') && !text.includes('go to') &&
        !/\bapply\b/.test(text) && !text.includes('send') && !text.includes('done') &&
        !text.includes('finish') && !text.includes('complete') &&
        text !== 'next' && !text.includes(' next')
      ) continue
      let rank = 0
      if (text.includes('submit application')) rank = 300
      else if (text.includes('submit your application')) rank = 295
      else if (text.includes('send application')) rank = 290
      else if (text.includes('submit')) rank = 250
      else if (text.includes('review your application')) rank = 200
      else if (text.includes('review application')) rank = 195
      else if (text.includes('review')) rank = 180
      else if (text.includes('finish applying')) rank = 175
      else if (text.includes('complete application')) rank = 170
      else if (text.includes('done')) rank = 165
      else if (/\bapply\b/.test(text)) rank = 160
      else if (text.includes('continue to next step')) rank = 150
      else if (text.includes('save and continue')) rank = 145
      else if (text.includes('proceed')) rank = 140
      else if (text.includes('send')) rank = 135
      else if (text.includes('go to next')) rank = 130
      else if (text.includes('finish')) rank = 125
      else if (text.includes('complete')) rank = 120
      else if (text === 'next' || text.includes(' next')) rank = 100
      else if (text.includes('continue')) rank = 90
      if (rank > 0) ranked.push({ btn, text, rank })
    }
    ranked.sort((a, b) => b.rank - a.rank)
    const best = ranked[0]
    if (!best) {
      // Log all visible button texts for debugging when no advance button found
      if (attempt === 0 || attempt === maxAttempts - 1) {
        const allBtnTexts = candidates
          .filter(b => elementVisible(b))
          .map(b => {
            const text = compactText(`${readCardText(b)} ${nodeAria(b)}`).toLowerCase()
            const tag = b.tagName
            const cls = (b.className || '').toString().slice(0, 40)
            return `[${tag}.${cls}] ${text}`
          })
          .filter(t => t.length > 3)
        console.warn('[loa-content] submitApplicationStep: no matching advance button.', { candidates: candidates.length, visible: allBtnTexts.length, attempt, root: root?.tagName, url: location.href.slice(0, 80) })
      }
      const pageSuccess = checkSuccessScreen()
      if (pageSuccess.ok) return pageSuccess
      if (attempt === maxAttempts - 1) return { ok: false, detail: 'advance_button_not_found', data: { candidateCount: candidates.length, url: location.href.slice(0, 80) } }
      continue
    }
    if (easyApplyAdvanceControlLooksDisabled(best.btn)) {
      if (attempt === maxAttempts - 1) {
        return { ok: false, detail: `advance_button_disabled:${best.text}` }
      }
      continue
    }

    best.btn.scrollIntoView({ block: 'center' })
    await sleep(120)
    // isSubmitAction: only for buttons that are the FINAL submit — poll 12 rounds
    // for LinkedIn success screen. rank >= 250 covers "submit application" (300),
    // "submit your application" (295), "send application" (290), "submit" (250).
    // "Review your application" (200) is NOT a submit — it's an intermediate step
    // before the actual submit page. Treating it as submit causes 12s of wasted
    // polling and then "unconfirmed" failure.
    const isSubmitAction = best.text.includes('submit') ||
      best.text.includes('send application') || best.rank >= 250
    const isLikelyTerminal = isSubmitAction || best.text.includes('apply') ||
      best.text.includes('review') || best.text.includes('done') ||
      best.text.includes('finish') || best.text.includes('complete')

    // Use human-like Bezier mouse approach + click for advance buttons.
    // CDP trusted click is reserved for the initial Easy Apply <a> link (CLICK_EASY_APPLY)
    // because that's an SPA link needing isTrusted:true. Buttons inside the modal
    // (Next, Review, Submit) are standard <button> elements that accept regular clicks.
    await simulateNativeClickWithApproach(best.btn)
    await sleep(50 + Math.random() * 100)
    try {
      best.btn.click()
    } catch {
      /* ignore */
    }
    if (isSubmitAction) {
      // Wait for LinkedIn to process the submission and show a success screen.
      // Poll up to ~12s (12 checks) before falling back to unconfirmed.
      for (let postCheck = 0; postCheck < 12; postCheck++) {
        await sleep(postCheck === 0 ? 600 : 800)
        invalidateEasyApplyModalCache()
        const postRoot = easyApplyModalRoot()
        if (postRoot && isEasyApplySuccessScreen(postRoot)) {
          return { ok: true, detail: 'submit_confirmed_modal', data: 'submit' }
        }
        const pageCheck = checkSuccessScreen()
        if (pageCheck.ok) {
          return { ok: true, detail: `submit_confirmed_${pageCheck.detail}`, data: 'submit' }
        }
        // Modal disappeared — LinkedIn may have closed it on success
        if (!postRoot && postCheck >= 3) {
          const finalPage = checkSuccessScreen()
          if (finalPage.ok) return { ok: true, detail: `submit_confirmed_modal_gone_${finalPage.detail}`, data: 'submit' }
          // Wait longer before declaring unconfirmed — the page badge may still be rendering
          if (postCheck >= 6) {
            return { ok: false, detail: 'submit_unconfirmed_modal_gone', data: 'submit_unconfirmed' }
          }
        }
      }
      return { ok: false, detail: 'submit_unconfirmed_no_success_screen', data: 'submit_unconfirmed' }
    }
    // Non-submit but potentially terminal actions (review, apply) — poll longer than a simple "next"
    if (isLikelyTerminal) {
      for (let postCheck = 0; postCheck < 6; postCheck++) {
        await sleep(postCheck === 0 ? 500 : 700)
        invalidateEasyApplyModalCache()
        const postRoot = easyApplyModalRoot()
        if (postRoot && isEasyApplySuccessScreen(postRoot)) {
          return { ok: true, detail: 'terminal_action_success_modal', data: 'submit' }
        }
        const pageCheck = checkSuccessScreen()
        if (pageCheck.ok) {
          return { ok: true, detail: `terminal_action_success_${pageCheck.detail}`, data: 'submit' }
        }
        if (!postRoot && postCheck >= 2) {
          const finalPage = checkSuccessScreen()
          if (finalPage.ok) return { ok: true, detail: `terminal_action_modal_gone_${finalPage.detail}`, data: 'submit' }
        }
      }
    } else {
      await sleep(450)
    }
    const rootAfter = easyApplyModalRoot()
    if (rootAfter && isEasyApplySuccessScreen(rootAfter)) {
      return { ok: true, detail: 'application_success_after_advance', data: 'submit' }
    }
    return { ok: true, detail: 'clicked_next_step', data: 'next' }
  }
  return { ok: false, detail: 'advance_button_not_found' }
}

var extractJobListings = async function(payload) {
  // ── URL gate: only proceed on a search-results page (unless allowViewPage) ──
  const curPath = window.location.pathname
  const allowViewPage = !!(payload && payload.allowViewPage)
  if (curPath.includes('/jobs/view/') && !curPath.includes('/jobs/search/') && !allowViewPage) {
    console.warn('[LOA] extractJobListings called on /jobs/view/ — wrong page')
    return {
      ok: false,
      detail: 'wrong_page:jobs_view',
      data: { items: [], actualUrl: window.location.href }
    }
  }

  const requestedScrollPasses = Number(payload?.scrollPasses)
  const scrollPasses = Math.max(0, Math.min(20, Number.isFinite(requestedScrollPasses) ? requestedScrollPasses : 8))
  const root = document.querySelector('.jobs-search-results-list') ||
    document.querySelector('.scaffold-layout__list') ||
    document.querySelector('main') || document.body
  for (let i = 0; i < scrollPasses; i++) {
    root.scrollTo(0, root.scrollHeight)
    try {
      window.scrollTo(0, document.documentElement?.scrollHeight || document.body?.scrollHeight || 0)
    } catch {
      /* ignore */
    }
    await sleep(400 + Math.random() * 300)
  }

  const items = []
  const seen = new Set()
  const cards = document.querySelectorAll('.job-card-container, .jobs-search-results__list-item, li[data-occludable-job-id]')
  let missingTitleCount = 0
  for (const card of cards) {
    const titleEl = card.querySelector('.job-card-list__title, .job-card-container__link, a[data-control-name="job_card"]') ||
      card.querySelector('a[href*="/jobs/view/"]')
    if (!titleEl) {
      missingTitleCount++
      continue
    }
    const title = (readCardText(titleEl).split('\n')[0]?.trim() || '').replace(/\s+with verification$/i, '').trim()
    if (!title || title.length < 3) {
      missingTitleCount++
      continue
    }

    let jobUrl = ''
    const anchor = titleEl.closest('a') || titleEl.querySelector('a') || (titleEl.tagName === 'A' ? titleEl : null)
    if (anchor?.href) {
      jobUrl = normalizeJobUrl(anchor.href)
    }

    const companyEl = card.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle')
    const company = companyEl ? readCardText(companyEl).split('\n')[0]?.trim() || '' : ''

    const locationEl = card.querySelector('.job-card-container__metadata-wrapper li, .artdeco-entity-lockup__caption')
    const location = locationEl ? readCardText(locationEl).split('\n')[0]?.trim() || '' : ''

    const timeEl = card.querySelector('time')
    const postedDate = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent?.trim() || '') : ''
    const easyApply = inferEasyApplyFromCard(card)

    const key = jobUrl || `${title}|${company}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      title,
      company,
      location,
      postedDate,
      jobUrl,
      easyApply,
      applyUrl: jobUrl
    })
  }
  if (cards.length === 0) {
    return {
      ok: false,
      detail: 'job_listings_selectors_miss:no_cards',
      data: { items: [] }
    }
  }
  if (items.length === 0) {
    return {
      ok: false,
      detail: `job_listings_selectors_miss:no_items(cards:${cards.length},missing_title:${missingTitleCount})`,
      data: { items: [] }
    }
  }

  // In-page enrichment: click each card and read the right-panel description
  function currentDetailPanelJobUrl() {
    const roots = [document]
    const sr = sduiShadowRoot()
    if (sr) roots.push(sr)
    const selectors = [
      '.job-details-jobs-unified-top-card__job-title a[href*="/jobs/view/"]',
      '.jobs-unified-top-card__job-title a[href*="/jobs/view/"]',
      'a[data-control-name="jobdetails_topcard_title"][href*="/jobs/view/"]'
    ]
    for (const root of roots) {
      for (const selector of selectors) {
        const el = root.querySelector(selector)
        const href = String(el?.href || el?.getAttribute?.('href') || '').trim()
        if (href) return normalizeJobUrl(href)
      }
    }
    return ''
  }

  async function waitForDetailPanelSync(expectedJobUrl, timeoutMs = 1500) {
    const expected = normalizeJobUrl(expectedJobUrl || '')
    if (!expected) return null
    const deadline = Date.now() + timeoutMs
    let sawExplicitOtherJob = false
    while (Date.now() <= deadline) {
      const current = currentDetailPanelJobUrl()
      if (current) {
        if (current === expected) return true
        sawExplicitOtherJob = true
      }
      await sleep(70)
    }
    return sawExplicitOtherJob ? false : null
  }

  const enrichTop = Number(payload?.enrichTop) || 0
  if (enrichTop > 0 && items.length > 0) {
    const toEnrich = items.slice(0, Math.min(enrichTop, items.length))
    const allCards = Array.from(cards)
    let enrichCompleted = 0
    try {
      chrome.runtime.sendMessage({ type: 'ENRICH_PROGRESS', completed: 0, total: toEnrich.length })
    } catch { /* best-effort */ }
    for (const item of toEnrich) {
      let applyMeta = null
      let panelSync = null
      try {
        // Find the card element whose link matches this item's jobUrl
        const matchCard = allCards.find(c => {
          const a = c.querySelector('a[href*="/jobs/view/"]')
          return a && normalizeJobUrl(a.href) === item.jobUrl
        })
        if (!matchCard) continue
        // Click the card container — NOT the inner <a> tag.
        // Clicking an anchor directly can cause the browser to navigate
        // to /jobs/view/XXXX instead of just updating the right panel.
        // LinkedIn's event delegation on the <li>/<div> card handles
        // the panel update without triggering anchor navigation.
        const clickTarget = matchCard.querySelector('.job-card-list__title--link span') ||
          matchCard.querySelector('.job-card-container__link span') ||
          matchCard  // fallback: click the card container itself
        // Prevent anchor default if the resolved target is inside an <a>
        const parentAnchor = clickTarget.closest('a')
        if (parentAnchor) {
          const clickEvt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
          parentAnchor.addEventListener('click', function _block(e) { e.preventDefault(); parentAnchor.removeEventListener('click', _block) }, { once: true, capture: true })
          clickTarget.dispatchEvent(clickEvt)
        } else {
          clickTarget.click()
        }
        // Wait for right panel to render
        await sleep(180 + Math.random() * 120)
        // If clicking navigated to /jobs/view/, harvest the description from THIS
        // page before going back — otherwise the click was wasted time.
        if (window.location.pathname.includes('/jobs/view/')) {
          try {
            const descEl = document.querySelector('.jobs-description__content, .jobs-box__html-content, #job-details')
            const description = descEl ? descEl.innerText.trim().slice(0, 3000) : ''
            if (description && description.length > 50) {
              item.description = description
              try { applyMeta = inferApplyCta(document) } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
          window.history.back()
          await sleep(600)
          // Already have description; skip panel sync wait for this card.
          enrichCompleted++
          try {
            chrome.runtime.sendMessage({ type: 'ENRICH_PROGRESS', completed: enrichCompleted, total: toEnrich.length })
          } catch { /* best-effort */ }
          continue
        }
        panelSync = await waitForDetailPanelSync(item.jobUrl, 1500)
        if (panelSync === false) {
          console.warn('[LOA] enrichment panel did not sync to clicked card; skipping panel-derived metadata')
        } else {
          // Extract details from the right panel (same selectors as extractJobDetails)
          const descEl = document.querySelector('.jobs-description__content, .jobs-box__html-content, #job-details')
          const description = descEl ? descEl.innerText.trim().slice(0, 3000) : ''
          if (description && description.length > 50) {
            item.description = description
            const criteriaEls = document.querySelectorAll('.job-details-jobs-unified-top-card__job-insight, .jobs-unified-top-card__job-insight')
            const criteria = []
            for (const el of criteriaEls) {
              const text = el.textContent.trim()
              if (text) criteria.push(text)
            }
            if (criteria.length) item.description += '\n\n' + criteria.join(' \u2022 ')
          }
          // Also pick up easyApply from detail panel
          applyMeta = inferApplyCta(document)
        }
      } catch {
        /* skip this card's enrichment */
      }
      if (!applyMeta && panelSync !== false) {
        try {
          applyMeta = inferApplyCta(document)
        } catch {
          applyMeta = null
        }
      }
      if (applyMeta) {
        // Keep card inference as a hint, but trust explicit CTA evidence from the
        // detail panel when available (especially outbound apply URLs).
        if (applyMeta.easyApply === true) {
          item.easyApply = true
        } else if (applyMeta.applyUrl && !isLinkedInUrlCandidate(applyMeta.applyUrl)) {
          item.easyApply = false
        }
        if (applyMeta.applyUrl) item.applyUrl = applyMeta.applyUrl
      }
      enrichCompleted++
      try {
        chrome.runtime.sendMessage({ type: 'ENRICH_PROGRESS', completed: enrichCompleted, total: toEnrich.length })
      } catch { /* best-effort */ }
    }
  }

  return { ok: true, detail: `jobs_${items.length}`, data: { items } }
}

function extractHiringTeam() {
  const members = []
  const seen = new Set()

  // Search both regular DOM and SDUI shadow root (same pattern as extractJobDetails)
  const sr = sduiShadowRoot()
  const roots = sr ? [document, sr] : [document]

  function q(selector) {
    for (const root of roots) {
      const el = root.querySelector(selector)
      if (el) return el
    }
    return null
  }
  function qa(selector) {
    const all = []
    for (const root of roots) {
      all.push(...root.querySelectorAll(selector))
    }
    return all
  }

  function cleanPersonName(raw) {
    if (!raw) return ''
    // Take first line only, strip connection indicators like "• 3rd", "• 2nd", "• 1st"
    const firstLine = raw.split('\n')[0].trim()
    return firstLine.replace(/\s*[·•]\s*(1st|2nd|3rd|3rd\+).*$/i, '').trim()
  }

  function addMember(name, title, rawUrl) {
    const cleanName = cleanPersonName(name)
    if (cleanName.length < 2) return
    const profileUrl = rawUrl.startsWith('/') ? 'https://www.linkedin.com' + rawUrl.split('?')[0] : rawUrl.split('?')[0]
    if (seen.has(profileUrl)) return
    seen.add(profileUrl)
    members.push({ name: cleanName, title: (title || '').trim(), profileUrl })
  }

  // Strategy 1: class-based selectors (original + expanded)
  const hiringTeamSection = q(
    '.hiring-team-card, .jobs-poster__header, [data-test-id="hiring-team"], .hirer-card__hirer-information, ' +
    '[class*="hiring-team"], [class*="hirer-card"], [class*="jobs-poster"]'
  )
  if (hiringTeamSection) {
    const links = hiringTeamSection.querySelectorAll('a[href*="/in/"]')
    for (const link of links) {
      const href = link.getAttribute('href') || ''
      if (!href.includes('/in/')) continue
      const lockup = link.closest('.artdeco-entity-lockup, [class*="hirer-card"], [class*="hiring-team"]')
      const subtitle = lockup?.querySelector('.artdeco-entity-lockup__subtitle, [class*="subtitle"], .text-body-small')
      addMember(link.textContent, subtitle?.textContent, href)
    }
  }

  // Strategy 2: poster/top-card links
  if (members.length === 0) {
    const posterLinks = qa(
      '.jobs-poster__name a, ' +
      '.job-details-jobs-unified-top-card__hiring-team a[href*="/in/"], ' +
      '.jobs-unified-top-card__hiring-team a[href*="/in/"]'
    )
    for (const link of posterLinks) {
      const href = link.getAttribute('href') || ''
      if (!href.includes('/in/')) continue
      const subtitle = link.closest('.artdeco-entity-lockup')?.querySelector('.artdeco-entity-lockup__subtitle')
      addMember(link.textContent, subtitle?.textContent, href)
    }
  }

  // Strategy 3: text-based fallback — find sections headed "Meet the hiring team" or "People you can reach out to"
  if (members.length === 0) {
    const headings = qa('h2, h3, h4, [class*="header"], [class*="title"], span, strong')
    for (const heading of headings) {
      const text = heading.textContent.trim().toLowerCase()
      if (!text.includes('hiring team') && !text.includes('people you can reach') && !text.includes('posted by')) continue
      const section = heading.closest('section, div[class*="card"], div[class*="module"], div[class*="container"], article') || heading.parentElement?.parentElement
      if (!section) continue
      const links = section.querySelectorAll('a[href*="/in/"]')
      for (const link of links) {
        const href = link.getAttribute('href') || ''
        if (!href.includes('/in/')) continue
        const parent = link.closest('.artdeco-entity-lockup, li, div[class*="card"], div[class*="member"], div[class*="person"]') || link.parentElement
        const subtitleEl = parent?.querySelector('[class*="subtitle"], .text-body-small, [class*="title"]:not(a)')
        const subtitleText = subtitleEl && !subtitleEl.contains(link) ? subtitleEl.textContent : ''
        addMember(link.textContent, subtitleText, href)
      }
      if (members.length > 0) break
    }
  }

  // Strategy 4: any profile link in the job details right rail / sidebar
  if (members.length === 0) {
    const rightRail = q('.jobs-search__right-rail, .scaffold-layout__detail-back-button ~ *, .job-details-module, aside')
    if (rightRail) {
      const links = rightRail.querySelectorAll('a[href*="/in/"]')
      for (const link of links) {
        const href = link.getAttribute('href') || ''
        if (!href.includes('/in/')) continue
        const parent = link.closest('.artdeco-entity-lockup, li, div') || link.parentElement
        const subtitle = parent?.querySelector('[class*="subtitle"], .text-body-small')
        addMember(link.textContent, subtitle?.textContent, href)
      }
    }
  }

  return members.slice(0, 5)
}

function buildHiringTeamSearchHint(company, title) {
  if (!company) return ''
  const roleKeywords = title ? title.replace(/\b(?:senior|junior|sr|jr|lead|staff|principal|intern)\b/gi, '').trim() : ''
  const dept = roleKeywords.split(/\s+/).slice(0, 2).join(' ')
  return `"${company}" ${dept ? dept + ' ' : ''}hiring manager OR recruiter`
}

function extractJobDetails() {
  // Search in both regular DOM and SDUI shadow root
  const sr = sduiShadowRoot()
  const roots = sr ? [document, sr] : [document]

  function q(selector) {
    for (const root of roots) {
      const el = root.querySelector(selector)
      if (el) return el
    }
    return null
  }
  function qa(selector) {
    const all = []
    for (const root of roots) {
      all.push(...root.querySelectorAll(selector))
    }
    return all
  }

  // Title: specific selectors → h1 in detail area → h1 in any root
  let titleEl = q('.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title')
  if (!titleEl) {
    // Broader fallback: find h1/h2 that looks like a job title
    const skipPattern = /^(linkedin|jobs|home|sign in|are these|messaging|notifications|my network|people also)/i
    const skipContent = /helpful|results|feedback|survey|you may also|similar jobs/i
    const searchContainers = [
      sr,
      q('.jobs-search__job-details'),
      q('.scaffold-layout__detail'),
      q('.job-view-layout'),
      q('main')
    ].filter(Boolean)
    for (const container of searchContainers) {
      const headings = container.querySelectorAll('h1, h2, h3')
      for (const h of headings) {
        const txt = h.textContent.trim()
        if (txt.length < 4) continue
        if (skipPattern.test(txt) || skipContent.test(txt)) continue
        titleEl = h
        break
      }
      if (titleEl) break
    }
  }
  // SDUI fallback: extract title from the currently selected job card in the listing
  if (!titleEl) {
    const selectedCard = document.querySelector('.jobs-search-results-list__list-item--active, .job-card-list--is-current-job-card, [class*="job-card"][class*="active"], .scaffold-layout__list-item--selected')
    if (selectedCard) {
      const cardTitle = selectedCard.querySelector('.job-card-list__title, a[href*="/jobs/view/"]')
      if (cardTitle) titleEl = cardTitle
    }
  }
  // Clean up title: take first non-empty line (job cards have duplicated text)
  const rawTitle = titleEl ? titleEl.textContent.trim() : ''
  const title = rawTitle.split('\n').map(l => l.trim()).filter(l => l.length > 2)[0] || rawTitle

  // Company: specific selectors → a[href*="/company/"] → selected job card
  let companyEl = q('.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a')
  if (!companyEl) companyEl = q('a[href*="/company/"]')
  if (!companyEl) {
    // Fallback: company name from selected job card in the listing
    const selectedCard = document.querySelector('.jobs-search-results-list__list-item--active, .job-card-list--is-current-job-card, [class*="job-card"][class*="active"], .scaffold-layout__list-item--selected')
    if (selectedCard) {
      companyEl = selectedCard.querySelector('.artdeco-entity-lockup__subtitle, .job-card-container__company-name, [class*="company"]')
    }
  }
  const company = companyEl ? companyEl.textContent.trim() : ''

  // Location
  let locationEl = q('.job-details-jobs-unified-top-card__primary-description-container .tvm__text, .jobs-unified-top-card__bullet')
  if (!locationEl) {
    const spans = qa('span.tvm__text, span.t-black--light, span[class*="location"]')
    for (const s of spans) {
      if (/,\s*[A-Z]{2}|remote|hybrid|on.?site/i.test(s.textContent)) {
        locationEl = s
        break
      }
    }
  }
  const location = locationEl ? locationEl.textContent.trim() : ''

  let descEl = q('.jobs-description__content, .jobs-box__html-content, #job-details')
  if (!descEl) {
    // SDUI: look for large text blocks in shadow root
    for (const root of roots) {
      const divs = root.querySelectorAll('div, section, article')
      for (const d of divs) {
        const txt = d.innerText || ''
        if (txt.length > 200 && /qualif|responsib|require|experience/i.test(txt)) {
          descEl = d
          break
        }
      }
      if (descEl) break
    }
  }
  const description = descEl ? descEl.innerText.trim().slice(0, 3000) : ''

  const criteriaEls = document.querySelectorAll('.job-details-jobs-unified-top-card__job-insight, .jobs-unified-top-card__job-insight')
  const criteria = []
  for (const el of criteriaEls) {
    const text = el.textContent.trim()
    if (text) criteria.push(text)
  }

  const applyMeta = inferApplyCta(document)
  const easyApply = !!applyMeta.easyApply
  const applyUrl = applyMeta.applyUrl || (easyApply ? normalizeJobUrl(window.location.href) : '')

  const hiringTeam = extractHiringTeam()
  const hiringTeamSearchHint = buildHiringTeamSearchHint(company, title)

  const titleOk = title.length >= 2
  const companyOk = company.length >= 2
  if (!titleOk && !companyOk) {
    return {
      ok: false,
      detail: 'job_selectors_miss:title_company_empty',
      data: { title, company, location, description, criteria, easyApply, applyUrl, hiringTeam, hiringTeamSearchHint }
    }
  }

  return {
    ok: true,
    detail: 'job_extracted',
    data: { title, company, location, description, criteria, easyApply, applyUrl, hiringTeam, hiringTeamSearchHint }
  }
}

function diagnoseEasyApply() {
  const info = {}
  // Check #interop-outlet
  const outlet = document.querySelector('#interop-outlet')
  info.hasInteropOutlet = !!outlet
  info.interopOutletShadowRoot = outlet ? (outlet.shadowRoot ? 'open' : 'null (likely closed)') : 'n/a'
  // Check for any dialogs
  info.artdecoModals = document.querySelectorAll('.artdeco-modal').length
  info.roleDialogs = document.querySelectorAll('[role="dialog"]').length
  info.easyApplyModals = document.querySelectorAll('.jobs-easy-apply-modal').length
  // Check shadow roots
  const allShadowRoots = []
  document.querySelectorAll('*').forEach(el => {
    if (el.shadowRoot) allShadowRoots.push({ tag: el.tagName, id: el.id, class: (el.className || '').toString().slice(0, 60) })
  })
  info.openShadowRoots = allShadowRoots.slice(0, 10)
  info.totalOpenShadowRoots = allShadowRoots.length

  // ── Deep dump of #interop-outlet shadow root contents ──
  if (outlet && outlet.shadowRoot) {
    const sr = outlet.shadowRoot
    // Direct children
    const children = [...sr.children].map(el => ({
      tag: el.tagName,
      id: el.id || '',
      class: (el.className || '').toString().slice(0, 80),
      role: el.getAttribute?.('role') || '',
      childCount: el.children?.length || 0,
      textSnippet: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    }))
    info.sduiChildren = children.slice(0, 20)
    // All elements with classes containing form/modal/dialog/apply keywords
    const interesting = sr.querySelectorAll('[class*="form"], [class*="modal"], [class*="dialog"], [class*="apply"], [class*="fb-dash"], [role="dialog"], form, [class*="overlay"]')
    info.sduiInteresting = [...interesting].slice(0, 30).map(el => ({
      tag: el.tagName,
      class: (el.className || '').toString().slice(0, 100),
      role: el.getAttribute?.('role') || '',
      rect: (() => { try { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } } catch { return null } })()
    }))
    // All inputs/selects/textareas inside shadow root
    const formFields = sr.querySelectorAll('input, select, textarea, [contenteditable="true"]')
    info.sduiFormFields = [...formFields].slice(0, 30).map(el => ({
      tag: el.tagName,
      type: el.type || '',
      name: el.name || '',
      id: el.id || '',
      placeholder: el.placeholder || '',
      ariaLabel: el.getAttribute?.('aria-label') || '',
      class: (el.className || '').toString().slice(0, 60)
    }))
    info.sduiFormFieldCount = formFields.length
    // Nested shadow roots inside #interop-outlet's shadow root
    const nestedSRs = []
    sr.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) nestedSRs.push({
        tag: el.tagName,
        id: el.id || '',
        class: (el.className || '').toString().slice(0, 80),
        childCount: el.shadowRoot.children?.length || 0,
        srTextSnippet: (el.shadowRoot.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      })
    })
    info.sduiNestedShadowRoots = nestedSRs.slice(0, 10)
    // Total element count inside shadow root
    info.sduiTotalElements = sr.querySelectorAll('*').length
    // Style sheets
    info.sduiStyleSheets = sr.querySelectorAll('style, link[rel="stylesheet"]').length
  }

  // Check if div.theme--light has shadow
  const themeLights = document.querySelectorAll('div.theme--light')
  info.themeLightCount = themeLights.length
  info.themeLightWithShadow = [...themeLights].filter(el => el.shadowRoot).length
  // Check iframes
  info.iframeCount = document.querySelectorAll('iframe').length
  const preloadIframe = document.querySelector('iframe[src*="preload"]')
  info.hasPreloadIframe = !!preloadIframe
  // Modal root attempt
  const root = easyApplyModalRootFind()
  info.modalRootFound = !!root
  if (root) {
    info.modalRootTag = root.tagName + (root.className ? '.' + root.className.toString().split(' ')[0] : '')
    info.modalRootRect = (() => { try { const r = root.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } } catch { return null } })()
    info.modalRootFormFields = root.querySelectorAll('input, select, textarea').length
  }
  // Page URL
  info.url = window.location.href
  return { ok: true, detail: 'diagnostic', data: info }
}

var ATS_CONTAINER_SELECTORS = {
  'greenhouse.io': ['form#application-form', 'form[action*="greenhouse.io"]'],
  'lever.co': ['[data-qa="application-form"]', 'form'],
  'myworkdayjobs.com': ['[data-automation-id="applicationBody"]', 'form'],
  'myworkdaysite.com': ['[data-automation-id="applicationBody"]', 'form'],
  'ashbyhq.com': ['form'],
  'smartrecruiters.com': ['[data-test="application-form"]', 'form'],
  'icims.com': ['form#icims-form', 'form'],
  'workable.com': ['form'],
  'indeed.com': ['form'],
  'taleo.net': ['form'],
  'brassring.com': ['form'],
  'successfactors.com': ['form'],
  'adp.com': ['form']
}

function findATSFormRoot() {
  var host = String(window.location.hostname || '').toLowerCase()
  var selectors = null
  for (var domain in ATS_CONTAINER_SELECTORS) {
    if (host.includes(domain)) {
      selectors = ATS_CONTAINER_SELECTORS[domain]
      break
    }
  }
  if (selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i])
      if (el) return el
    }
  }
  var forms = document.querySelectorAll('form')
  return forms.length === 1 ? forms[0] : document.body
}

function extractExternalFormFields() {
  var root = findATSFormRoot()
  var fields = collectApplicationFields(root).map(function(entry) {
    return {
      label: entry.label,
      type: entry.type,
      value: entry.value,
      required: entry.required,
      ...(entry.options ? { options: entry.options } : {})
    }
  })
  return { ok: true, detail: 'external_fields_' + fields.length, data: { fields: fields, url: window.location.href, title: document.title } }
}

var fillExternalFormField = async function(payload) {
  var root = findATSFormRoot()
  var needle = String(payload.label || '').trim()
  var value = String(payload.value || '')
  var allowEmpty = !!payload.allowEmpty
  var requestedIndex =
    Number.isInteger(payload.fieldIndex) && Number(payload.fieldIndex) >= 0
      ? Number(payload.fieldIndex)
      : null
  if (!needle) return { ok: false, detail: 'field_label_required' }
  if (!value && !allowEmpty) return { ok: false, detail: 'field_value_required' }

  var fields = collectApplicationFields(root)
  var candidates = fields.filter(function(f) { return scoreLabelMatch(f.label, needle) > 0 })
  if (candidates.length === 0) return { ok: false, detail: 'field_not_found', data: { label: needle } }

  var target = requestedIndex != null && requestedIndex < candidates.length
    ? candidates[requestedIndex]
    : candidates.reduce(function(best, c) {
        var s = scoreLabelMatch(c.label, needle)
        return s > (best._score || 0) ? Object.assign(c, { _score: s }) : best
      }, Object.assign(candidates[0], { _score: scoreLabelMatch(candidates[0].label, needle) }))

  var el = target.element
  if (!el) return { ok: false, detail: 'element_not_found' }

  if (el.tagName === 'SELECT') {
    var opts = Array.from(el.options)
    var best = opts.find(function(o) { return o.value.toLowerCase() === value.toLowerCase() || o.textContent.trim().toLowerCase() === value.toLowerCase() })
    if (best) {
      el.value = best.value
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, detail: 'filled_select' }
    }
    return { ok: false, detail: 'select_option_not_found' }
  }

  if (el.type === 'checkbox') {
    var shouldCheck = /^(yes|true|1|on|checked)$/i.test(value)
    if (el.checked !== shouldCheck) el.click()
    return { ok: true, detail: 'filled_checkbox' }
  }

  if (el.type === 'radio') {
    el.click()
    return { ok: true, detail: 'filled_radio' }
  }

  await setValueHumanized(el, value)
  return { ok: true, detail: 'filled_text' }
}

function normalizeFormLabel(label) {
  return String(label || '').trim().toLowerCase().replace(/[*:?]/g, '').replace(/\s+/g, ' ').trim()
}

function saveFormAnswers() {
  var root = findATSFormRoot()
  var fields = collectApplicationFields(root)
  var entries = {}
  var count = 0
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i]
    var val = String(f.value || '').trim()
    if (!val || !f.label) continue
    var key = normalizeFormLabel(f.label)
    if (!key) continue
    entries[key] = { label: f.label, value: val, type: f.type || 'text', lastUsed: Date.now() }
    count++
  }
  if (count === 0) return Promise.resolve({ ok: true, detail: 'no_fields_to_save', data: { saved: 0 } })
  return new Promise(function(resolve) {
    chrome.storage.local.get('formMemory', function(result) {
      var memory = result.formMemory || {}
      for (var k in entries) memory[k] = entries[k]
      chrome.storage.local.set({ formMemory: memory }, function() {
        resolve({ ok: true, detail: 'saved_' + count, data: { saved: count } })
      })
    })
  })
}

var autoFillFromMemory = async function() {
  var root = findATSFormRoot()
  var fields = collectApplicationFields(root)

  return new Promise(function(resolve) {
    chrome.storage.local.get('formMemory', function(result) {
      var memory = result.formMemory || {}
      if (Object.keys(memory).length === 0) {
        resolve({ ok: true, detail: 'no_memory', data: { filled: 0, total: fields.length } })
        return
      }

      var filled = 0
      var pending = []

      for (var i = 0; i < fields.length; i++) {
        var f = fields[i]
        if (f.value && String(f.value).trim()) continue
        var key = normalizeFormLabel(f.label)
        if (!key || !memory[key]) continue
        var el = f.element
        if (!el) continue
        var savedValue = memory[key].value

        if (el.tagName === 'SELECT') {
          var opts = Array.from(el.options)
          var bestOpt = opts.find(function(o) {
            return o.value.toLowerCase() === savedValue.toLowerCase() ||
                   o.textContent.trim().toLowerCase() === savedValue.toLowerCase()
          })
          if (bestOpt) {
            el.value = bestOpt.value
            el.dispatchEvent(new Event('change', { bubbles: true }))
            filled++
          }
        } else if (el.type === 'checkbox') {
          var shouldCheck = /^(yes|true|1|on|checked)$/i.test(savedValue)
          if (el.checked !== shouldCheck) el.click()
          filled++
        } else if (el.type === 'radio') {
          el.click()
          filled++
        } else {
          pending.push({ el: el, value: savedValue })
        }
      }

      ;(async function() {
        for (var j = 0; j < pending.length; j++) {
          await setValueHumanized(pending[j].el, pending[j].value)
          filled++
        }
        resolve({ ok: true, detail: 'memory_filled_' + filled, data: { filled: filled, total: fields.length } })
      })()
    })
  })
}

}
