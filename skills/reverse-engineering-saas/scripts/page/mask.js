// mask.js: blurs personal data before a screenshot of a production screen.
// Paste the whole file into the browser's JavaScript tool. It masks at once.
//   window.__re.mask.apply({ selectors: ['.customer-name'], names: ['Maria Silva'], avatars: true, placeholders: true })
//   window.__re.mask.watch({ names: ['Maria Silva'] })  also mask later changes
//   window.__re.mask.stop()   stop watching, keep existing masks
//   window.__re.mask.clear()  stop watching and remove masks
// Selectors and placeholders: true become CSS rules that also blur elements
// rendered later (popovers, dropdowns, re-rendered lists) until clear().
// Patterns, names and avatars mark the elements on the page now: run apply()
// again right before each screenshot, or opt into watch(). Watching covers this
// document's DOM mutations and input/change events, not frames, shadow roots or
// programmatic field.value changes without an event. Review each screenshot.
// Playwright browser_evaluate: wrap as () => { <file>; return window.__re.last; }
(() => {
  const re = (window.__re = window.__re || {});
  const CLASS = '__re-masked';
  const PLACEHOLDER_CLASS = '__re-masked-placeholder';
  const STYLE_ID = '__re-mask-style';
  const BLUR = 'filter:blur(6px)!important';
  // ::placeholder takes no filter, so the text becomes a blurred shadow about as strong as BLUR.
  const BLUR_TEXT = 'color:transparent!important;text-shadow:0 0 16px rgba(0,0,0,.9)!important';
  const PATTERNS = {
    email: /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i,
    phone: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{4}\b/,
    money: /(?:R\$|US\$|\$|€|£)\s?\d[\d.,]*/,
    cpf: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/,
    cnpj: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/,
  };
  // Rules kept across apply() calls, and across pastes of this file before a reload.
  const rules = re.mask?.rules || { selectors: [], placeholders: false };
  re.mask?.stop?.(); // Re-pasting must not leave an old observer running.
  let observer = null;
  let watchedOptions = null;
  const observe = () => observer?.observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'alt', 'src', 'width', 'height', 'placeholder', 'value'],
  });

  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const validSelector = (selector) => {
    if (typeof selector !== 'string' || /[{}]/.test(selector)) return false;
    try {
      document.querySelector(selector);
      return true;
    } catch {
      return false;
    }
  };

  function writeStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
    }
    if (!style.isConnected) document.head.appendChild(style);
    const lines = [`.${CLASS}{${BLUR}}`, `.${PLACEHOLDER_CLASS}::placeholder{${BLUR_TEXT}}`];
    for (const selector of rules.selectors) lines.push(`${selector}{${BLUR}}`);
    if (rules.placeholders) lines.push(`input::placeholder,textarea::placeholder{${BLUR_TEXT}}`);
    const css = lines.join('\n');
    if (style.textContent !== css) style.textContent = css;
  }

  function apply(options = {}) {
    const patterns = { ...PATTERNS };
    for (const [i, name] of (options.names || []).entries()) patterns[`name${i + 1}`] = new RegExp(escapeRegExp(name), 'i');
    const invalid = (options.selectors || []).filter((selector) => !validSelector(selector));
    for (const selector of options.selectors || []) {
      if (!invalid.includes(selector) && !rules.selectors.includes(selector)) rules.selectors.push(selector);
    }
    if (options.placeholders) rules.placeholders = true;
    writeStyle();

    const counts = {};
    const mark = (element, reason, className = CLASS) => {
      if (!element || element === document.body || element === document.documentElement) return;
      if (!element.classList.contains(className)) {
        element.classList.add(className);
        counts[reason] = (counts[reason] || 0) + 1;
      }
    };
    const matches = (text) => Object.entries(patterns).find(([, pattern]) => text && pattern.test(text))?.[0];

    for (const selector of rules.selectors) {
      for (const element of document.querySelectorAll(selector)) mark(element, `selector ${selector}`);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      const reason = matches(text);
      if (reason) mark(node.parentElement, reason);
    }
    for (const field of document.querySelectorAll('input, textarea')) {
      const reason = matches(field.value);
      if (reason) mark(field, reason);
      const placeholder = matches(field.getAttribute('placeholder'));
      if (placeholder) mark(field, `placeholder ${placeholder}`, PLACEHOLDER_CLASS);
    }
    if (options.avatars !== false) {
      for (const image of document.querySelectorAll('img')) {
        const rect = image.getBoundingClientRect();
        const round = parseFloat(getComputedStyle(image).borderTopLeftRadius) >= rect.width / 3;
        if (rect.width > 0 && rect.width <= 64 && (round || /avatar|profile|user/i.test(`${image.className} ${image.alt}`))) mark(image, 'avatar');
      }
    }
    const result = {
      masked: Object.values(counts).reduce((a, b) => a + b, 0),
      byReason: counts,
      rules: { selectors: rules.selectors.length, placeholders: rules.placeholders },
    };
    if (invalid.length) result.invalidSelectors = invalid;
    re.last = result;
    return result;
  }

  function refresh(event) {
    if (!observer || (event?.type === 'load' && event.target?.tagName !== 'IMG')) return;
    // A single synchronous scan per mutation batch. Do not observe our own marks.
    observer.disconnect();
    try {
      re.last = { ...apply(watchedOptions), watching: true };
    } finally {
      observe();
    }
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    watchedOptions = null;
    for (const event of ['input', 'change', 'load']) document.removeEventListener(event, refresh, true);
    return { watching: false };
  }

  function watch(options = {}) {
    stop();
    // Copy arrays so later caller changes cannot silently change the watch rules.
    const snapshot = { ...options, names: [...(options.names || [])], selectors: [...(options.selectors || [])] };
    const result = apply(snapshot);
    watchedOptions = snapshot;
    observer = new MutationObserver(refresh);
    observe();
    for (const event of ['input', 'change', 'load']) document.addEventListener(event, refresh, true);
    re.last = { ...result, watching: true };
    return re.last;
  }

  function clear() {
    stop();
    for (const element of document.querySelectorAll(`.${CLASS}, .${PLACEHOLDER_CLASS}`)) element.classList.remove(CLASS, PLACEHOLDER_CLASS);
    document.getElementById(STYLE_ID)?.remove();
    rules.selectors = [];
    rules.placeholders = false;
    re.last = { cleared: true };
    return re.last;
  }

  re.mask = { apply, watch, stop, clear, rules };
  return apply();
})();
