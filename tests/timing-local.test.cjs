const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const originalSource = fs.readFileSync('timer/scripsttimer.js', 'utf8');
const loopSource = fs.readFileSync('timer_loop/scripsttimer.js', 'utf8');

function renderedText(node) {
  return [node.textContent || '', ...(node.children || []).map(renderedText)].join(' ');
}

function createHarness(source, store = new Map(), storageFailures = {}) {
  const elements = new Map();
  const links = [];
  const blobs = [];
  const documentListeners = {};
  const syncUpdates = [];
  let options;
  const localStorage = {
    getItem: key => {
      if (storageFailures.read) throw storageFailures.read;
      return store.has(key) ? store.get(key) : null;
    },
    setItem: (key, value) => {
      if (storageFailures.write) throw storageFailures.write;
      store.set(key, String(value));
    },
    removeItem: key => {
      if (storageFailures.remove) throw storageFailures.remove;
      store.delete(key);
    }
  };
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.style = {};
      this.children = [];
      this.listeners = {};
      this.textContent = '';
      this.value = '200';
      this.files = [];
      this.classList = { add() {}, remove() {} };
    }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    before(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) {
      if (!this.attributes) this.attributes = {};
      this.attributes[name] = String(value);
    }
    querySelector(selector) {
      if (selector !== 'h3') return null;
      const find = node => {
        if (node.tagName === 'H3') return node;
        for (const child of node.children || []) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      };
      return find(this);
    }
    querySelectorAll() { return []; }
    click() { this.clicked = true; }
  }
  const document = {
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) {
        const find = node => {
          if (node.id === id) return node;
          for (const child of node.children || []) {
            const found = find(child);
            if (found) return found;
          }
          return null;
        };
        for (const element of elements.values()) {
          const found = find(element);
          if (found) return found;
        }
      }
      if (['download-pdf', 'download-csv', 'configure-runners'].includes(id)) return null;
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement(tag) {
      const element = new Element(tag);
      if (tag === 'a') links.push(element);
      return element;
    },
    addEventListener(type, callback) { documentListeners[type] = callback; },
    head: {
      appendChild() {}
    }
  };
  const window = {
    confirm: () => true,
    addEventListener() {},
    PaceTrackTiming: {
      create(runtimeOptions) {
        options = runtimeOptions;
        return {
          prepare() {},
          stop() {},
          dispose() {},
          setSync(text, kind) { syncUpdates.push({ text, kind }); },
          interrupt(reason) { runtimeOptions.onInterrupt(reason); },
          setTriggerLabel(label) { this.triggerLabel = label; }
        };
      }
    }
  };
  class AudioStub {
    play() { return Promise.resolve(); }
    pause() {}
  }
  const context = {
    window,
    document,
    localStorage,
    Audio: AudioStub,
    performance: { now: () => 0 },
    navigator: {},
    URL: {
      createObjectURL: blob => { blobs.push(blob); return `blob:local-test-${blobs.length}`; },
      revokeObjectURL() {}
    },
    Blob: class BlobStub {
      constructor(parts, options) { this.parts = parts; this.options = options; }
    },
    Date,
    Map,
    Number,
    String,
    Math,
    JSON,
    console,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(source, context);
  return { elements, links, blobs, documentListeners, syncUpdates, store, options, window, get: id => document.getElementById(id) };
}

test('Original alternates start/finish and persists method + completed history', () => {
  const storage = new Map();
  const first = createHarness(originalSource, storage);
  first.options.onReady({ method: 'manual' });
  assert.match(first.get('status-message').textContent, /Original · Manual/);
  first.options.onTrigger({ now: 1000, method: 'manual' });
  first.options.onTrigger({ now: 4321, method: 'manual' });
  const records = JSON.parse(storage.get('pt_timer_recordedLaps'));
  assert.equal(records.length, 1);
  assert.equal(records[0].time, 3321);
  assert.equal(records[0].method, 'manual');
  assert.equal(records[0].round, 1);

  createHarness(originalSource, storage);
  assert.equal(JSON.parse(storage.get('pt_timer_recordedLaps')).length, 1);
});

