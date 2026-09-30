(() => {
  'use strict';

  const video = document.getElementById('video');
  const overlayCanvas = document.getElementById('overlay-canvas');
  const timerDisplay = document.getElementById('timer-display');
  const statusMessage = document.getElementById('status-message');
  const resetButton = document.getElementById('reset-button');
  const sensitivitySlider = document.getElementById('sensitivity-slider');
  const lapsContainer = document.getElementById('laps-container');
  const lapsList = document.getElementById('laps-list');
  const messageBox = document.getElementById('message-box');
  const messageContent = document.getElementById('message-content');
  const messageBoxOkButton = document.getElementById('message-box-ok');
  const controls = document.getElementById('controls');
  const STORAGE_KEY = 'pt_loop_recordedLaps';

  let recordedLaps = [];
  let timerState = 'stopped';
  let startTime = 0;
  let lastDisplayedTime = 0;
  let initialTriggerMethod = null;
  let runtime = null;
  let booted = false;
  let storageWarning = '';
  let storageReadFailed = false;

  function updateStorageSync() {
    if (runtime && typeof runtime.setSync === 'function') {
      runtime.setSync(storageWarning || 'Resultados en este dispositivo', storageWarning ? 'error' : 'local');
    } else if (storageWarning) {
      statusMessage.textContent = storageWarning;
    }
  }

  function warnStorage(message) {
    storageWarning = message;
    updateStorageSync();
  }

  function formatTime(ms) {
    const value = Math.max(0, Number(ms) || 0);
    const minutes = Math.floor(value / 60000);
    const seconds = Math.floor((value % 60000) / 1000);
    const millis = Math.floor(value % 1000);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  function showMessageBox(message) {
    messageContent.textContent = message;
    messageBox.style.display = 'block';
  }

  function saveLaps() {
    if (storageReadFailed) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(recordedLaps));
      if (storageWarning) {
        storageWarning = '';
        updateStorageSync();
      }
      return true;
    } catch (error) {
      warnStorage('No se pudo guardar el historial. Exporta antes de salir; la recuperación local no está confirmada.');
      return false;
    }
  }

  function isLoopRecord(record) {
    return record && typeof record === 'object' &&
      !('runnerName' in record) && !('runnerIndex' in record) &&
      Number.isFinite(Number(record.time));
  }

  function loadLaps() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        recordedLaps = Array.isArray(parsed) ? parsed.flatMap((record, index) => {
          if (typeof record === 'number' && Number.isFinite(record)) {
            return [{ time: record, method: 'legacy', sequence: index + 1 }];
          }
          return isLoopRecord(record) ? [record] : [];
        }) : [];
      } else {
        // Migrate only numeric legacy arrays: object records were used by Original mode.
        const legacy = localStorage.getItem('recordedLaps');
        if (legacy) {
          const parsed = JSON.parse(legacy);
          if (Array.isArray(parsed) && parsed.every(value => typeof value === 'number' && Number.isFinite(value))) {
            recordedLaps = parsed.map((time, index) => ({
              time, method: 'legacy', sequence: index + 1
            }));
            localStorage.setItem(STORAGE_KEY, JSON.stringify(recordedLaps));
          }
        }
      }
    } catch (error) {
      recordedLaps = [];
      storageReadFailed = true;
      warnStorage('No se pudo leer el historial guardado. Exporta los resultados disponibles antes de salir; la recuperación local no está confirmada.');
    }
    displayLaps();
  }

  function displayLaps() {
    lapsList.replaceChildren();
    if (!recordedLaps.length) {
      lapsContainer.style.display = 'none';
      return;
    }
    lapsContainer.style.display = 'block';
    recordedLaps.forEach((lap, index) => {
      const item = document.createElement('li');
      const lapName = document.createElement('span');
      lapName.textContent = `V${index + 1}:`;
      const time = document.createElement('span');
      time.textContent = formatTime(lap.time);
      item.append(lapName, time);
      const method = document.createElement('small');
      method.textContent = lap.method === 'automatic' ? 'Auto' :
        lap.method === 'manual' ? 'Manual' : 'Anterior';
      item.appendChild(method);
      lapsList.appendChild(item);
    });
    lapsList.scrollTop = lapsList.scrollHeight;
  }

  function setTriggerLabel(label) {
    if (runtime && typeof runtime.setTriggerLabel === 'function') runtime.setTriggerLabel(label);
  }

  function updateReadyStatus(event = {}) {
    const method = event.method || (runtime && runtime.method) || 'automatic';
    const methodLabel = method === 'manual' ? 'Manual' : 'Automático';
    statusMessage.textContent = `Loop · ${methodLabel} · Listo para iniciar. Cada paso siguiente registra una vuelta; separación mínima: 500 ms.`;
    setTriggerLabel(timerState === 'running' ? 'Registrar vuelta' : 'Iniciar');
  }

  function combineMethod(first, second) {
    if (!first) return second || 'manual';
    return first === second ? first : 'mixta';
  }

  function onTrigger(event) {
    const now = Number(event && event.now);
    if (!Number.isFinite(now)) return;
    const method = event.method === 'automatic' ? 'automatic' : 'manual';
    if (timerState !== 'running') {
      startTime = now;
      timerState = 'running';
      initialTriggerMethod = method;
      lastDisplayedTime = 0;
      statusMessage.textContent = 'Loop · En curso: espera el siguiente paso para registrar una vuelta.';
      timerDisplay.style.color = '#34d399';
      setTriggerLabel('Registrar vuelta');
      return;
    }

    const elapsed = Math.max(0, now - startTime);
    const record = {
      time: elapsed,
      method: combineMethod(initialTriggerMethod, method),
      sequence: recordedLaps.length + 1,
      timestamp: new Date().toISOString()
    };
    recordedLaps.push(record);
    saveLaps();
    displayLaps();
    startTime = now;
    initialTriggerMethod = method;
    lastDisplayedTime = elapsed;
    statusMessage.textContent = `Vuelta ${record.sequence}: ${formatTime(elapsed)} · ${record.method === 'automatic' ? 'automática' : record.method === 'manual' ? 'manual' : 'mixta'}. Separación mínima: 500 ms.`;
    timerDisplay.style.color = '#34d399';
  }

  function handleFrame(now) {
    if (timerState === 'running') {
      timerDisplay.textContent = formatTime(Math.max(0, now - startTime));
    } else {
      timerDisplay.textContent = formatTime(lastDisplayedTime);
    }
  }

  function handleInterrupt(reason) {
    if (timerState === 'running') {
      timerState = 'stopped';
      startTime = 0;
      initialTriggerMethod = null;
      lastDisplayedTime = 0;
      timerDisplay.textContent = '00:00.000';
      timerDisplay.style.color = '#e2e8f0';
      setTriggerLabel('Iniciar');
    }
    statusMessage.textContent = `Cronometraje interrumpido (${reason || 'detección perdida'}). El tramo incompleto se descartó; las vueltas guardadas se conservan.`;
  }

  function ensureRuntime() {
    if (runtime) return true;
    if (!window.PaceTrackTiming || typeof window.PaceTrackTiming.create !== 'function') {
      statusMessage.textContent = 'No se pudo cargar el módulo de cronometraje.';
      return false;
    }
    runtime = window.PaceTrackTiming.create({
      mode: 'loop',
      video,
      canvas: overlayCanvas,
      status: statusMessage,
      display: timerDisplay,
      slider: sensitivitySlider,
      mount: document.getElementById('app-container'),
      onTrigger,
      onFrame: handleFrame,
      onInterrupt: handleInterrupt,
      onReady: updateReadyStatus,
      getActivity: () => timerState === 'running',
      hasUnsavedData: () => Boolean(storageWarning && recordedLaps.length)
    });
    if (storageWarning) updateStorageSync();
    return true;
  }

  function downloadCSV() {
    if (!recordedLaps.length) return showMessageBox('No hay vueltas para exportar.');
    const quote = value => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const rows = [['Vuelta', 'Tiempo (ms)', 'Tiempo', 'Método']];
    recordedLaps.forEach((lap, index) => rows.push([
      index + 1, Math.round(Number(lap.time) || 0), formatTime(lap.time), lap.method || 'legacy'
    ]));
    const blob = new Blob(['\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8'
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `reporte_loop_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function downloadPDF() {
    if (!recordedLaps.length) return showMessageBox('No hay vueltas para exportar.');
    if (!window.jspdf || !window.jspdf.jsPDF) {
      return showMessageBox('PDF no disponible sin conexión. Usa «Descargar CSV» para guardar los resultados.');
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.text('REPORTE DE VUELTAS · LOOP', 105, 20, { align: 'center' });
    doc.setFontSize(10);
    doc.text(`Generado: ${new Date().toLocaleDateString()}`, 20, 30);
    let y = 42;
    recordedLaps.forEach((lap, index) => {
      if (y > 280) { doc.addPage(); y = 20; }
      const method = lap.method === 'automatic' ? 'Automático' :
        lap.method === 'manual' ? 'Manual' : (lap.method || 'Anterior');
      doc.text(`Vuelta ${index + 1}: ${formatTime(lap.time)} · ${method}`, 20, y);
      y += 8;
    });
    doc.save(`reporte_loop_${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  function addButton(id, text, handler, className, parent = controls) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = text;
    if (className) button.className = className;
    button.addEventListener('click', handler);
    parent.appendChild(button);
  }

  function clearHistory() {
    if ((recordedLaps.length || timerState === 'running') &&
      !window.confirm('Esto borrará todas las vueltas guardadas y descartará el tramo incompleto. ¿Continuar?')) return;
    recordedLaps = [];
    timerState = 'stopped';
    startTime = 0;
    lastDisplayedTime = 0;
    initialTriggerMethod = null;
    // The shared legacy key belongs to multiple modes. Keep it untouched and
    // persist an empty namespaced array so old numeric Loop data is not imported again.
    storageReadFailed = false;
    saveLaps();
    displayLaps();
    timerDisplay.textContent = '00:00.000';
    if (runtime) {
      runtime.stop();
      runtime.prepare();
    }
    updateReadyStatus();
  }

  resetButton.addEventListener('click', clearHistory);
  messageBoxOkButton.addEventListener('click', () => { messageBox.style.display = 'none'; });
  function bootApp() {
    if (booted) return;
    booted = true;
    loadLaps();
    const actions = document.createElement('div');
    actions.className = 'timer-history-actions';
    actions.style.cssText = 'display:flex;flex:1 1 100%;flex-wrap:wrap;gap:8px;justify-content:center;max-height:22vh;overflow:auto;';
    controls.appendChild(actions);
    addButton('download-pdf', 'Descargar PDF', downloadPDF, 'gradient-purple', actions);
    addButton('download-csv', 'Descargar CSV', downloadCSV, 'gradient-blue', actions);
    updateReadyStatus();
    ensureRuntime();
  }

  const pdfScript = document.createElement('script');
  pdfScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  document.head.appendChild(pdfScript);
  bootApp();
})();