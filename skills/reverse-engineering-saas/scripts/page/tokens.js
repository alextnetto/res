// tokens.js: design tokens in use on the page.
// Paste the whole file into the browser's JavaScript tool. The value of the
// last expression is the result.
//   window.__re.tokens({ root: '.selector' })  resolves variables and counts styles in a subtree
//   window.__re.tokens.element('.selector')    computed style of one element (use for hover/focus states)
// Playwright browser_evaluate: wrap as () => { <file>; return window.__re.last; }
(() => {
  const re = (window.__re = window.__re || {});

  const bump = (map, key, extra) => {
    if (!key) return;
    const entry = (map[key] = map[key] || { count: 0 });
    entry.count += 1;
    if (extra) entry[extra] = (entry[extra] || 0) + 1;
  };
  const top = (map, n) =>
    Object.entries(map)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n)
      .map(([value, data]) => ({ value, ...data }));

  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const hasOwnText = (element) =>
    [...element.childNodes].some((node) => node.nodeType === 3 && node.nodeValue.trim());
  const transparent = (color) => color === 'transparent' || color === 'rgba(0, 0, 0, 0)';

  // Collects --custom-properties declared in readable stylesheets.
  const collectDeclaredVariables = () => {
    const declared = {};
    const unreadable = [];
    const walk = (rules, context) => {
      for (const rule of rules) {
        if (rule.style) {
          for (let i = 0; i < rule.style.length; i += 1) {
            const name = rule.style[i];
            if (!name.startsWith('--')) continue;
            (declared[name] = declared[name] || []).push({
              selector: rule.selectorText || '(at-rule)',
              context: context || undefined,
              value: rule.style.getPropertyValue(name).trim(),
            });
          }
        }
        if (rule.cssRules) walk(rule.cssRules, rule.conditionText || rule.media?.mediaText || context);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules, sheet.media?.mediaText);
      } catch {
        unreadable.push(sheet.href || '(inline)');
      }
    }
    return { declared, unreadable };
  };

  // Resolves a color expression to the browser's computed rgb() form.
  const probe = document.createElement('span');
  const resolveColor = (expression, root) => {
    // var() always passes CSS.supports, and resolves to the inherited color when invalid.
    if (!expression || expression.includes('var(') || !CSS.supports('color', expression)) return null;
    probe.style.color = '';
    probe.style.color = expression;
    root.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };

  function tokens(options = {}) {
    const root = options.root ? document.querySelector(options.root) : document.body;
    if (!root) return { error: `No element matches ${options.root}` };
    const limit = options.limit || 4000;
    const maxVariables = options.maxVariables || 300;

    const { declared, unreadable } = collectDeclaredVariables();
    const rootStyle = getComputedStyle(root);
    for (let i = 0; i < rootStyle.length; i += 1) {
      const name = rootStyle[i];
      if (name.startsWith('--') && !declared[name]) declared[name] = [{ selector: '(computed on scope)', value: rootStyle.getPropertyValue(name).trim() }];
    }
    const variables = Object.entries(declared).map(([name, declarations]) => {
      const resolved = rootStyle.getPropertyValue(name).trim();
      return { name, resolved, color: resolveColor(resolved, root), declarations: declarations.slice(0, 4) };
    });
    const variablesByValue = {};
    for (const variable of variables) {
      for (const key of [variable.color, variable.resolved]) {
        if (key) (variablesByValue[key] = variablesByValue[key] || []).push(variable.name);
      }
    }

    const colors = {};
    const families = {};
    const typeScale = {};
    const spacing = {};
    const radius = {};
    const shadows = {};
    const motion = {};
    const zIndex = {};
    const elements = [root, ...root.querySelectorAll('*')];
    let sampled = 0;
    for (const element of elements) {
      if (sampled >= limit) break;
      if (!isVisible(element)) continue;
      sampled += 1;
      const style = getComputedStyle(element);
      if (hasOwnText(element)) {
        bump(colors, style.color, 'text');
        bump(families, style.fontFamily);
        bump(typeScale, `${style.fontSize}/${style.lineHeight} ${style.fontWeight}`);
      }
      if (!transparent(style.backgroundColor)) bump(colors, style.backgroundColor, 'background');
      if (parseFloat(style.borderTopWidth) > 0 && !transparent(style.borderTopColor)) bump(colors, style.borderTopColor, 'border');
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const value = style[`padding${side}`];
        if (value !== '0px') bump(spacing, value, 'padding');
      }
      if (style.rowGap && style.rowGap !== 'normal' && style.rowGap !== '0px') bump(spacing, style.rowGap, 'gap');
      if (style.borderTopLeftRadius !== '0px') bump(radius, style.borderTopLeftRadius);
      if (style.boxShadow !== 'none') bump(shadows, style.boxShadow);
      if (style.transitionDuration !== '0s') bump(motion, `transition ${style.transitionProperty} ${style.transitionDuration} ${style.transitionTimingFunction}`);
      if (style.animationName && style.animationName !== 'none') bump(motion, `animation ${style.animationName} ${style.animationDuration} ${style.animationTimingFunction}`);
      if (style.zIndex !== 'auto' && style.position !== 'static') bump(zIndex, style.zIndex);
    }

    const withVariables = (list) =>
      list.map((entry) => ({ ...entry, variables: (variablesByValue[entry.value] || []).slice(0, 5) }));

    const result = {
      scope: options.root || 'body',
      sampledElements: sampled,
      truncated: sampled >= limit,
      theme: {
        htmlClass: document.documentElement.className || null,
        dataTheme: document.documentElement.getAttribute('data-theme'),
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      },
      variables: {
        total: variables.length,
        list: variables.slice(0, maxVariables),
        unreadableStylesheets: unreadable,
      },
      colors: withVariables(top(colors, 40)),
      typography: {
        families: top(families, 10),
        scale: top(typeScale, 30),
      },
      spacing: withVariables(top(spacing, 30)),
      radius: withVariables(top(radius, 20)),
      shadows: withVariables(top(shadows, 15)),
      motion: top(motion, 15),
      zIndex: top(zIndex, 20),
      fonts: [...new Set([...document.fonts].filter((font) => font.status === 'loaded').map((font) => `${font.family} ${font.weight} ${font.style}`))],
    };
    re.last = result;
    return result;
  }

  const ELEMENT_PROPERTIES = [
    'display', 'position', 'width', 'height', 'color', 'backgroundColor', 'borderTopColor', 'borderTopWidth',
    'borderTopStyle', 'borderTopLeftRadius', 'boxShadow', 'outlineColor', 'outlineWidth', 'outlineStyle',
    'outlineOffset', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom',
    'marginLeft', 'gap', 'opacity', 'cursor', 'transitionProperty', 'transitionDuration', 'transitionTimingFunction',
    'animationName', 'animationDuration', 'animationTimingFunction',
  ];

  tokens.element = function element(selector) {
    const target = document.querySelector(selector);
    if (!target) return { error: `No element matches ${selector}` };
    const style = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const result = {
      selector,
      tag: target.localName,
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      style: Object.fromEntries(ELEMENT_PROPERTIES.map((property) => [property, style[property]])),
      children: target.children.length,
    };
    re.last = result;
    return result;
  };

  re.tokens = tokens;
  return tokens();
})();
