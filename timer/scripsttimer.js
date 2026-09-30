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
  const historyHeading = document.createElement('h4');
  const historyList = document.createElement('ul');
  let historySection = null;

  const LS_KEYS = {
    laps: 'pt_timer_recordedLaps',
    runners: 'pt_timer_runners',
    index: 'pt_timer_currentRunnerIndex',
    round: 'pt_timer_currentRound',
    roundLaps: 'pt_timer_roundLaps',
    awaitingRound: 'pt_timer_awaitingRound'
  };
  const beep = new Audio('beep.mp3');
  beep.preload = 'auto';
  let audioUnlocked = false;
  let runners = [];
  let currentRunnerIndex = 0;
  let currentRound = 1;
  let recordedLaps = [];
  let roundLaps = [];
  let timerState = 'stopped';
  let startTime = 0;
  let lastDisplayedTime = 0;
  let activeMethod = null;
  let startMethod = null;
  let awaitingNextRound = false;
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

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      const playback = beep.play();
      if (playback && playback.catch) playback.catch(() => {});
      beep.pause();
      beep.currentTime = 0;
    } catch (error) {}
  }

  function playBeep() {
    try {
      beep.currentTime = 0;
      const playback = beep.play();
      if (playback && playback.catch) playback.catch(() => {});
    } catch (error) {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  function saveLaps() {
    if (storageReadFailed) return false;
    try {
      localStorage.setItem(LS_KEYS.laps, JSON.stringify(recordedLaps));
      localStorage.setItem(LS_KEYS.runners, JSON.stringify(runners));
      localStorage.setItem(LS_KEYS.index, String(currentRunnerIndex));
      localStorage.setItem(LS_KEYS.round, String(currentRound));
      localStorage.setItem(LS_KEYS.roundLaps, JSON.stringify(roundLaps));
      localStorage.setItem(LS_KEYS.awaitingRound, String(awaitingNextRound));
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

  function validOriginalRecords(value) {
    return Array.isArray(value) ? value.filter(record =>
      record && typeof record === 'object' && Number.isFinite(Number(record.time))
    ) : [];
  }

  function normalizeOriginalRecord(record, fallbackRound) {
    let runnerIndex = record.runnerIndex !== null && record.runnerIndex !== '' &&
      Number.isInteger(Number(record.runnerIndex)) && Number(record.runnerIndex) >= 0
      ? Number(record.runnerIndex) : null;
    const savedName = typeof record.runnerName === 'string' ? record.runnerName : '';
    if (runnerIndex === null && savedName) {
      const matches = runners.map((runner, index) => ({ runner, index }))
        .filter(item => item.runner.name.trim().toLocaleLowerCase() === savedName.trim().toLocaleLowerCase());
      if (matches.length === 1) runnerIndex = matches[0].index;
    }
    const knownRunner = runnerIndex === null ? null : runners[runnerIndex];
    const round = Number.isInteger(Number(record.round)) && Number(record.round) > 0
      ? Number(record.round) : fallbackRound;
    return {
      ...record,
      time: Number(record.time),
      runnerName: savedName
        ? savedName
        : (knownRunner ? knownRunner.name : ''),
      ...(runnerIndex === null ? {} : { runnerIndex }),
      round,
      method: record.method || 'legacy'
    };
  }

  function sameRecordIdentity(first, second) {
    if (Number(first.round) !== Number(second.round) || Number(first.time) !== Number(second.time)) return false;
    const firstIndex = Number.isInteger(first.runnerIndex) ? first.runnerIndex : null;
    const secondIndex = Number.isInteger(second.runnerIndex) ? second.runnerIndex : null;
    if (firstIndex !== null && secondIndex !== null) return firstIndex === secondIndex;
    const firstName = String(first.runnerName || '').trim().toLocaleLowerCase();
    const secondName = String(second.runnerName || '').trim().toLocaleLowerCase();
    const identityName = firstName || secondName;
    if (identityName && runners.filter(runner =>
      runner.name.trim().toLocaleLowerCase() === identityName
    ).length > 1) return false;
    return Boolean(firstName && secondName && firstName === secondName);
  }

  function dedupeRecords(records) {
    const unique = [];
    records.forEach(record => {
      const duplicateIndex = unique.findIndex(existing => sameRecordIdentity(existing, record));
      if (duplicateIndex < 0) unique.push(record);
      else unique[duplicateIndex] = { ...unique[duplicateIndex], ...record };
    });
    return unique;
  }

  function loadLaps() {
    let loaded = true;
    try {
      const storedRunners = JSON.parse(localStorage.getItem(LS_KEYS.runners) || '[]');
      if (Array.isArray(storedRunners)) {
        runners = storedRunners.filter(runner => runner && typeof runner.name === 'string')
          .map((runner, index) => ({ id: runner.id || index + 1, name: runner.name }));
      }
      if (!runners.length) runners = [{ id: 1, name: 'Corredor 1' }];
      const index = Number.parseInt(localStorage.getItem(LS_KEYS.index), 10);
      const round = Number.parseInt(localStorage.getItem(LS_KEYS.round), 10);
      currentRunnerIndex = Number.isFinite(index) && index >= 0 ? index : 0;
      currentRound = Number.isFinite(round) && round > 0 ? round : 1;

      const current = localStorage.getItem(LS_KEYS.laps);
      if (current) {
        recordedLaps = validOriginalRecords(JSON.parse(current));
      } else {
        // The old shared key was also used by Loop; only object records belong here.
        const legacy = localStorage.getItem('recordedLaps');
        if (legacy) {
          recordedLaps = validOriginalRecords(JSON.parse(legacy));
        }
      }
      const storedRound = JSON.parse(localStorage.getItem(LS_KEYS.roundLaps) || '[]');
      const runnersPerRound = Math.max(1, runners.length);
      const historical = validOriginalRecords(recordedLaps).map((record, recordIndex) =>
        normalizeOriginalRecord(record, Math.floor(recordIndex / runnersPerRound) + 1)
      );
      roundLaps = validOriginalRecords(storedRound).map(record =>
        normalizeOriginalRecord(record, currentRound)
      );
      roundLaps = dedupeRecords(roundLaps);
      // Older Original releases only persisted the active round in roundLaps.
      // Merge it into the export/history set, deduplicating records also present
      // in recordedLaps from newer releases.
      recordedLaps = dedupeRecords([...historical, ...roundLaps]);
      awaitingNextRound = localStorage.getItem(LS_KEYS.awaitingRound) === 'true';
    } catch (error) {
      // Keep valid in-memory defaults; malformed historical data is never used to start a run.
      recordedLaps = Array.isArray(recordedLaps) ? recordedLaps : [];
      roundLaps = Array.isArray(roundLaps) ? roundLaps : [];
      loaded = false;
      storageReadFailed = true;
      warnStorage('No se pudo leer el historial guardado. Exporta los resultados disponibles antes de salir; la recuperación local no está confirmada.');
    }
    if (runners.length && currentRunnerIndex >= runners.length) currentRunnerIndex = 0;
    if (!runners.length) runners = [{ id: 1, name: 'Corredor 1' }];
    if (loaded) saveLaps();
    displayLaps();
  }

  function displayLaps() {
    displayRunnersList();
  }

  function measurementLabel(method) {
    if (method === 'automatic') return 'Automático';
    if (method === 'manual') return 'Manual';
    if (method === 'mixta') return 'Mixto';
    return 'Anterior';
  }

  function ensureHistorySection() {
    if (historySection) return;
    historySection = document.createElement('section');
    historySection.id = 'original-history-section';
    historyHeading.textContent = 'Historial reciente';
    historyHeading.id = 'original-history-heading';
    historyList.id = 'original-history-list';
    historyList.setAttribute('aria-labelledby', historyHeading.id);
    historySection.append(historyHeading, historyList);
    lapsContainer.appendChild(historySection);
  }

  function displayRunnersList() {
    // Original mode's primary list remains the current round order.
    if (!runners.length) return;
    ensureHistorySection();
    const roundHeading = lapsContainer.querySelector('h3');
    if (roundHeading) roundHeading.textContent = 'Ronda actual';
    lapsList.replaceChildren();
    runners.forEach((runner, index) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${runner.name}:`;
      const record = roundLaps.find(lap => lap.runnerIndex === index);
      const result = document.createElement('span');
      result.textContent = record ? formatTime(record.time) :
        (index === currentRunnerIndex && timerState === 'running' ? '→ EN CURSO' : '--:--.---');
      const method = document.createElement('span');
      method.className = 'timing-method-badge';
      method.textContent = record ? measurementLabel(record.method) : '';
      if (record) method.title = `Método de medición: ${measurementLabel(record.method)}`;
      if (record) item.style.color = '#10b981';
      else if (index === currentRunnerIndex && timerState === 'running') item.style.color = '#60a5fa';
      item.append(name, result, method);
      lapsList.appendChild(item);
    });
    const archived = recordedLaps.filter(record =>
      !roundLaps.some(currentRecord => sameRecordIdentity(currentRecord, record))
    ).slice(-8).reverse();
    historyList.replaceChildren();
    archived.forEach(record => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${record.runnerName || 'Corredor'} · Ronda ${record.round || '—'}`;
      const time = document.createElement('span');
      time.textContent = formatTime(record.time);
      const method = document.createElement('span');
      method.className = 'timing-method-badge';
      method.textContent = measurementLabel(record.method);
      method.title = `Método de medición: ${measurementLabel(record.method)}`;
      item.append(label, time, method);
      historyList.appendChild(item);
    });
    historySection.hidden = archived.length === 0;
    lapsContainer.style.display = 'block';
    lapsList.scrollTop = lapsList.scrollHeight;
  }

  function setTriggerLabel(text) {
    if (runtime && typeof runtime.setTriggerLabel === 'function') runtime.setTriggerLabel(text);
  }

  function updateReadyStatus(event = {}) {
    const runner = runners[currentRunnerIndex] || runners[0];
    const method = event.method || (runtime && runtime.method) || 'automatic';
    const methodLabel = method === 'manual' ? 'Manual' : 'Automático';
    statusMessage.textContent = awaitingNextRound
      ? `Original · ${methodLabel} · Ronda ${currentRound - 1} completada. Confirma para continuar.`
      : `Original · ${methodLabel} · Ronda ${currentRound} · Listo: ${runner ? runner.name : 'Corredor 1'}`;
    setTriggerLabel(timerState === 'running' ? 'Parar' : 'Iniciar');
  }

  function mergedMethod(previous, next) {
    if (!previous) return next || 'manual';
    return previous === next ? previous : 'mixta';
  }

  function onTrigger(event) {
    if (awaitingNextRound) {
      statusMessage.textContent = 'Confirma la ronda completada antes de continuar.';
      return;
    }
    const now = Number(event && event.now);
    if (!Number.isFinite(now)) return;
    const method = event.method === 'automatic' ? 'automatic' : 'manual';
    playBeep();
    if (timerState !== 'running') {
      startTime = now;
      timerState = 'running';
      startMethod = method;
      activeMethod = method;
      lastDisplayedTime = 0;
      statusMessage.textContent = `Ronda ${currentRound} · Corriendo: ${runners[currentRunnerIndex].name}`;
      timerDisplay.style.color = '#ff6b6b';
      displayRunnersList();
      setTriggerLabel('Parar');
      return;
    }

    const elapsed = Math.max(0, now - startTime);
    const methodForRecord = mergedMethod(startMethod, method);
    const runner = runners[currentRunnerIndex];
    const result = {
      time: elapsed,
      runnerName: runner.name,
      runnerIndex: currentRunnerIndex,
      round: currentRound,
      method: methodForRecord,
      timestamp: new Date().toISOString()
    };
    recordedLaps.push(result);
    roundLaps.push(result);
    lastDisplayedTime = elapsed;
    timerState = 'stopped';
    startTime = 0;
    activeMethod = null;
    startMethod = null;
    saveLaps();
    const isLast = currentRunnerIndex === runners.length - 1;
    if (isLast) {
      awaitingNextRound = true;
      currentRound += 1;
      statusMessage.textContent = `Ronda ${currentRound - 1} completada · ${runner.name}: ${formatTime(elapsed)} (${methodForRecord === 'automatic' ? 'automático' : methodForRecord === 'manual' ? 'manual' : 'mixto'})`;
      showRoundComplete();
    } else {
      currentRunnerIndex += 1;
      const nextRunner = runners[currentRunnerIndex];
      statusMessage.textContent = `${runner.name}: ${formatTime(elapsed)} · Siguiente: ${nextRunner.name}. Espera visible: 500 ms entre eventos.`;
      setTriggerLabel('Iniciar');
    }
    saveLaps();
    displayRunnersList();
    timerDisplay.textContent = formatTime(elapsed);
    timerDisplay.style.color = '#e2e8f0';
  }

  function showRoundComplete() {
    messageContent.textContent = `¡Ronda ${currentRound - 1} completada! Todos los corredores han pasado. Pulsa OK para iniciar la ronda ${currentRound}.`;
    messageBox.style.display = 'block';
    messageBoxOkButton.onclick = () => {
      messageBox.style.display = 'none';
      roundLaps = [];
      currentRunnerIndex = 0;
      awaitingNextRound = false;
      timerDisplay.textContent = '00:00.000';
      timerDisplay.style.color = '#e2e8f0';
      saveLaps();
      displayRunnersList();
      updateReadyStatus();
    };
  }

  function handleFrame(now) {
    if (timerState === 'running') {
      const elapsed = Math.max(0, now - startTime);
      timerDisplay.textContent = formatTime(elapsed);
      timerDisplay.style.color = elapsed < 500 ? '#ff6b6b' : '#00d4ff';
    } else if (!awaitingNextRound) {
      timerDisplay.textContent = formatTime(lastDisplayedTime);
    }
  }

  function handleInterrupt(reason) {
    if (timerState === 'running') {
      timerState = 'stopped';
      startTime = 0;
      lastDisplayedTime = 0;
      startMethod = null;
      activeMethod = null;
      timerDisplay.textContent = '00:00.000';
      timerDisplay.style.color = '#e2e8f0';
      displayRunnersList();
      setTriggerLabel('Iniciar');
    }
    statusMessage.textContent = `Medición interrumpida (${reason || 'detección perdida'}). El tiempo incompleto se descartó; el historial se conserva.`;
  }

  function ensureRuntime() {
    if (runtime) return true;
    if (!window.PaceTrackTiming || typeof window.PaceTrackTiming.create !== 'function') {
      statusMessage.textContent = 'No se pudo cargar el módulo de cronometraje.';
      return false;
    }
    runtime = window.PaceTrackTiming.create({
      mode: 'original',
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
      hasUnsavedData: () => Boolean(storageWarning && (recordedLaps.length || roundLaps.length))
    });
    if (storageWarning) updateStorageSync();
    return true;
  }

  function downloadCSV() {
    const entries = [...recordedLaps];
    if (!entries.length) return showMessageBox('No hay tiempos para exportar.');
    const quote = value => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const rows = [['Ronda', 'Corredor', 'Tiempo (ms)', 'Tiempo', 'Método']];
    entries.forEach(record => rows.push([
      record.round || '',
      record.runnerName || '',
      Math.round(Number(record.time) || 0),
      formatTime(record.time),
      record.method || 'legacy'
    ]));
    const blob = new Blob(['\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8'
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `reporte_tiempos_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function downloadPDF() {
    if (!recordedLaps.length) return showMessageBox('No hay tiempos para exportar.');
    if (!window.jspdf || !window.jspdf.jsPDF) {
      showMessageBox('PDF no disponible sin conexión. Usa «Descargar CSV» para guardar los resultados.');
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.text('REPORTE DE TIEMPOS POR RONDAS', 105, 18, { align: 'center' });
    doc.setFontSize(10);
    doc.text(`Generado: ${new Date().toLocaleDateString()}`, 20, 28);
    let y = 40;
    const groups = new Map();
    recordedLaps.forEach(record => {
      const round = record.round || 'Historial anterior';
      if (!groups.has(round)) groups.set(round, []);
      groups.get(round).push(record);
    });
    groups.forEach((records, round) => {
      if (y > 265) { doc.addPage(); y = 20; }
      doc.setFontSize(13);
      doc.setTextColor(0, 51, 153);
      doc.text(`Ronda ${round}`, 20, y);
      y += 8;
      doc.setFontSize(9);
      doc.setTextColor(0, 0, 0);
      records.forEach(record => {
        if (y > 280) { doc.addPage(); y = 20; }
        const method = record.method === 'automatic' ? 'Automático' :
          record.method === 'manual' ? 'Manual' : (record.method || 'Anterior');
        doc.text(`${record.runnerName || 'Corredor'}: ${formatTime(record.time)} · ${method}`, 25, y);
        y += 6;
      });
      y += 5;
    });
    doc.save(`reporte_rondas_${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  function addPersistentActionButton(id, label, handler, className, parent = controls) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener('click', handler);
    parent.appendChild(button);
    return button;
  }

  function setupOptionalButtons() {
    if (document.getElementById('download-pdf')) return;
    const actions = document.createElement('div');
    actions.className = 'timer-history-actions';
    actions.style.cssText = 'display:flex;flex:1 1 100%;flex-wrap:wrap;gap:8px;justify-content:center;max-height:22vh;overflow:auto;';
    controls.appendChild(actions);
    addPersistentActionButton('download-pdf', 'Descargar PDF', downloadPDF, 'gradient-purple', actions);
    addPersistentActionButton('download-csv', 'Descargar CSV', downloadCSV, 'gradient-blue', actions);
    addPersistentActionButton('configure-runners', 'Nombres / Excel', openConfiguration, 'gradient-green', actions);
  }

  function setUpNamesForm() {
    const container = document.getElementById('names-input-container');
    container.replaceChildren();
    const existing = runners.length ? runners : [{ name: 'Corredor 1' }];
    existing.forEach((runner, index) => appendNameInput(container, runner.name, index));
    const add = document.createElement('button');
    add.id = 'add-runner-btn';
    add.type = 'button';
    add.className = 'gradient-blue';
    add.textContent = '+ Agregar';
    add.addEventListener('click', () => appendNameInput(container, '', container.querySelectorAll('input').length));
    container.appendChild(add);
  }

  function appendNameInput(container, value, index) {
    const group = document.createElement('div');
    group.className = 'name-input-group';
    const label = document.createElement('label');
    label.textContent = `Corredor ${index + 1}:`;
    label.htmlFor = `runner-${index}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Nombre';
    input.id = `runner-${index}`;
    input.value = value || '';
    group.append(label, input);
    const addButton = container.querySelector('#add-runner-btn');
    if (addButton) container.insertBefore(group, addButton);
    else container.appendChild(group);
  }

  function openConfiguration() {
    if (timerState === 'running') {
      showMessageBox('Termina o interrumpe la medición antes de cambiar la configuración.');
      return;
    }
    document.getElementById('setup-modal').style.display = 'flex';
  }

  function confirmReplaceConfiguration(nextRunners) {
    if (timerState === 'running') {
      showMessageBox('Termina o interrumpe la medición antes de cambiar la lista.');
      return false;
    }
    if (recordedLaps.length && !window.confirm('Hay resultados guardados. Cambiar la lista conservará el historial, pero reiniciará el avance de la ronda actual. ¿Continuar?')) return false;
    runners = nextRunners;
    currentRunnerIndex = 0;
    roundLaps = [];
    awaitingNextRound = false;
    timerState = 'stopped';
    startTime = 0;
    lastDisplayedTime = 0;
    saveLaps();
    displayRunnersList();
    updateReadyStatus();
    return true;
  }

  function setupWithNames() {
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('names-modal').style.display = 'flex';
    setUpNamesForm();
  }

  function saveRunnerNames() {
    const next = [...document.querySelectorAll('#names-input-container input')].map((input, index) => ({
      id: index + 1,
      name: input.value.trim() || `Corredor ${index + 1}`
    }));
    if (!next.length) return showMessageBox('Añade al menos un corredor.');
    if (confirmReplaceConfiguration(next)) {
      document.getElementById('names-modal').style.display = 'none';
      document.getElementById('app-container').style.display = 'flex';
    }
  }

  function setupWithExcel() {
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('excel-modal').style.display = 'flex';
    document.getElementById('excel-file').value = '';
    document.getElementById('excel-preview').style.display = 'none';
    document.getElementById('names-list').replaceChildren();
    window.tempExcelNames = null;
  }

  function processExcelFile() {
    const file = document.getElementById('excel-file').files[0];
    if (!file) return showMessageBox('Selecciona un archivo Excel.');
    const reader = new FileReader();
    reader.onload = event => {
      try {
        const workbook = XLSX.read(new Uint8Array(event.target.result), { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        const names = rows.map(row => row && row[0] != null ? String(row[0]).trim() : '').filter(Boolean);
        if (!names.length) return showMessageBox('No se encontraron nombres en el archivo.');
        const list = document.getElementById('names-list');
        list.replaceChildren();
        names.forEach((name, index) => {
          const item = document.createElement('li');
          item.textContent = `${index + 1}. ${name}`;
          list.appendChild(item);
        });
        window.tempExcelNames = names;
        document.getElementById('excel-preview').style.display = 'block';
      } catch (error) {
        showMessageBox('No se pudo procesar el archivo Excel.');
      }
    };
    reader.onerror = () => showMessageBox('No se pudo leer el archivo.');
    reader.readAsArrayBuffer(file);
  }

  function saveExcelNames() {
    if (!Array.isArray(window.tempExcelNames) || !window.tempExcelNames.length) {
      return showMessageBox('Procesa primero un archivo Excel válido.');
    }
    const next = window.tempExcelNames.map((name, index) => ({ id: index + 1, name }));
    if (confirmReplaceConfiguration(next)) {
      document.getElementById('excel-modal').style.display = 'none';
      document.getElementById('app-container').style.display = 'flex';
      window.tempExcelNames = null;
    }
  }

  function clearCompletedData() {
    const hasData = recordedLaps.length || roundLaps.length;
    if ((hasData || timerState === 'running') &&
      !window.confirm('Esto borrará los resultados guardados y descartará cualquier medición incompleta. ¿Continuar?')) return;
    recordedLaps = [];
    roundLaps = [];
    currentRunnerIndex = 0;
    currentRound = 1;
    awaitingNextRound = false;
    timerState = 'stopped';
    startTime = 0;
    lastDisplayedTime = 0;
    startMethod = null;
    activeMethod = null;
    let storageCleared = true;
    try {
      Object.values(LS_KEYS).forEach(key => localStorage.removeItem(key));
    } catch (error) {
      storageCleared = false;
      warnStorage('No se pudo borrar el historial local. Exporta antes de salir; la recuperación local no está confirmada.');
    }
    if (storageCleared) {
      storageReadFailed = false;
      storageWarning = '';
    }
    saveLaps();
    displayRunnersList();
    timerDisplay.textContent = '00:00.000';
    timerDisplay.style.color = '#e2e8f0';
    updateReadyStatus();
    if (runtime) {
      runtime.stop();
      runtime.prepare();
    }
  }

  resetButton.addEventListener('click', clearCompletedData);
  messageBoxOkButton.onclick = () => { messageBox.style.display = 'none'; };
  document.getElementById('setup-with-names').addEventListener('click', setupWithNames);
  document.getElementById('setup-without-names').addEventListener('click', () => {
    if (confirmReplaceConfiguration([{ id: 1, name: 'Corredor 1' }])) {
      document.getElementById('setup-modal').style.display = 'none';
    }
  });
  document.getElementById('setup-with-excel').addEventListener('click', setupWithExcel);
  document.getElementById('save-names').addEventListener('click', saveRunnerNames);
  document.getElementById('cancel-names').addEventListener('click', () => {
    document.getElementById('names-modal').style.display = 'none';
    document.getElementById('setup-modal').style.display = 'flex';
  });
  document.getElementById('excel-file').addEventListener('change', processExcelFile);
  document.getElementById('process-excel').addEventListener('click', saveExcelNames);
  document.getElementById('cancel-excel').addEventListener('click', () => {
    document.getElementById('excel-modal').style.display = 'none';
    document.getElementById('setup-modal').style.display = 'flex';
    window.tempExcelNames = null;
  });
  function bootApp() {
    if (booted) return;
    booted = true;
    loadLaps();
    document.getElementById('app-container').style.display = 'flex';
    document.getElementById('setup-modal').style.display = 'none';
    setupOptionalButtons();
    updateReadyStatus();
    ensureRuntime();
    if (awaitingNextRound) showRoundComplete();
  }

  const pdfScript = document.createElement('script');
  pdfScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  document.head.appendChild(pdfScript);
  bootApp();
})();