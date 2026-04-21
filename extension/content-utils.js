var CONTENT_VERSION = 29

var _lrDormant = false
;(() => {
  const _lrOwnerAttr = 'data-linkinreachly-bridge'
  const _lrMyId = chrome.runtime.id
  const _lrExistingOwner = document.documentElement.getAttribute(_lrOwnerAttr)
  if (_lrExistingOwner && _lrExistingOwner !== _lrMyId) {
    console.warn('[LinkinReachly] Another instance (' + _lrExistingOwner + ') already owns this page — this content script is dormant.')
    chrome.runtime.onMessage.addListener(function(_msg, _sender, sendResponse) {
      sendResponse({ ok: false, detail: 'dormant_duplicate_extension' })
      return false
    })
    _lrDormant = true
    return
  }
  document.documentElement.setAttribute(_lrOwnerAttr, _lrMyId)
})()

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Returns a human-like delay (ms) based on field type.
 * Slower for text areas (simulate typing), faster for toggles.
 */
function fieldTypeDelay(type) {
  switch (type) {
    case 'checkbox':
    case 'radio':
      return 300 + Math.floor(Math.random() * 500)
    case 'select':
    case 'select-one':
      return 500 + Math.floor(Math.random() * 800)
    case 'text':
    case 'tel':
    case 'email':
    case 'url':
    case 'number':
      return 1000 + Math.floor(Math.random() * 2000)
    case 'textarea':
      return 3000 + Math.floor(Math.random() * 5000)
    default:
      return 500 + Math.floor(Math.random() * 1000)
  }
}

function nodeText(el) {
  return String(el?.textContent || '')
    .trim()
    .toLowerCase()
}

function nodeAria(el) {
  return String(el?.getAttribute?.('aria-label') || '')
    .trim()
    .toLowerCase()
}

function compactText(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function dedupeRepeatedText(value) {
  const text = compactText(value)
  if (text.length < 6) return text
  for (let size = Math.floor(text.length / 2); size >= 3; size--) {
    if (text.length % size !== 0) continue
    const chunk = text.slice(0, size)
    if (chunk.repeat(text.length / size) === text) {
      return chunk.trim()
    }
  }
  return text
}

var LEVER_OPTION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function optionLabelLooksOpaqueUuid(s) {
  return LEVER_OPTION_UUID_RE.test(compactText(String(s || '')))
}

function normalizeEasyApplyYesNoToken(raw) {
  const s = compactText(String(raw || '')).toLowerCase()
  if (['yes', 'y', 'true', '1', 'yeah', 'yep'].includes(s)) return 'yes'
  if (['no', 'n', 'false', '0', 'nope', 'na', 'n/a'].includes(s)) return 'no'
  return null
}

function readCardText(el) {
  if (!el) return ''

  const candidates = []
  const titleAttr = compactText(el.getAttribute?.('title') || '')
  const ariaLabel = compactText(el.getAttribute?.('aria-label') || '')
  if (titleAttr) candidates.push(titleAttr)
  if (ariaLabel) candidates.push(ariaLabel)

  const directText = [...(el.childNodes || [])]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => compactText(node.textContent || ''))
    .filter(Boolean)
  candidates.push(...directText)

  const ariaHiddenText = [...el.querySelectorAll?.('[aria-hidden="true"]') || []]
    .map((node) => compactText(node.textContent || ''))
    .filter(Boolean)
  candidates.push(...ariaHiddenText)

  candidates.push(compactText(el.innerText || ''))
  candidates.push(compactText(el.textContent || ''))

  for (const candidate of candidates) {
    const text = dedupeRepeatedText(candidate)
    if (text) return text
  }
  return ''
}

function visibleLinesFrom(el, limit = 40) {
  if (!el) return []
  const raw = String(el.innerText || el.textContent || '')
  return raw
    .split('\n')
    .map((line) => compactText(line))
    .filter(Boolean)
    .slice(0, limit)
}

