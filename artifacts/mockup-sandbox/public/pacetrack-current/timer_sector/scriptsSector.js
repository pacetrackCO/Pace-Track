// === VARIABLES ===
const video = document.getElementById('video');
const overlayCanvas = document.getElementById('overlay-canvas');
const timerDisplay = document.getElementById('timer-display');
const statusMessage = document.getElementById('status-message');
const resetButton = document.getElementById('reset-button');
const sensitivitySlider = document.getElementById('sensitivity-slider');
const messageBox = document.getElementById('message-box');
const messageContent = document.getElementById('message-content');
const messageBoxOkButton = document.getElementById('message-box-ok');
const lapsContainer = document.getElementById('laps-container');
const lapsList = document.getElementById('laps-list');
const lapsTitle = document.getElementById('laps-title');
const hiddenCanvas = document.createElement('canvas');
const hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
const overlayCtx = overlayCanvas.getContext('2d');

const beep = new Audio('Beep.mp3');
beep.preload = 'auto';
let audioUnlocked = false;
document.addEventListener('pointerdown', () => {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
        const p = beep.play();
        if (p && p.catch) p.catch(() => {});
        beep.pause();
        beep.currentTime = 0;
    } catch (e) {}
}, { once: true });
function playBeep() {
    try {
        beep.currentTime = 0;
        const p = beep.play();
        if (p && p.catch) p.catch(() => {});
    } catch (e) {}
}

// La señalización Firebase está desactivada en esta vista previa.
// === VARIABLES P2P ===
let pc = null;
let dataChannel = null;
let currentRoomRef = null;
let answerListener = null;
let hostCandidatesListener = null;
let guestCandidatesListener = null;
let role = null; // 'start' (salida) o 'stop' (llegada)

// === ESTADO ===
let runners = [];
let currentRunnerIndex = 0;
let currentRound = 1;
let timerState = 'stopped'; // stopped, running, paused
let startTime = 0;
let lastDisplayedTime = 0;
let previousFrameData = null;
let detectionThreshold = 100;
let lastDetectionTime = 0;
const detectionCooldown = 500;
let isCalibrating = true;
let calibrationSamples = [];
const calibrationDuration = 3000;
let recordedLaps = [];           // persistente (para PDF)
let cooldownActive = false;
let cooldownEndTime = 0;
const cooldownDuration = 3000;
let roundLaps = [];              // tiempos de la ronda actual (solo en llegada)
let volatileLaps = [];            // tiempos mostrados en salida (volátil)

