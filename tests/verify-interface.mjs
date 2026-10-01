import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = {
  'index.html': [
    'main', 'themeToggle', 'cronometros-titulo', 'contacto', 'contactForm',
    'nombre', 'email', 'mensaje', 'backToTop', 'notification',
  ],
  'timer/timer.html': [
    'app-container', 'video-container', 'video', 'overlay-canvas', 'timer-display',
    'controls', 'reset-button', 'status-message', 'sensitivity-slider-container',
    'sensitivity-slider', 'laps-container', 'laps-list', 'message-box',
    'setup-modal', 'excel-modal', 'names-modal', 'repeat-modal',
  ],
  'timer_loop/timer_loop.html': [
    'app-container', 'video-container', 'video', 'overlay-canvas', 'timer-display',
    'controls', 'reset-button', 'status-message', 'sensitivity-slider-container',
    'sensitivity-slider', 'laps-container', 'laps-list', 'message-box',
  ],
  'timer_sector/timer_sector.html': [
    'app-container', 'video-container', 'video', 'overlay-canvas', 'timer-display',
    'controls', 'reset-button', 'status-message', 'sensitivity-slider-container',
    'sensitivity-slider', 'laps-container', 'laps-list', 'message-box', 'p2p-panel',
    'p2p-room-id', 'p2p-create', 'p2p-join', 'p2p-status', 'p2p-role-indicator',
  ],
  'events/events.html': ['main', 'themeToggle', 'proximos-eventos', 'eventos-pasados', 'notification'],
  'timer_PC/PC/PC.html': ['qrcode', 'status-message', 'laps-container'],
  'timer_PC/Mobil/timer.html': [
    'app-container', 'video-container', 'video', 'timer-display', 'status-message',
    'controls', 'reset-button', 'laps-container', 'laps-list',
  ],
  'Construccion/construccion.html': ['themeToggle', 'backHome', 'particles'],
};

const htmlByPath = new Map();
for (const [relativePath, requiredIds] of Object.entries(pages)) {
  const fullPath = path.join(root, relativePath);
  assert.ok(fs.existsSync(fullPath), `Missing shipped page: ${relativePath}`);
  const html = fs.readFileSync(fullPath, 'utf8');
  htmlByPath.set(relativePath, html);

  assert.doesNotMatch(html, /__mockup\/|artifacts\/mockup-sandbox|sandbox|pt-preview-note|vista previa|desactivad[oa]s?\s+(?:en|durante)\s+esta\s+vista previa/i,
    `${relativePath} contains preview-only UI or sandbox references`);
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`\\bid=["']${id}["']`), `${relativePath} is missing critical #${id}`);
  }

  for (const [, rawUrl] of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    if (/^(?:https?:|mailto:|tel:|data:|javascript:|#)/i.test(rawUrl)) continue;
    const [urlPath, fragment] = rawUrl.split('#', 2);
    const cleanPath = urlPath.split('?')[0];
    const targetPath = cleanPath
      ? path.resolve(path.dirname(fullPath), decodeURIComponent(cleanPath))
      : fullPath;
    assert.ok(fs.existsSync(targetPath), `${relativePath} has broken local reference: ${rawUrl}`);
    if (fragment) {
      const targetHtml = htmlByPath.get(path.relative(root, targetPath))
        ?? (targetPath.endsWith('.html') ? fs.readFileSync(targetPath, 'utf8') : '');
      if (targetHtml) {
        assert.match(targetHtml, new RegExp(`\\bid=["']${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`),
          `${relativePath} links to missing fragment ${rawUrl}`);
      }
    }
  }
}

const serviceRequirements = {
  'timer_sector/timer_sector.html': [
    '../timing/session-api.js',
    'scriptsSector.js',
  ],
  'timer_PC/PC/PC.html': [
    '../../timing/session-api.js',
    'PCscripts.js',
  ],
  'timer_PC/Mobil/timer.html': [
    '../../timing/session-api.js',
    '../../timing/result-sync.js',
    'scripsttimer.js',
  ],
  'index.html': ['script.js'],
  'events/events.html': ['events.js'],
};
for (const [relativePath, requiredScripts] of Object.entries(serviceRequirements)) {
  const html = htmlByPath.get(relativePath);
  for (const script of requiredScripts) {
    assert.ok(html.includes(script), `${relativePath} is missing production service script ${script}`);
  }
}

for (const relativePath of [
  'timer_sector/timer_sector.html',
  'timer_PC/PC/PC.html',
  'timer_PC/Mobil/timer.html',
]) {
  const html = htmlByPath.get(relativePath);
  assert.doesNotMatch(html, /firebase|netlify/i,
    `${relativePath} must not depend on Firebase or Netlify`);
  assert.match(html, /(?:src|href)=["'][^"']*timing\/session-api\.js(?:[?#][^"']*)?["']/i,
    `${relativePath} must load the shared Replit session API`);
}

const contactForm = htmlByPath.get('index.html').match(/<form\b[^>]*id=["']contactForm["'][^>]*>/i)?.[0] ?? '';
assert.match(contactForm, /\baction=["']\/api\/contact["']/i, 'Contact form must submit to the Replit contact API');
assert.match(contactForm, /\bmethod=["']POST["']/i, 'Contact form must submit with POST');
assert.doesNotMatch(contactForm, /\bdata-netlify(?:=["'][^"']*["'])?/i, 'Contact form must not depend on Netlify');

// Parse classic inline scripts and local classic JS dependencies. JSON-LD and modules are data/import graphs, not classic scripts.
const checkedScripts = new Set();
for (const [relativePath, html] of htmlByPath) {
  const htmlDir = path.dirname(path.join(root, relativePath));
  for (const [, attributes, inlineSource] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = attributes.match(/\btype=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (type === 'module' || type === 'application/ld+json') continue;
    const src = attributes.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!src) {
      if (inlineSource.trim()) new vm.Script(inlineSource, { filename: `${relativePath} inline script` });
      continue;
    }
    if (/^(?:https?:|data:)/i.test(src)) continue;
    const localScript = path.resolve(htmlDir, decodeURIComponent(src.split(/[?#]/, 1)[0]));
    if (checkedScripts.has(localScript)) continue;
    checkedScripts.add(localScript);
    new vm.Script(fs.readFileSync(localScript, 'utf8'), { filename: path.relative(root, localScript) });
  }
}

console.log(`Interface regression checks passed for ${Object.keys(pages).length} shipped pages; ${checkedScripts.size} local scripts parsed.`);