function findSectionLines(title) {
  const needle = String(title || '').trim().toLowerCase()
  if (!needle) return []
  for (const section of document.querySelectorAll('section')) {
    const lines = visibleLinesFrom(section, 40)
    const idx = lines.findIndex((line) => line.toLowerCase() === needle)
    if (idx >= 0) {
      return lines.slice(idx + 1).filter((line) => line.toLowerCase() !== needle)
    }
  }
  return []
}

function looksLikeLocationLine(line) {
  const value = compactText(String(line || '').split(' · ')[0] || '')
  if (!value) return false
  if (value.length > 80 || value.includes('|')) return false
  return (
    /(?:,| metropolitan area\b| united states\b| remote\b| hybrid\b| new york\b| san francisco\b| london\b| berlin\b)/i.test(value) &&
    !/^(contact info|open to|500\+|followers|connections)$/i.test(value)
  )
}

function cleanLocationLine(line) {
  return compactText(String(line || '').split(' · ')[0] || '')
}

function inferCompanyFromHeadline(headline) {
  const text = compactText(headline)
  if (!text) return ''
  const atMatch = text.match(/\bat\s+([A-Z][^|,]+)/)
  if (atMatch?.[1]) return compactText(atMatch[1])
  const commaParts = text.split(',').map((part) => compactText(part)).filter(Boolean)
  if (commaParts.length >= 2 && commaParts[1] && !/\bengineer|manager|founder|research|product|developer|designer\b/i.test(commaParts[1])) {
    return commaParts[1]
  }
  return ''
}

function isLinkedInHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase()
  return h === 'linkedin.com' || h.endsWith('.linkedin.com')
}

function isLinkedInUrlCandidate(value) {
  try {
    const url = new URL(String(value || ''), window.location.origin)
    return isLinkedInHostname(url.hostname)
  } catch {
    return false
  }
}

function normalizeJobUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.origin)
    return `${url.origin}${url.pathname}`
  } catch {
    return String(value || '').trim()
  }
}

function decodeNestedUrl(value, maxDepth = 3) {
  let out = String(value || '').trim()
  for (let i = 0; i < maxDepth; i++) {
    try {
      const decoded = decodeURIComponent(out)
      if (!decoded || decoded === out) break
      out = decoded.trim()
    } catch {
      break
    }
  }
  return out
}

function extractOutboundUrl(rawHref) {
  const href = String(rawHref || '').trim()
  if (!href) return ''
  let parsed
  try {
    parsed = new URL(href, window.location.origin)
  } catch {
    return ''
  }
  const keys = ['url', 'redirect', 'redirecturl', 'redirectUrl', 'dest', 'desturl', 'destination', 'target', 'targeturl']
  for (const key of keys) {
    const val = parsed.searchParams.get(key)
    if (!val) continue
    const decoded = decodeNestedUrl(val)
    if (/^https?:\/\//i.test(decoded)) return decoded
  }
  return parsed.href
}

function elementVisible(el) {
  if (!el) return false
  const style = window.getComputedStyle(el)
  if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function scoreLabelMatch(needle, hay) {
  const n = compactText(needle).toLowerCase()
  const h = compactText(hay).toLowerCase()
  if (!n || !h) return 0
  if (n === h) return 100
  if (h.includes(n) || n.includes(h)) return 75
  const nParts = n.split(' ').filter(Boolean)
  const hParts = h.split(' ').filter(Boolean)
  if (!nParts.length || !hParts.length) return 0
  let overlap = 0
  for (const part of nParts) {
    if (hParts.includes(part)) overlap++
  }
  return Math.round((overlap / nParts.length) * 60)
}

/**
 * Set a form field value instantly (used for short values, selects, numeric fields).
 * For longer text fields, prefer typeHumanLike() which simulates keystroke timing.
 */
function setNativeValue(el, value) {
  const tag = String(el.tagName || '').toLowerCase()
  if (tag === 'textarea') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
  } else if (tag === 'input') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
  } else {
    el.value = value
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new Event('blur', { bubbles: true }))
}