// === UTILIDADES ===
function formatTime(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const c = Math.floor(ms % 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(3, '0')}`;
}

function showMessageBox(msg) {
    messageContent.textContent = msg;
    messageBox.style.display = 'block';
}

// Claves con espacio de nombres (no chocar con original/loop en el mismo dominio)
const LS_KEYS = {
    laps: 'pt_sector_recordedLaps',
    runners: 'pt_sector_runners',
    index: 'pt_sector_currentRunnerIndex',
    round: 'pt_sector_currentRound',
    roundLaps: 'pt_sector_roundLaps'
};
function saveLaps() {
    try {
        localStorage.setItem(LS_KEYS.laps, JSON.stringify(recordedLaps));
        localStorage.setItem(LS_KEYS.runners, JSON.stringify(runners));
        localStorage.setItem(LS_KEYS.index, String(currentRunnerIndex));
        localStorage.setItem(LS_KEYS.round, String(currentRound));
        localStorage.setItem(LS_KEYS.roundLaps, JSON.stringify(roundLaps));
    } catch (e) {}
}

function loadLaps() {
    try {
        const legacy = localStorage.getItem('recordedLaps');
        if (legacy && !localStorage.getItem(LS_KEYS.laps)) {
            localStorage.setItem(LS_KEYS.laps, legacy);
            const lr = localStorage.getItem('runners'); if (lr) localStorage.setItem(LS_KEYS.runners, lr);
            const li = localStorage.getItem('currentRunnerIndex'); if (li) localStorage.setItem(LS_KEYS.index, li);
            const lro = localStorage.getItem('currentRound'); if (lro) localStorage.setItem(LS_KEYS.round, lro);
            const lrl = localStorage.getItem('roundLaps'); if (lrl) localStorage.setItem(LS_KEYS.roundLaps, lrl);
        }
        const data = localStorage.getItem(LS_KEYS.laps);
        if (data) recordedLaps = JSON.parse(data);
        const r = localStorage.getItem(LS_KEYS.runners);
        if (r) runners = JSON.parse(r);
        const i = localStorage.getItem(LS_KEYS.index);
        if (i !== null) currentRunnerIndex = parseInt(i) || 0;
        const round = localStorage.getItem(LS_KEYS.round);
        if (round !== null) currentRound = parseInt(round) || 1;
        const rl = localStorage.getItem(LS_KEYS.roundLaps);
        if (rl) roundLaps = JSON.parse(rl);
    } catch (e) {}
    displayLaps();
}

// Muestra la lista según el rol
function displayLaps() {
    if (!lapsContainer) return;
    if (runners.length === 0) {
        lapsContainer.style.display = 'none';
        return;
    }
    lapsContainer.style.display = 'block';
    lapsList.innerHTML = '';

    // Actualizar indicador de rol en el panel P2P
    const roleIndicator = document.getElementById('p2p-role-indicator');
    if (roleIndicator) {
        if (role === 'start') roleIndicator.textContent = '(SALIDA)';
        else if (role === 'stop') roleIndicator.textContent = '(LLEGADA)';
        else roleIndicator.textContent = '';
    }

    if (role === 'stop') {
        // Vista de llegada: corredores con estado (guardado)
        lapsTitle.textContent = 'Tiempos de la ronda';
        runners.forEach((runner, index) => {
            const li = document.createElement('li');
            const lapRecord = roundLaps.find(lap => lap.runnerIndex === index);
            if (lapRecord) {
                li.innerHTML = `<span>${runner.name}:</span> <span>${formatTime(lapRecord.time)}</span>`;
                li.style.color = '#10b981';
                li.style.fontWeight = '600';
            } else if (index === currentRunnerIndex && timerState === 'running') {
                li.innerHTML = `<span>${runner.name}:</span> <span>→ EN CURSO</span>`;
                li.style.color = '#3b82f6';
                li.style.fontWeight = '700';
            } else {
                li.innerHTML = `<span>${runner.name}:</span> <span>--:--.---</span>`;
                li.style.color = '#9ca3af';
            }
            lapsList.appendChild(li);
        });
    } else if (role === 'start') {
        // Vista de salida: lista volátil de tiempos recibidos
        lapsTitle.textContent = 'Pasos registrados (salida)';
        if (volatileLaps.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'Aún no hay pasos';
            li.style.color = '#9ca3af';
            lapsList.appendChild(li);
        } else {
            volatileLaps.forEach((lap, i) => {
                const li = document.createElement('li');
                li.innerHTML = `<span>${i + 1}. ${lap.runnerName}:</span> <span>${formatTime(lap.time)}</span>`;
                li.style.color = '#10b981';
                lapsList.appendChild(li);
            });
        }
    } else {
        // Sin rol: mostrar como llegada (lista de corredores con tiempos de la ronda actual)
        lapsTitle.textContent = 'Tiempos de la ronda';
        runners.forEach((runner, index) => {
            const li = document.createElement('li');
            const lapRecord = roundLaps.find(lap => lap.runnerIndex === index);
            if (lapRecord) {
                li.innerHTML = `<span>${runner.name}:</span> <span>${formatTime(lapRecord.time)}</span>`;
                li.style.color = '#10b981';
                li.style.fontWeight = '600';
            } else if (index === currentRunnerIndex && timerState === 'running') {
                li.innerHTML = `<span>${runner.name}:</span> <span>→ EN CURSO</span>`;
                li.style.color = '#3b82f6';
                li.style.fontWeight = '700';
            } else {
                li.innerHTML = `<span>${runner.name}:</span> <span>--:--.---</span>`;
                li.style.color = '#9ca3af';
            }
            lapsList.appendChild(li);
        });
    }
    lapsList.scrollTop = lapsList.scrollHeight;
}

function drawLine(color = 'rgba(255,0,0,0.7)', flash = false) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.drawImage(video, 0, 0);
    const x = overlayCanvas.width * 0.5;
    const w = overlayCanvas.width * 0.05;
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = 6;
    overlayCtx.beginPath();
    overlayCtx.moveTo(x - w / 2, 0); overlayCtx.lineTo(x - w / 2, overlayCanvas.height);
    overlayCtx.moveTo(x + w / 2, 0); overlayCtx.lineTo(x + w / 2, overlayCanvas.height);
    overlayCtx.stroke();
    if (flash) {
        overlayCanvas.style.filter = 'brightness(1.5)';
        setTimeout(() => overlayCanvas.style.filter = '', 200);
    }
}

function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }

function startCooldown() {
    cooldownActive = true;
    cooldownEndTime = performance.now() + cooldownDuration;
    timerState = 'paused';
    statusMessage.textContent = `Esperando ${cooldownDuration / 1000}s...`;
    timerDisplay.style.color = 'orange';
    displayLaps();

    const updateCooldownDisplay = () => {
        if (cooldownActive) {
            const remaining = cooldownEndTime - performance.now();
            if (remaining > 0) {
                timerDisplay.textContent = formatTime(remaining);
                requestAnimationFrame(updateCooldownDisplay);
            } else {
                cooldownActive = false;
                timerState = 'stopped';
                const nextRunner = runners[currentRunnerIndex];
                statusMessage.textContent = `Listo: ${nextRunner.name}`;
                timerDisplay.textContent = '00:00.000';
                timerDisplay.style.color = '#e2e8f0';
                lastDisplayedTime = 0;
                displayLaps();
            }
        }
    };
    updateCooldownDisplay();
}

function startNewRound() {
    recordedLaps.push(...roundLaps);
    roundLaps = [];
    currentRunnerIndex = 0;
    timerState = 'stopped';
    statusMessage.textContent = `Ronda ${currentRound} - Listo: ${runners[0].name}`;
    timerDisplay.textContent = '00:00.000';
    timerDisplay.style.color = '#e2e8f0';
    saveLaps();
    displayLaps();
}

// === FUNCIONES PARA EXCEL ===
function setupWithExcel() {
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('excel-modal').style.display = 'flex';
    document.getElementById('excel-file').value = '';
    document.getElementById('excel-preview').style.display = 'none';
    document.getElementById('names-list').innerHTML = '';
}

function processExcelFile() {
    const fileInput = document.getElementById('excel-file');
    const preview = document.getElementById('excel-preview');
    const namesList = document.getElementById('names-list');
    if (!fileInput.files.length) {
        showMessageBox('Por favor seleccione un archivo Excel');
        return;
    }
    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
            const names = [];
            jsonData.forEach(row => {
                if (row.length > 0 && row[0] && String(row[0]).trim()) {
                    names.push(String(row[0]).trim());
                }
            });
            if (names.length === 0) {
                showMessageBox('No se encontraron nombres en el archivo');
                return;
            }
            namesList.innerHTML = '';
            names.forEach((name, index) => {
                const li = document.createElement('li');
                li.textContent = `${index + 1}. ${name}`;
                namesList.appendChild(li);
            });
            preview.style.display = 'block';
            window.tempExcelNames = names;
        } catch (error) {
            console.error('Error procesando Excel:', error);
            showMessageBox('Error al procesar el archivo Excel');
        }
    };
    reader.onerror = () => showMessageBox('Error al leer el archivo');
    reader.readAsArrayBuffer(file);
}

function saveExcelNames() {
    if (!window.tempExcelNames || window.tempExcelNames.length === 0) {
        showMessageBox('No hay nombres para guardar');
        return;
    }
    runners = window.tempExcelNames.map((name, index) => ({ id: index + 1, name }));
    currentRunnerIndex = 0;
    currentRound = 1;
    recordedLaps = [];
    roundLaps = [];
    document.getElementById('excel-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    saveLaps();
    setupCamera();
    createButtons();
    statusMessage.textContent = `Ronda 1 - Listo: ${runners[0].name}`;
    displayLaps();
    window.tempExcelNames = null;
}

// === SETUP ===
function setupWithNames() {
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('names-modal').style.display = 'flex';
    document.getElementById('names-input-container').innerHTML = `
        <div class="name-input-group">
            <label>Corredor 1:</label>
            <input type="text" placeholder="Nombre" id="runner-0">
        </div>
        <button id="add-runner-btn" class="gradient-blue">+ Agregar</button>
    `;
    document.getElementById('add-runner-btn').onclick = () => {
        const count = document.querySelectorAll('.name-input-group').length;
        const div = document.createElement('div');
        div.className = 'name-input-group';
        div.innerHTML = `<label>Corredor ${count + 1}:</label><input type="text" placeholder="Nombre" id="runner-${count}">`;
        document.getElementById('add-runner-btn').before(div);
    };
}

function saveRunnerNames() {
    runners = [];
    document.querySelectorAll('#names-input-container input').forEach((inp, i) => {
        const name = inp.value.trim() || `Corredor ${i + 1}`;
        runners.push({ id: i + 1, name });
    });
    currentRunnerIndex = 0;
    currentRound = 1;
    recordedLaps = [];
    roundLaps = [];
    document.getElementById('names-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    saveLaps();
    setupCamera();
    createButtons();
    statusMessage.textContent = `Ronda 1 - Listo: ${runners[0].name}`;
    displayLaps();
}

function setupWithoutNames() {
    runners = [{ id: 1, name: 'Corredor 1' }];
    currentRunnerIndex = 0;
    currentRound = 1;
    recordedLaps = [];
    roundLaps = [];
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    saveLaps();
    setupCamera();
    createButtons();
    statusMessage.textContent = `Ronda 1 - Listo: ${runners[0].name}`;
    displayLaps();
}

function createButtons() {
    if (document.getElementById('download-pdf')) return;

    const dl = document.createElement('button');
    dl.id = 'download-pdf';
    dl.textContent = 'Descargar PDF';
    dl.className = 'gradient-purple';
    dl.onclick = () => {
        if (recordedLaps.length === 0 && roundLaps.length === 0) return showMessageBox('No hay tiempos');
        if (!window.jspdf || !window.jspdf.jsPDF) return showMessageBox('PDF no disponible sin conexión. Revisa tu internet y recarga.');
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        doc.setFontSize(20);
        doc.text('REPORTE DE TIEMPOS POR RONDAS', 105, 20, { align: 'center' });
        doc.setFontSize(10);
        doc.text(`Generado: ${new Date().toLocaleDateString()}`, 20, 30);
        const lapsPerRound = runners.length;
        const totalRounds = Math.ceil(recordedLaps.length / lapsPerRound);
        let y = 45;
        for (let round = 1; round <= totalRounds; round++) {
            const startIndex = (round - 1) * lapsPerRound;
            const endIndex = Math.min(startIndex + lapsPerRound, recordedLaps.length);
            const roundLaps = recordedLaps.slice(startIndex, endIndex);
            doc.setFontSize(14);
            doc.setTextColor(0, 51, 153);
            doc.text(`Ronda ${round}`, 20, y);
            y += 8;
            doc.setFontSize(10);
            doc.setTextColor(0, 0, 0);
            roundLaps.forEach((lap, index) => {
                doc.text(`${index + 1}. ${lap.runnerName}: ${formatTime(lap.time)}`, 25, y);
                y += 6;
            });
            y += 8;
            if (y > 270 && round < totalRounds) {
                doc.addPage();
                y = 20;
            }
        }
        doc.setFontSize(12);
        doc.setTextColor(0, 0, 0);
        doc.text(`Total de rondas: ${totalRounds}`, 20, y + 5);
        doc.text(`Total de tiempos registrados: ${recordedLaps.length}`, 20, y + 12);
        doc.save(`reporte_rondas_${new Date().toISOString().split('T')[0]}.pdf`);
        showMessageBox('PDF descargado');
    };

    const add = document.createElement('button');
    add.textContent = '+ Corredor';
    add.className = 'gradient-green';
    add.onclick = () => {
        const n = runners.length + 1;
        runners.push({ id: n, name: `Corredor ${n}` });
        saveLaps();
        showMessageBox(`+ Corredor ${n}`);
        displayLaps();
    };

    resetButton.after(dl);
    dl.after(add);
}

// === CÁMARA ===
async function setupCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream;
        await new Promise(r => video.onloadedmetadata = r);
        [hiddenCanvas, overlayCanvas].forEach(c => {
            c.width = video.videoWidth;
            c.height = video.videoHeight;
        });
        startCalibration();
        requestAnimationFrame(detectMovement);
    } catch (e) {
        showMessageBox('Error: Cámara no disponible');
    }
}

function startCalibration() {
    isCalibrating = true;
    calibrationSamples = [];
    timerDisplay.textContent = 'CALIBRANDO';
    timerDisplay.style.color = 'yellow';
    setTimeout(() => {
        const avg = calibrationSamples.length ? calibrationSamples.reduce((a, b) => a + b, 0) / calibrationSamples.length : 0;
        detectionThreshold = Math.max(60, Math.min(400, avg * 2 + 30));
        sensitivitySlider.value = detectionThreshold;
        isCalibrating = false;
        timerDisplay.textContent = '00:00.000';
        timerDisplay.style.color = '#e2e8f0';
        displayLaps();
    }, calibrationDuration);
}

// === FUNCIONES P2P ===
function getIceConfiguration() {
    return {
        iceServers: [
            { urls: "stun:stun.relay.metered.ca:80" },
            {
                urls: "turn:global.relay.metered.ca:80",
                username: "c1208ba0e8230537122cf693",
                credential: "U4ffWBruWxpMqEir"
            },
            {
                urls: "turn:global.relay.metered.ca:80?transport=tcp",
                username: "c1208ba0e8230537122cf693",
                credential: "U4ffWBruWxpMqEir"
            },
            {
                urls: "turn:global.relay.metered.ca:443",
                username: "c1208ba0e8230537122cf693",
                credential: "U4ffWBruWxpMqEir"
            },
            {
                urls: "turns:global.relay.metered.ca:443?transport=tcp",
                username: "c1208ba0e8230537122cf693",
                credential: "U4ffWBruWxpMqEir"
            }
        ],
        iceCandidatePoolSize: 10
    };
}

function cleanupRTC() {
    if (pc) {
        pc.close();
        pc = null;
    }
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    if (answerListener && currentRoomRef) {
        currentRoomRef.child('answer').off('value', answerListener);
        answerListener = null;
    }
    if (hostCandidatesListener && currentRoomRef) {
        currentRoomRef.child('hostCandidates').off('child_added', hostCandidatesListener);
        hostCandidatesListener = null;
    }
    if (guestCandidatesListener && currentRoomRef) {
        currentRoomRef.child('guestCandidates').off('child_added', guestCandidatesListener);
        guestCandidatesListener = null;
    }
    currentRoomRef = null;
    document.getElementById('p2p-status').innerText = '🔴 Desconectado';
    role = null;
    displayLaps();
}

function setupDataChannelEvents() {
    if (!dataChannel) return;
    dataChannel.onopen = () => {
        document.getElementById('p2p-status').innerText = '✅ Conectado';
        document.getElementById('p2p-create').disabled = true;
        document.getElementById('p2p-join').disabled = true;
        displayLaps();
    };
    dataChannel.onclose = () => {
        document.getElementById('p2p-status').innerText = '❌ Cerrado';
        document.getElementById('p2p-create').disabled = false;
        document.getElementById('p2p-join').disabled = false;
        role = null;
        displayLaps();
    };
    dataChannel.onerror = (err) => console.error('DataChannel error:', err);
    dataChannel.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 'timing' && data.val === 'START' && role === 'stop') {
                // Iniciar cronómetro en llegada
                startTime = performance.now();
                timerState = 'running';
                statusMessage.textContent = '¡CORRIENDO!';
                timerDisplay.style.color = '#ff4444';
                displayLaps();
            } else if (data.type === 'lap' && role === 'start') {
                // Recibir tiempo desde llegada y mostrarlo en salida
                volatileLaps.push({ time: data.time, runnerName: data.runnerName });
                displayLaps();
            }
        } catch (err) {
            console.warn('Mensaje no válido:', e.data);
        }
    };
}

async function createRoom(roomId) {
    showMessageBox('Vista previa: la conexión entre dispositivos requiere la señalización externa y está desactivada.');
    document.getElementById('p2p-status').innerText = 'Vista previa: sincronización no disponible';
}

async function joinRoom(roomId) {
    showMessageBox('Vista previa: la conexión entre dispositivos requiere la señalización externa y está desactivada.');
    document.getElementById('p2p-status').innerText = 'Vista previa: sincronización no disponible';
}

function sendStartSignal() {
    if (dataChannel && dataChannel.readyState === 'open' && role === 'start') {
        dataChannel.send(JSON.stringify({ type: 'timing', val: 'START' }));
        statusMessage.textContent = 'Señal START enviada';
    }
}

// === DETECCIÓN DE MOVIMIENTO ===
function detectMovement() {
    if (!video.videoWidth) {
        requestAnimationFrame(detectMovement);
        return;
    }

    hiddenCtx.drawImage(video, 0, 0);
    drawLine();

    const x1 = hiddenCanvas.width * 0.475;
    const w = hiddenCanvas.width * 0.05;
    const frame = hiddenCtx.getImageData(x1, 0, w, hiddenCanvas.height);

    if (previousFrameData && frame.data.length === previousFrameData.data.length) {
        let diff = 0;
        for (let i = 0; i < frame.data.length; i += 4) {
            diff += Math.abs(frame.data[i] - previousFrameData.data[i]);
            diff += Math.abs(frame.data[i + 1] - previousFrameData.data[i + 1]);
            diff += Math.abs(frame.data[i + 2] - previousFrameData.data[i + 2]);
        }
        const norm = diff / (frame.data.length / 4);

        if (isCalibrating) {
            calibrationSamples.push(norm);
        } else if (!cooldownActive && timerState !== 'paused' && norm > detectionThreshold && (performance.now() - lastDetectionTime) > detectionCooldown) {
            lastDetectionTime = performance.now();
            playBeep();
            drawLine('lime', true);
            vibrate(200);

            if (role === 'start') {
                // Salida: enviar START
                sendStartSignal();
                statusMessage.textContent = 'Movimiento - START enviado';
            } else if (role === 'stop') {
                // Llegada: detener crono si está corriendo
                if (timerState === 'running') {
                    const elapsed = performance.now() - startTime;
                    const runner = runners[currentRunnerIndex];

                    if (elapsed < 3000) {
                        statusMessage.textContent = 'Vuelta muy rápida';
                        drawLine('yellow', true);
                    } else {
                        // Vuelta válida
                        roundLaps.push({ time: elapsed, runnerName: runner.name, runnerIndex: currentRunnerIndex });
                        saveLaps();

                        // Enviar tiempo al dispositivo de salida
                        if (dataChannel && dataChannel.readyState === 'open') {
                            dataChannel.send(JSON.stringify({ type: 'lap', time: elapsed, runnerName: runner.name }));
                        }

                        const wasLast = currentRunnerIndex === runners.length - 1;

                        if (wasLast) {
                            currentRound++;
                            showMessageBox(`¡RONDA ${currentRound - 1} COMPLETADA!\n\nPulsa OK para la RONDA ${currentRound}`);
                            timerState = 'paused';
                            statusMessage.textContent = 'Esperando...';
                            messageBoxOkButton.onclick = () => {
                                messageBox.style.display = 'none';
                                startNewRound();
                                messageBoxOkButton.onclick = () => messageBox.style.display = 'none';
                            };
                        } else {
                            currentRunnerIndex++;
                            const next = runners[currentRunnerIndex];
                            statusMessage.textContent = `${runner.name} → ${formatTime(elapsed)} | Siguiente: ${next.name}`;
                            startCooldown();
                        }

                        timerState = 'stopped';
                        lastDisplayedTime = elapsed;
                        timerDisplay.style.color = '#e2e8f0';
                        displayLaps();
                    }
                } else {
                    statusMessage.textContent = 'Movimiento ignorado (no corriendo)';
                }
            } else {
                // Modo sin P2P
                if (timerState === 'stopped') {
                    startTime = performance.now();
                    timerState = 'running';
                    statusMessage.textContent = '¡CORRIENDO!';
                    timerDisplay.style.color = '#ff4444';
                    displayLaps();
                } else {
                    const elapsed = performance.now() - startTime;
                    const runner = runners[currentRunnerIndex];

                    if (elapsed < 3000) {
                        statusMessage.textContent = 'Vuelta muy rápida';
                        drawLine('yellow', true);
                    } else {
                        roundLaps.push({ time: elapsed, runnerName: runner.name, runnerIndex: currentRunnerIndex });
                        saveLaps();

                        const wasLast = currentRunnerIndex === runners.length - 1;

                        if (wasLast) {
                            currentRound++;
                            showMessageBox(`¡RONDA ${currentRound - 1} COMPLETADA!\n\nPulsa OK para la RONDA ${currentRound}`);
                            timerState = 'paused';
                            statusMessage.textContent = 'Esperando...';
                            messageBoxOkButton.onclick = () => {
                                messageBox.style.display = 'none';
                                startNewRound();
                                messageBoxOkButton.onclick = () => messageBox.style.display = 'none';
                            };
                        } else {
                            currentRunnerIndex++;
                            const next = runners[currentRunnerIndex];
                            statusMessage.textContent = `${runner.name} → ${formatTime(elapsed)} | Siguiente: ${next.name}`;
                            startCooldown();
                        }

                        timerState = 'stopped';
                        lastDisplayedTime = elapsed;
                        timerDisplay.style.color = '#e2e8f0';
                        displayLaps();
                    }
                }
            }
        }
    }

    previousFrameData = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);

    if (timerState === 'running') {
        const currentTime = performance.now() - startTime;
        timerDisplay.textContent = formatTime(currentTime);
        timerDisplay.style.color = currentTime < 3000 ? '#ff4444' : '#00ffff';
    } else if (!cooldownActive) {
        timerDisplay.textContent = formatTime(lastDisplayedTime);
    }

    requestAnimationFrame(detectMovement);
}

// === EVENTOS ===
resetButton.onclick = () => {
    try {
        Object.values(LS_KEYS).forEach(k => localStorage.removeItem(k));
    } catch (e) {}
    try {
        const s = video && video.srcObject;
        if (s && s.getTracks) s.getTracks().forEach(t => t.stop());
    } catch (e) {}
    cleanupRTC();
    location.reload();
};

sensitivitySlider.oninput = e => {
    detectionThreshold = +e.target.value;
    statusMessage.textContent = `Sensibilidad: ${detectionThreshold}`;
};

messageBoxOkButton.onclick = () => messageBox.style.display = 'none';

// Eventos de configuración
document.getElementById('setup-with-names').onclick = setupWithNames;
document.getElementById('setup-without-names').onclick = setupWithoutNames;
document.getElementById('save-names').onclick = saveRunnerNames;
document.getElementById('cancel-names').onclick = () => {
    document.getElementById('names-modal').style.display = 'none';
    document.getElementById('setup-modal').style.display = 'flex';
};
document.getElementById('setup-with-excel').onclick = setupWithExcel;
document.getElementById('process-excel').onclick = saveExcelNames;
document.getElementById('cancel-excel').onclick = () => {
    document.getElementById('excel-modal').style.display = 'none';
    document.getElementById('setup-modal').style.display = 'flex';
    window.tempExcelNames = null;
};
document.getElementById('excel-file').addEventListener('change', processExcelFile);

// Eventos P2P y toggle del panel
document.getElementById('p2p-create').onclick = () => {
    const roomId = document.getElementById('p2p-room-id').value.trim();
    if (!roomId) return alert('Introduce un ID de sala');
    createRoom(roomId);
};
document.getElementById('p2p-join').onclick = () => {
    const roomId = document.getElementById('p2p-room-id').value.trim();
    if (!roomId) return alert('Introduce un ID de sala');
    joinRoom(roomId);
};

// Panel colapsable
const p2pContent = document.getElementById('p2p-content');
const p2pToggle = document.getElementById('p2p-toggle');
p2pToggle.onclick = () => {
    if (p2pContent.style.display === 'none') {
        p2pContent.style.display = 'block';
        p2pToggle.textContent = '▼';
    } else {
        p2pContent.style.display = 'none';
        p2pToggle.textContent = '▶';
    }
};

// === INICIO ===
window.onload = () => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    const boot = () => {
        loadLaps();
        if (runners.length > 0) {
            document.getElementById('app-container').style.display = 'flex';
            setupCamera();
            createButtons();
            statusMessage.textContent = `Ronda ${currentRound} - Listo: ${runners[currentRunnerIndex].name}`;
            displayLaps();
        } else {
            document.getElementById('setup-modal').style.display = 'flex';
        }
    };
    script.onload = boot;
    script.onerror = boot; // la app funciona sin PDF; el botón avisará
    document.head.appendChild(script);
};

window.onresize = () => {
    if (video.videoWidth) {
        [hiddenCanvas, overlayCanvas].forEach(c => {
            c.width = video.videoWidth;
            c.height = video.videoHeight;
        });
    }
};