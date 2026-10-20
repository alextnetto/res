// api-shapes.js: records which endpoints the page calls and the shape of
// their JSON, never the values, headers or cookies.
// Paste the whole file into the browser's JavaScript tool, then:
//   window.__re.api.clear()      start a clean capture
//   (perform one action in the page)
//   window.__re.api.dump()       endpoint templates and shapes, in call order
//   window.__re.api.uninstall()  restore fetch, XMLHttpRequest and WebSocket
// A reload removes the recorder. Requests made before installation are not seen.
// Playwright browser_evaluate: wrap as () => { <file>; return window.__re.last; }
(() => {
  const re = (window.__re = window.__re || {});
  if (re.api?.installed) {
    re.last = { installed: true, alreadyInstalled: true, entries: re.api.count() };
    return re.last;
  }

  const MAX_DEPTH = 6;
  const MAX_KEYS = 80;
  const MAX_ENUM_VALUES = 20;
  // Short string values are kept only for keys that usually hold configuration
  // (statuses, types) and only when they look like enum values. Users can still name
  // statuses, so set window.__re.api.enumSamples = false at L3 and L4 if needed.
  const ENUM_KEY = /(^|_)(status|state|type|kind|priority|role|stage|mode|visibility|permission|level|unit|format)$/i;
  const looksLikeEnum = (value) =>
    value.length <= 30 && value.trim().split(/\s+/).length <= 3 && !/@/.test(value) && !/\d{3,}/.test(value);
  const looksLikeToken = (value) => /^[A-Za-z][\w.:/-]{0,40}$/.test(value);
  const STATIC_ASSET = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(\?|$)/i;
  const installedAt = performance.now();
  const entries = new Map();
  const original = {
    fetch: window.fetch,
    open: XMLHttpRequest.prototype.open,
    send: XMLHttpRequest.prototype.send,
    WebSocket: window.WebSocket,
  };

  const templatePath = (path) =>
    path
      .split('/')
      .map((segment) => {
        if (!segment) return segment;
        if (/^\d+$/.test(segment)) return ':id';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':id';
        if (/\d/.test(segment) && segment.length >= 6 && /^[\w-]+$/.test(segment)) return ':id';
        return segment;
      })
      .join('/');

  const templateUrl = (raw) => {
    try {
      const url = new URL(raw, location.href);
      const host = url.origin === location.origin ? '' : `${url.protocol}//${url.host}`;
      const query = [...new Set(url.searchParams.keys())].sort();
      return `${host}${templatePath(url.pathname)}${query.length ? `?${query.join('&')}` : ''}`;
    } catch {
      return String(raw).slice(0, 200);
    }
  };

  const hintFor = (value) => {
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return 'iso-date';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return 'uuid';
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email';
      if (/^https?:\/\//.test(value)) return 'url';
      if (/^#[0-9a-f]{3,8}$/i.test(value)) return 'hex-color';
      if (/^\d+$/.test(value)) return value.length >= 12 && value.length <= 13 ? 'epoch-ms-string' : 'numeric-string';
      if (value.length > 80) return 'long-text';
      return null;
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      if (value >= 1e12 && value < 1e13) return 'epoch-ms';
      if (value >= 1e9 && value < 1e10) return 'epoch-s';
    }
    return null;
  };

  const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

  // Redact recognizable record IDs, including IDs embedded in map keys. Ordinary
  // schema fields such as oauth2 and sha256 remain useful. This is a heuristic;
  // arbitrary names or opaque alphabetic keys cannot be classified reliably.
  const shapeKey = (key) =>
    /^\d+$/.test(key) || /\d{4,}/.test(key) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
      ? ':id' : key;

  // Shape: primitives become "string<iso-date>", objects redact ID keys, arrays merge their first items.
  const shapeOf = (value, depth = 0, path = '', enums = null) => {
    const type = typeOf(value);
    if (type === 'array') {
      if (depth >= MAX_DEPTH) return ['…'];
      const items = value.slice(0, 3).map((item) => shapeOf(item, depth + 1, `${path}[]`, enums));
      return items.length ? [items.reduce(mergeShapes)] : [];
    }
    if (type === 'object') {
      if (depth >= MAX_DEPTH) return '{…}';
      const out = Object.create(null);
      const keys = Object.keys(value);
      for (const key of keys.slice(0, MAX_KEYS)) {
        const child = value[key];
        const safeKey = shapeKey(key);
        const childPath = `${path}.${safeKey}`;
        if (enums && re.api?.enumSamples !== false && typeof child === 'string' && ENUM_KEY.test(key) && looksLikeEnum(child)) {
          const set = (enums[childPath] = enums[childPath] || new Set());
          if (set.size < MAX_ENUM_VALUES) set.add(child);
        }
        out[safeKey] = mergeShapes(out[safeKey], shapeOf(child, depth + 1, childPath, enums));
      }
      if (keys.length > MAX_KEYS) out['…'] = `${keys.length - MAX_KEYS} more keys`;
      return out;
    }
    const hint = hintFor(value);
    return hint ? `${type}<${hint}>` : type;
  };

  function mergeShapes(a, b) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (typeof a === 'string' && typeof b === 'string') {
      return a === b ? a : [...new Set([...a.split('|'), ...b.split('|')])].sort().join('|');
    }
    if (Array.isArray(a) && Array.isArray(b)) return a.length && b.length ? [mergeShapes(a[0], b[0])] : a.length ? a : b;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out = Object.assign(Object.create(null), a);
      for (const key of Object.keys(b)) out[key] = Object.hasOwn(a, key) ? mergeShapes(a[key], b[key]) : b[key];
      return out;
    }
    return 'mixed';
  }

  const parseJson = (text) => {
    if (typeof text !== 'string' || !/^\s*[[{]/.test(text)) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const describeBody = (body) => {
    if (body === undefined || body === null) return { shape: null };
    if (typeof body === 'string') {
      const json = parseJson(body);
      if (json !== undefined) return { json };
      if (/^[\w%.-]+=/.test(body)) return { shape: { form: [...new URLSearchParams(body).keys()] } };
      return { shape: 'text' };
    }
    if (body instanceof URLSearchParams) return { shape: { form: [...body.keys()] } };
    if (typeof FormData !== 'undefined' && body instanceof FormData) return { shape: { formData: [...new Set(body.keys())] } };
    if (body instanceof Blob) return { shape: `blob<${body.type || 'unknown'}>` };
    return { shape: typeOf(body) };
  };

  const record = ({ method, url, requestBody, status, contentType, responseJson, channel, operationHint }) => {
    if (STATIC_ASSET.test(url)) return;
    const request = describeBody(requestBody);
    let operation = operationHint || null;
    let requestShape = request.shape ?? null;
    const enums = {};
    if (request.json !== undefined) {
      const graph = request.json;
      if (graph && typeof graph === 'object' && (graph.operationName || typeof graph.query === 'string')) {
        operation = graph.operationName || graph.query.match(/^\s*(query|mutation|subscription)\s*(\w*)/)?.slice(1).join(' ') || 'anonymous';
        requestShape = shapeOf(graph.variables ?? {}, 0, 'variables', enums);
      } else {
        requestShape = shapeOf(graph, 0, 'request', enums);
      }
    }
    const template = templateUrl(url);
    const key = `${channel || method} ${template}${operation ? ` op:${operation}` : ''}`;
    const responseShape = responseJson === undefined ? null : shapeOf(responseJson, 0, 'response', enums);
    const entry = entries.get(key) || {
      call: channel || method,
      url: template,
      operation,
      count: 0,
      statuses: [],
      contentType: contentType || null,
      firstSeenMs: Math.round(performance.now() - installedAt),
      request: undefined,
      response: undefined,
      enumSamples: {},
    };
    entry.count += 1;
    if (status !== undefined && !entry.statuses.includes(status)) entry.statuses.push(status);
    entry.request = mergeShapes(entry.request, requestShape);
    entry.response = mergeShapes(entry.response, responseShape);
    for (const [path, values] of Object.entries(enums)) {
      const merged = new Set([...(entry.enumSamples[path] || []), ...values]);
      entry.enumSamples[path] = [...merged].slice(0, MAX_ENUM_VALUES);
    }
    entries.set(key, entry);
  };

  window.fetch = async function fetchWithRecorder(input, init) {
    const response = await original.fetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      const method = (init?.method || input?.method || 'GET').toUpperCase();
      const contentType = response.headers.get('content-type') || '';
      const done = (responseJson) =>
        record({ method, url, requestBody: init?.body, status: response.status, contentType: contentType.split(';')[0], responseJson });
      if (contentType.includes('json')) response.clone().json().then(done, () => done(undefined));
      else done(undefined);
    } catch {
      // The recorder must never break the page.
    }
    return response;
  };

  XMLHttpRequest.prototype.open = function openWithRecorder(method, url) {
    this.__reRequest = { method: String(method).toUpperCase(), url: String(url) };
    return original.open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function sendWithRecorder(body) {
    const request = this.__reRequest;
    if (request) {
      this.addEventListener('loadend', () => {
        try {
          const contentType = (this.getResponseHeader('content-type') || '').split(';')[0];
          let responseJson;
          if (this.responseType === 'json') responseJson = this.response ?? undefined;
          else if (this.responseType === '' || this.responseType === 'text') responseJson = parseJson(this.responseText);
          record({ ...request, requestBody: body, status: this.status, contentType, responseJson });
        } catch {
          // The recorder must never break the page.
        }
      });
    }
    return original.send.apply(this, arguments);
  };

  if (original.WebSocket) {
    const RecordedWebSocket = function WebSocket(url, protocols) {
      const socket = protocols === undefined ? new original.WebSocket(url) : new original.WebSocket(url, protocols);
      const frame = (direction) => (data) => {
        const json = parseJson(typeof data === 'string' ? data : '');
        const rawKind = json && typeof json === 'object' ? json.type || json.event || json.op || json.action || json.method : null;
        const kind = typeof rawKind === 'string' ? (looksLikeToken(rawKind) ? rawKind : '(other)') : null;
        record({ channel: `WS-${direction}`, method: 'WS', url: String(url), operationHint: kind ? String(kind) : null, responseJson: json });
      };
      socket.addEventListener('message', (event) => {
        try {
          frame('in')(event.data);
        } catch {
          // Ignore.
        }
      });
      const send = socket.send;
      socket.send = function sendWithRecorder(data) {
        try {
          frame('out')(data);
        } catch {
          // Ignore.
        }
        return send.apply(this, arguments);
      };
      return socket;
    };
    RecordedWebSocket.prototype = original.WebSocket.prototype;
    for (const constant of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) RecordedWebSocket[constant] = original.WebSocket[constant];
    window.WebSocket = RecordedWebSocket;
  }

  re.api = {
    installed: true,
    enumSamples: true,
    count: () => entries.size,
    clear() {
      entries.clear();
      return { cleared: true };
    },
    dump() {
      const result = [...entries.values()].sort((a, b) => a.firstSeenMs - b.firstSeenMs);
      re.last = result;
      return result;
    },
    uninstall() {
      window.fetch = original.fetch;
      XMLHttpRequest.prototype.open = original.open;
      XMLHttpRequest.prototype.send = original.send;
      if (original.WebSocket) window.WebSocket = original.WebSocket;
      re.api = undefined;
      return { uninstalled: true };
    },
  };

  re.last = { installed: true, next: 'Call __re.api.clear(), perform one action, then __re.api.dump().' };
  return re.last;
})();