// ────────────────────────────────────────────────────────────────────────────
// Common bigrams — these key pairs are typed faster due to muscle memory.
// Research: PMC "Typing Expertise in Large Student Population" (2022)
// ────────────────────────────────────────────────────────────────────────────
var FAST_BIGRAMS = new Set([
  'th', 'he', 'in', 'er', 'an', 'on', 'en', 'at', 'es', 'ed',
  'or', 'te', 'ti', 'is', 'it', 'al', 'ar', 'st', 'to', 'nt',
  'ng', 'se', 'ha', 'ou', 'io', 'le', 're', 'hi', 'ea', 'ri',
  'ro', 'co', 'ne', 'li', 'ra', 'ce', 'de', 'nd', 'ma', 'si'
])

/**
 * Log-normal sample — human inter-keystroke intervals follow a log-normal
 * distribution (long tail of slow outliers).
 * Source: arXiv 2510.02374v1 "Hybrid CAPTCHA with Keystroke Dynamics"
 */
function logNormalKeystrokeDelay(mu, sigma) {
  var u1 = Math.random()
  var u2 = Math.random()
  var z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2)
  return Math.exp(mu + sigma * z)
}

/**
 * Human-like typing with keystroke autocorrelation (rhythm momentum).
 *
 * Key research-backed features:
 * 1. Log-normal inter-keystroke interval distribution (not uniform)
 * 2. Autocorrelation: fast sequences stay fast, slow stays slow (momentum)
 * 3. Common bigram acceleration ("th", "er", "in" typed faster)
 * 4. Sentence/word boundary pauses
 * 5. Occasional micro-corrections (~2%)
 * 6. Composition speed: ~19 WPM for original text, ~40 WPM for familiar info
 *
 * Sources: PMC 9356123, arXiv 2510.02374v1, FCaptcha keystroke cadence
 */
async function typeHumanLike(el, value) {
  var tag = String(el.tagName || '').toLowerCase()
  var proto = tag === 'textarea'
    ? window.HTMLTextAreaElement.prototype
    : tag === 'input'
      ? window.HTMLInputElement.prototype
      : null
  var setter = proto
    ? Object.getOwnPropertyDescriptor(proto, 'value')?.set
    : null

  function setValue(v) {
    if (setter) setter.call(el, v)
    else el.value = v
  }

  // Focus the element like a human clicking into it
  if (typeof el.focus === 'function') el.focus()
  el.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
  await sleep(150 + Math.random() * 300)

  // Clear existing value
  setValue('')
  el.dispatchEvent(new Event('input', { bubbles: true }))

  var text = String(value || '')
  if (!text) return

  // Typing speed parameters — scale with text length
  var isShortValue = text.length <= 8
  // Log-normal params: mu controls median, sigma controls spread
  // Short/familiar values: faster (~60 WPM median)
  // Longer composition: slower (~25 WPM median)
  var mu = isShortValue ? 4.6 : 5.1       // ~100ms median short, ~165ms median long
  var sigma = isShortValue ? 0.25 : 0.35   // tighter short, wider long

  // Autocorrelation state — "rhythm momentum"
  // The previous delay biases the next one (humans type in rhythmic bursts)
  var prevDelay = logNormalKeystrokeDelay(mu, sigma)
  var momentumWeight = 0.3  // 30% carry from previous interval

  var nextPauseAt = function() { return 4 + Math.floor(Math.random() * 12) }
  var pauseCountdown = nextPauseAt()

  for (var i = 0; i < text.length; i++) {
    var ch = text[i]

    // Occasional micro-correction (~2% chance, not on first few chars)
    if (i > 3 && !isShortValue && Math.random() < 0.02) {
      var wrongChar = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1))
      setValue(text.slice(0, i) + wrongChar)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(80 + Math.random() * 150)
      // "Notice" the mistake — longer pause
      await sleep(300 + Math.random() * 500)
      // Backspace
      setValue(text.slice(0, i))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(60 + Math.random() * 100)
    }

    // Type the correct character
    setValue(text.slice(0, i + 1))
    el.dispatchEvent(new Event('input', { bubbles: true }))

    pauseCountdown--

    // Base delay from log-normal distribution
    var rawDelay = logNormalKeystrokeDelay(mu, sigma)

    // Apply autocorrelation (momentum) — blend with previous delay
    var delay = rawDelay * (1 - momentumWeight) + prevDelay * momentumWeight

    // Bigram acceleration — common pairs typed 20-35% faster
    if (i > 0) {
      var bigram = (text[i - 1] + ch).toLowerCase()
      if (FAST_BIGRAMS.has(bigram)) {
        delay *= (0.65 + Math.random() * 0.15)
      }
    }

    // Context-dependent adjustments
    if (ch === ' ' || ch === '.' || ch === ',' || ch === '\n' || ch === ';' || ch === ':') {
      // Word/sentence boundary — slower
      delay *= (1.2 + Math.random() * 0.5)
    } else if (i > 0 && text[i - 1] === ' ') {
      // Starting new word — brief hesitation
      delay *= (1.1 + Math.random() * 0.3)
    }

    // After period or newline — sentence thinking pause
    if (i > 0 && (text[i - 1] === '.' || text[i - 1] === '\n') && ch !== ' ') {
      delay += 300 + Math.random() * 800
    }

    // Periodic thinking pause (every 5-15 chars at word boundaries)
    if (pauseCountdown <= 0 && (ch === ' ' || ch === '.' || ch === ',')) {
      delay += 500 + Math.random() * 1500
      pauseCountdown = nextPauseAt()
    }

    // Clamp — never faster than 50ms (superhuman) or slower than 800ms
    // (unless thinking pause). Research: <150ms reaction = bot flag.
    delay = Math.max(50, Math.min(delay, 800))

    prevDelay = delay
    await sleep(delay)
  }

  // Final events after typing completes
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new Event('blur', { bubbles: true }))
}