test('Original shows method in round progress and retains completed result in recent history after advancing', () => {
  const harness = createHarness(originalSource);
  harness.options.onTrigger({ now: 500, method: 'manual' });
  harness.options.onTrigger({ now: 2050, method: 'manual' });

  const roundList = harness.get('laps-list');
  assert.match(renderedText(roundList), /Manual/);
  const historyList = harness.get('original-history-list');
  assert.equal(historyList.children.length, 0, 'current-round result should not duplicate into history');

  harness.get('message-box-ok').onclick();
  assert.equal(historyList.children.length, 1);
  assert.match(renderedText(historyList), /Corredor 1/);
  assert.match(renderedText(historyList), /Ronda 1/);
  assert.match(renderedText(historyList), /00:01\.550/);
  assert.match(renderedText(historyList), /Manual/);
  assert.match(renderedText(roundList), /--:--\.---/);
});

test('Loop starts then records each segment as a lap and persists automatic/manual method', () => {
  const storage = new Map();
  const harness = createHarness(loopSource, storage);
  harness.options.onReady({ method: 'automatic' });
  assert.match(harness.get('status-message').textContent, /Loop · Automático/);
  harness.options.onTrigger({ now: 50, method: 'automatic' });
  harness.options.onTrigger({ now: 1550, method: 'automatic' });
  harness.options.onTrigger({ now: 3000, method: 'manual' });
  const records = JSON.parse(storage.get('pt_loop_recordedLaps'));
  assert.deepEqual(records.map(record => record.time), [1500, 1450]);
  assert.deepEqual(records.map(record => record.method), ['automatic', 'mixta']);
});

test('interruption does not save the incomplete Loop segment and preserves completed laps', () => {
  const storage = new Map();
  const harness = createHarness(loopSource, storage);
  harness.options.onTrigger({ now: 100, method: 'manual' });
  harness.options.onTrigger({ now: 1100, method: 'manual' });
  harness.options.onTrigger({ now: 1200, method: 'manual' });
  harness.options.onInterrupt('camera perdida');
  assert.equal(JSON.parse(storage.get('pt_loop_recordedLaps')).length, 2);
  assert.match(harness.elements.get('status-message').textContent, /se descartó/);
});

test('Loop legacy migration imports numeric arrays but excludes Original object records', () => {
  const numericStorage = new Map([['recordedLaps', JSON.stringify([1200, 900])]]);
  createHarness(loopSource, numericStorage);
  assert.equal(JSON.parse(numericStorage.get('pt_loop_recordedLaps')).length, 2);

  const objectStorage = new Map([['recordedLaps', JSON.stringify([{ time: 1000, runnerName: 'A' }])]]);
  createHarness(loopSource, objectStorage);
  assert.equal(objectStorage.has('pt_loop_recordedLaps'), false);
});

test('Original merges current-round legacy history into exports once across reloads', () => {
  const storage = new Map([
    ['pt_timer_runners', JSON.stringify([{ id: 1, name: 'Ana' }, { id: 2, name: 'Beto' }])],
    ['pt_timer_currentRunnerIndex', '1'],
    ['pt_timer_currentRound', '2'],
    ['pt_timer_recordedLaps', JSON.stringify([
      { time: 1000, runnerName: 'Ana', runnerIndex: 0 }
    ])],
    ['pt_timer_roundLaps', JSON.stringify([
      { time: 2300, runnerName: 'Ana', runnerIndex: 0 },
      { time: 2300, runnerName: 'Ana', runnerIndex: 0, round: 2 }
    ])]
  ]);
  const harness = createHarness(originalSource, storage);
  let records = JSON.parse(storage.get('pt_timer_recordedLaps'));
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.round), [1, 2]);
  assert.equal(JSON.parse(storage.get('pt_timer_roundLaps')).length, 1);

  harness.get('download-csv').listeners.click();
  const csv = harness.blobs[0].parts[0];
  assert.match(csv, /"2","Ana","2300","00:02\.300"/);

  const pdfLines = [];
  harness.window.jspdf = { jsPDF: class {
    setFontSize() {}
    setTextColor() {}
    text(value) { pdfLines.push(value); }
    addPage() {}
    save() {}
  } };
  harness.get('download-pdf').listeners.click();
  assert.ok(pdfLines.some(line => line === 'Ronda 2'));
  assert.ok(pdfLines.some(line => line.includes('Ana: 00:02.300')));

  createHarness(originalSource, storage);
  records = JSON.parse(storage.get('pt_timer_recordedLaps'));
  assert.equal(records.length, 2);
  assert.equal(records.filter(record => record.round === 2).length, 1);
});

