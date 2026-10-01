export function createSessionApiBrowserMock() {
  const sessions = new Map();
  const calls = [];
  let nextId = 1;

  function response(status, data) {
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  }

  function tokenFor(role, sequence) {
    return (role + '-' + sequence.toString(36).padStart(40, '0')).slice(0, 43);
  }

  function makeSession(kind) {
    const sequence = nextId++;
    const id = '00000000-0000-4000-8000-' + sequence.toString(16).padStart(12, '0');
    const invite = sequence.toString(16).padStart(32, '0');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const session = {
      id, kind, invite, expiresAt,
      ownerToken: tokenFor('owner', sequence),
      guestToken: tokenFor('guest', sequence),
      results: new Map(),
    };
    sessions.set(id, session);
    return session;
  }

  async function fetch(input, init = {}, offline = false) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const url = new URL(rawUrl, location.href);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    let body = init.body;
    if (body === undefined && input instanceof Request) {
      try { body = await input.clone().text(); } catch (_) { body = undefined; }
    }
    calls.push({ path: url.pathname, method, body: body || null, offline: Boolean(offline) });

    if (!url.pathname.startsWith('/api/')) {
      throw new Error('Browser fixture blocked unexpected network request: ' + url.pathname);
    }
    if (offline) throw new Error('fixture Replit offline');

    if (url.pathname === '/api/contact' && method === 'POST') {
      return response(201, { accepted: true });
    }

    if (/^\/api\/sessions?$/.test(url.pathname) && method === 'POST') {
      const payload = JSON.parse(body || '{}');
      if (!['pc', 'sector', 'timer'].includes(payload.kind)) return response(400, { error: 'invalid_kind' });
      const session = makeSession(payload.kind);
      return response(201, {
        id: session.id,
        token: session.ownerToken,
        invite: session.invite,
        expiresAt: session.expiresAt,
        expiresAtISO: session.expiresAt,
      });
    }

    if (/^\/api\/sessions?\/join$/.test(url.pathname) && method === 'POST') {
      const payload = JSON.parse(body || '{}');
      const session = Array.from(sessions.values()).find(item => item.invite === payload.invite);
      if (!session) return response(404, { error: 'not_found' });
      return response(200, {
        id: session.id,
        token: session.guestToken,
        expiresAt: session.expiresAt,
        expiresAtISO: session.expiresAt,
      });
    }

    const route = url.pathname.match(/^\/api\/sessions?\/([0-9a-f-]+)(\/results(?:\/[^/]+)?|\/signals)?$/i);
    if (!route) throw new Error('Browser fixture blocked unsupported API route: ' + url.pathname);
    const session = sessions.get(route[1]);
    if (!session) return response(404, { error: 'not_found' });
    const authorization = headers.get('Authorization') || '';
    const role = authorization === 'Bearer ' + session.ownerToken ? 'owner'
      : authorization === 'Bearer ' + session.guestToken ? 'guest' : null;
    calls[calls.length - 1].role = role;
    if (!role) return response(401, { error: 'unauthorized' });

    const suffix = route[2] || '';
    if (!suffix && method === 'GET') {
      return response(200, { id: session.id, kind: session.kind, role, expiresAt: session.expiresAt });
    }
    if (suffix === '/results' && method === 'GET') {
      return response(200, Array.from(session.results.values()));
    }
    if (suffix.startsWith('/results/') && method === 'PUT') {
      const resultId = decodeURIComponent(suffix.slice('/results/'.length));
      const result = JSON.parse(body || '{}');
      if (!result || result.id !== resultId || result.sessionId !== session.id) {
        return response(400, { error: 'invalid_result' });
      }
      session.results.set(resultId, result);
      return response(200, Object.assign({ confirmed: true, result }, result));
    }
    if (suffix === '/signals' && method === 'GET') {
      return response(200, { description: null, answered: false, candidates: [], closed: true });
    }
    if (!suffix && method === 'DELETE' && role === 'owner') {
      sessions.delete(session.id);
      return response(200, { deleted: true });
    }
    return response(405, { error: 'method_not_allowed' });
  }

  return {
    calls,
    sessions,
    fetch,
    results(sessionId) {
      const session = sessions.get(sessionId);
      return session ? Array.from(session.results.values()) : [];
    },
  };
}

export function installSessionApiBrowserMock(offline = false, fixturePageUrl = '') {
  const fixture = window.parent.__pacetrackSessionMock;
  if (!fixture || typeof fixture.fetch !== 'function') {
    throw new Error('The isolated Replit API fixture was not installed by the parent page.');
  }
  const NativeURLSearchParams = window.URLSearchParams;
  const virtualPageUrl = fixturePageUrl ? new window.URL(fixturePageUrl) : null;
  window.URLSearchParams = class FixtureURLSearchParams extends NativeURLSearchParams {
    constructor(input, ...rest) {
      super(input, ...rest);
      this.fixtureEmptyInput = virtualPageUrl && (input === undefined || String(input) === '');
    }

    get(name) {
      const existing = super.get(name);
      if (existing !== null || !this.fixtureEmptyInput) return existing;
      if (name === 'session') return virtualPageUrl.searchParams.get('session');
      if (name === 'invite') {
        const fragment = new NativeURLSearchParams(virtualPageUrl.hash.replace(/^#/, ''));
        return fragment.get('invite');
      }
      return existing;
    }
  };
  const NativeURL = window.URL;
  window.URL = class FixtureURL extends NativeURL {
    constructor(input, base) {
      const needsBase = window.location.href.startsWith('about:srcdoc') || window.location.href.startsWith('blob:');
      const effectiveBase = base === window.location.href && needsBase
        ? document.baseURI
        : base;
      super(input, effectiveBase);
    }
  };
  window.fetch = (input, options) => fixture.fetch(input, options, offline);
  const nativeReplaceState = window.history.replaceState.bind(window.history);
  window.history.replaceState = function (state, title, url) {
    if (window.location.href.startsWith('about:srcdoc')) return;
    return nativeReplaceState(state, title, url);
  };

  const NativeXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends NativeXHR {
    open(method, url, ...rest) {
      if (new URL(url, window.location.href).pathname.startsWith('/api/')) {
        throw new Error('Browser fixture blocks unmocked XMLHttpRequest API calls.');
      }
      return super.open(method, url, ...rest);
    }
  };
  if (navigator.sendBeacon) {
    const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      if (new URL(url, window.location.href).pathname.startsWith('/api/')) return false;
      return nativeSendBeacon(url, data);
    };
  }
  window.addEventListener('submit', event => {
    const form = event.target;
    const action = new URL(form.action || window.location.href, window.location.href);
    if (!action.pathname.startsWith('/api/')) return;
    event.preventDefault();
    if (action.pathname === '/api/contact' && String(form.method).toUpperCase() === 'POST') {
      fixture.fetch(action.href, { method: 'POST', body: '{}' }, offline)
        .catch(error => { window.__apiFormError = error.message; });
    } else {
      window.__apiFormError = 'Browser fixture blocked unsupported API form submission: ' + action.pathname;
    }
  }, true);
}