/**
 * Smart value setter: uses humanized typing for text/textarea with longer values,
 * instant set for short values and non-text fields.
 */
async function setValueHumanized(el, value) {
  const tag = String(el.tagName || '').toLowerCase()
  const text = String(value || '')

  // Only humanize text inputs and textareas with meaningful content
  const isTextField = tag === 'input' || tag === 'textarea'
  // Short values (numbers, single words, codes) get instant fill — a human wouldn't
  // hunt-and-peck a 3-digit number
  const isLongEnough = text.length > 10

  if (isTextField && isLongEnough) {
    await typeHumanLike(el, text)
  } else {
    setNativeValue(el, value)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bezier mouse movement helpers
// Research: humans move cursors in arcs (not straight lines) with
// 3-12% overshoot on long moves, then correct. Fitts's Law acceleration.
// Sources: ResearchGate 393981520, GitHub sarperavci/human_mouse
// ────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate a cubic Bezier curve at parameter t.
 */
function bezierPoint(t, p0, p1, p2, p3) {
  var u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/**
 * Generate a human-like mouse path from (x0,y0) to (x1,y1) using cubic Bezier
 * with randomized control points that create a natural arc.
 * Returns array of {x, y} intermediate points.
 */
function humanMousePath(x0, y0, x1, y1, numSteps) {
  var dx = x1 - x0
  var dy = y1 - y0
  var dist = Math.sqrt(dx * dx + dy * dy)
  // Control point offset scales with distance — longer moves have bigger arcs
  var arcMagnitude = dist * (0.1 + Math.random() * 0.25)
  // Perpendicular direction for the arc
  var perpX = -dy / (dist || 1)
  var perpY = dx / (dist || 1)
  // Randomize arc direction (left or right of straight line)
  var arcSign = Math.random() > 0.5 ? 1 : -1

  // Two control points for cubic Bezier
  var cp1x = x0 + dx * 0.25 + perpX * arcMagnitude * arcSign * (0.5 + Math.random() * 0.5)
  var cp1y = y0 + dy * 0.25 + perpY * arcMagnitude * arcSign * (0.5 + Math.random() * 0.5)
  var cp2x = x0 + dx * 0.75 + perpX * arcMagnitude * arcSign * (0.3 + Math.random() * 0.4)
  var cp2y = y0 + dy * 0.75 + perpY * arcMagnitude * arcSign * (0.3 + Math.random() * 0.4)

  var points = []
  for (var i = 0; i <= numSteps; i++) {
    var t = i / numSteps
    // Ease in/out — Fitts's Law: accelerate then decelerate
    var eased = t < 0.5
      ? 2 * t * t
      : 1 - Math.pow(-2 * t + 2, 2) / 2
    points.push({
      x: bezierPoint(eased, x0, cp1x, cp2x, x1),
      y: bezierPoint(eased, y0, cp1y, cp2y, y1)
    })
  }

  // Overshoot on longer moves (3-12% of distance, ~70% probability)
  if (dist > 50 && Math.random() < 0.7) {
    var overshootPct = 0.03 + Math.random() * 0.09
    var osx = x1 + dx * overshootPct
    var osy = y1 + dy * overshootPct
    points.push({ x: osx, y: osy })
    // Corrective sub-movement back to target
    points.push({
      x: x1 + (Math.random() - 0.5) * 2,
      y: y1 + (Math.random() - 0.5) * 2
    })
  }

  // Add micro-jitter to all points
  for (var j = 1; j < points.length - 1; j++) {
    points[j].x += (Math.random() - 0.5) * 1.5
    points[j].y += (Math.random() - 0.5) * 1.5
  }

  return points
}

/**
 * Dispatch mousemove events along a Bezier path to an element, then click.
 * Fires the full event chain: approach → hover → press → release → click.
 */
async function simulateHumanMouseApproach(el, targetX, targetY) {
  // Start from a random nearby position (as if cursor was somewhere on the page)
  var startX = targetX + (Math.random() - 0.5) * 400
  var startY = targetY + (Math.random() - 0.5) * 300
  var dist = Math.sqrt(Math.pow(targetX - startX, 2) + Math.pow(targetY - startY, 2))

  // More steps for longer distances
  var steps = Math.max(5, Math.min(20, Math.round(dist / 30)))
  var path = humanMousePath(startX, startY, targetX, targetY, steps)

  for (var k = 0; k < path.length; k++) {
    var pt = path[k]
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: pt.x, clientY: pt.y, view: window
    }))
    // Variable speed: faster in middle, slower at start/end (Fitts's Law)
    var progress = k / path.length
    var moveDelay = progress < 0.2 || progress > 0.8
      ? 15 + Math.random() * 25  // slower at edges
      : 5 + Math.random() * 15   // faster in middle
    await sleep(moveDelay)
  }
}