test('Loop reset persists an empty namespaced history and does not reimport shared legacy numbers', () => {
  const storage = new Map([['recordedLaps', JSON.stringify([1200, 900])]]);
  const harness = createHarness(loopSource, storage);
  assert.equal(JSON.parse(storage.get('pt_loop_recordedLaps')).length, 2);
  harness.get('reset-button').listeners.click();
  assert.equal(storage.get('pt_loop_recordedLaps'), '[]');
  assert.equal(storage.get('recordedLaps'), JSON.stringify([1200, 900]));

  createHarness(loopSource, storage);
  assert.deepEqual(JSON.parse(storage.get('pt_loop_recordedLaps')), []);
});

test('adapters leave visibility interruption to the shared runtime', () => {
  const original = createHarness(originalSource);
  const loop = createHarness(loopSource);
  assert.equal(original.documentListeners.visibilitychange, undefined);
  assert.equal(loop.documentListeners.visibilitychange, undefined);
});

test('storage quota failures retain an error sync warning while in-memory results export', () => {
  const quotaError = new Error('QuotaExceededError');
  const original = createHarness(originalSource, new Map(), { write: quotaError });
  original.options.onReady({ method: 'manual' });
  original.options.onTrigger({ now: 10, method: 'manual' });
  original.options.onTrigger({ now: 1510, method: 'manual' });
  assert.equal(original.syncUpdates.at(-1).kind, 'error');
  assert.match(original.syncUpdates.at(-1).text, /Exporta antes de salir/);
  original.get('download-csv').listeners.click();
  assert.match(original.blobs[0].parts[0], /"1500","00:01\.500","manual"/);

  const loop = createHarness(loopSource, new Map(), { write: quotaError });
  loop.options.onTrigger({ now: 10, method: 'manual' });
  loop.options.onTrigger({ now: 1010, method: 'manual' });
  assert.equal(loop.syncUpdates.at(-1).kind, 'error');
  assert.match(loop.syncUpdates.at(-1).text, /Exporta antes de salir/);
  loop.get('download-csv').listeners.click();
  assert.match(loop.blobs[0].parts[0], /"1000","00:01\.000","manual"/);
});

test('confirmed Original reset clears result records without deleting the runner configuration', () => {
  const storage = new Map();
  const harness = createHarness(originalSource, storage);
  harness.options.onTrigger({ now: 10, method: 'manual' });
  harness.options.onTrigger({ now: 1010, method: 'manual' });
  harness.elements.get('reset-button').listeners.click();
  assert.deepEqual(JSON.parse(storage.get('pt_timer_recordedLaps')), []);
  assert.ok(storage.has('pt_timer_runners'));
});

test('Loop CSV export remains available when PDF support is absent', () => {
  const harness = createHarness(loopSource);
  harness.options.onTrigger({ now: 10, method: 'manual' });
  harness.options.onTrigger({ now: 1010, method: 'manual' });
  harness.get('download-csv').listeners.click();
  assert.equal(harness.links.length, 1);
  assert.match(harness.links[0].download, /\.csv$/);
  harness.get('download-pdf').listeners.click();
  assert.match(harness.elements.get('message-content').textContent, /CSV/);
});