function simulateNativeClick(el) {
  try {
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center' })
    }
    var rect = el.getBoundingClientRect()
    // Slight position jitter — humans don't click dead center
    var jitterX = (Math.random() - 0.5) * rect.width * 0.3
    var jitterY = (Math.random() - 0.5) * rect.height * 0.3
    var x = rect.left + rect.width / 2 + jitterX
    var y = rect.top + rect.height / 2 + jitterY
    var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }
    // Mouse approach + hover before click
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: x, clientY: y }))
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }))
    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    el.dispatchEvent(new PointerEvent('pointerup', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.dispatchEvent(new MouseEvent('click', opts))
    if (typeof el.focus === 'function') el.focus()
    return true
  } catch {
    return false
  }
}

/**
 * Async version of simulateNativeClick that includes Bezier mouse approach.
 * Used when we have time for the full human-like movement sequence.
 */
async function simulateNativeClickWithApproach(el) {
  try {
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center' })
    }
    await sleep(100 + Math.random() * 200)
    var rect = el.getBoundingClientRect()
    var jitterX = (Math.random() - 0.5) * rect.width * 0.3
    var jitterY = (Math.random() - 0.5) * rect.height * 0.3
    var x = rect.left + rect.width / 2 + jitterX
    var y = rect.top + rect.height / 2 + jitterY

    // Bezier approach movement
    await simulateHumanMouseApproach(el, x, y)

    // Brief hover dwell (100-400ms)
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: x, clientY: y }))
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }))
    await sleep(100 + Math.random() * 300)

    // Click sequence with human-like press duration
    var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }
    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    await sleep(50 + Math.random() * 80)  // Human press-to-release: 50-130ms
    el.dispatchEvent(new PointerEvent('pointerup', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.dispatchEvent(new MouseEvent('click', opts))
    if (typeof el.focus === 'function') el.focus()
    return true
  } catch {
    return false
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Idle browsing simulation — research-backed scroll and hover patterns
// Sources: NN/g "Scrolling and Attention", PMC 10084322, PMC 7701271
// ────────────────────────────────────────────────────────────────────────────

/**
 * Simulate idle browsing with realistic scroll velocity variance,
 * zigzag re-reading, hover fixations, and natural pauses.
 *
 * Scroll behavior tiers (NN/g):
 * - Engaged reading: low velocity, high dwell
 * - Scanning: moderate velocity
 * - Skipping: high velocity
 *
 * @param {number} durationMs - how long to browse (5000-30000ms)
 */
async function simulateIdleBrowsing(durationMs) {
  var endTime = Date.now() + durationMs
  var scrollDirection = 1  // 1 = down, -1 = up
  var consecutiveScrolls = 0
  var totalScrolled = 0

  while (Date.now() < endTime) {
    var roll = Math.random()

    if (roll < 0.35) {
      // Engaged scroll down — slow, reading
      var scrollAmount = 80 + Math.random() * 200
      window.scrollBy({ top: scrollAmount * scrollDirection, behavior: 'smooth' })
      totalScrolled += scrollAmount
      consecutiveScrolls++

      // After scrolling 3-6 times in one direction, occasionally reverse (zigzag)
      if (consecutiveScrolls > 3 + Math.random() * 3) {
        scrollDirection *= -1
        consecutiveScrolls = 0
      }
    } else if (roll < 0.50) {
      // Fast scan scroll — skipping content
      var fastAmount = 300 + Math.random() * 500
      window.scrollBy({ top: fastAmount, behavior: 'smooth' })
      totalScrolled += fastAmount
    } else if (roll < 0.70) {
      // Scroll back up to re-read (~20-30% of scroll actions per research)
      var backAmount = -(100 + Math.random() * 250)
      window.scrollBy({ top: backAmount, behavior: 'smooth' })
    } else if (roll < 0.88) {
      // Hover over a visible element with Bezier approach
      var interactables = document.querySelectorAll(
        '.job-card-container, .jobs-search-results__list-item, [data-job-id], ' +
        '.artdeco-card, .job-card-list__entity-lockup, a[href*="/jobs/view/"]'
      )
      if (interactables.length > 0) {
        var target = interactables[Math.floor(Math.random() * interactables.length)]
        var tRect = target.getBoundingClientRect()
        if (tRect.height > 0 && tRect.top > 0 && tRect.top < window.innerHeight) {
          // Mouse approach with Bezier path
          var hx = tRect.left + tRect.width * (0.3 + Math.random() * 0.4)
          var hy = tRect.top + tRect.height * (0.3 + Math.random() * 0.4)
          await simulateHumanMouseApproach(target, hx, hy)
          target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: hx, clientY: hy }))
          target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: hx, clientY: hy }))

          // Fixation dwell — 250ms to 2s (PMC attentive cursor research)
          await sleep(250 + Math.random() * 1750)

          target.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, clientX: hx, clientY: hy }))
          target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, clientX: hx, clientY: hy }))
        }
      }
    } else {
      // Reading pause (fixation >4s = "long pause" in cursor research)
      // Random mouse micro-movements during pause
      var pauseEnd = Date.now() + 2000 + Math.random() * 3000
      while (Date.now() < pauseEnd && Date.now() < endTime) {
        // Micro-jitter — cursor drifts slightly while user reads
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          clientX: window.innerWidth * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 8,
          clientY: window.innerHeight * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 8
        }))
        await sleep(300 + Math.random() * 700)
      }
      continue
    }

    // Variable inter-action delay (not uniform — key human signal)
    var actionDelay = 800 + Math.random() * 2500
    // Occasionally a longer think pause
    if (Math.random() < 0.15) {
      actionDelay += 2000 + Math.random() * 3000
    }
    await sleep(actionDelay)
  }
}
