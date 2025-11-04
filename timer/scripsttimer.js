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
const hiddenCanvas = document.createElement('canvas');
const hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
const overlayCtx = overlayCanvas.getContext('2d');

const beep = new Audio('Beep.mp3');
beep.preload = 'auto';

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
let recordedLaps = [];

// === UTILIDADES ===
function formatTime(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const c = Math.floor(ms % 1000);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(c).padStart(3,'0')}`;
}

function showMessageBox(msg) {
    messageContent.textContent = msg;
    messageBox.style.display = 'block';
}

function saveLaps() {
    localStorage.setItem('recordedLaps', JSON.stringify(recordedLaps));
    localStorage.setItem('runners', JSON.stringify(runners));
    localStorage.setItem('currentRunnerIndex', currentRunnerIndex);
    localStorage.setItem('currentRound', currentRound);
}

function loadLaps() {
    const data = localStorage.getItem('recordedLaps');
    if (data) recordedLaps = JSON.parse(data);
    const r = localStorage.getItem('runners');
    if (r) runners = JSON.parse(r);
    const i = localStorage.getItem('currentRunnerIndex');
    if (i) currentRunnerIndex = parseInt(i);
    const round = localStorage.getItem('currentRound');
    if (round) currentRound = parseInt(round);
    displayLaps();
}

function displayLaps() {
    lapsList.innerHTML = '';
    if (recordedLaps.length === 0) {
        lapsContainer.style.display = 'none';
        return;
    }
    lapsContainer.style.display = 'block';
    recordedLaps.forEach(lap => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${lap.runnerName}:</span> <span>${formatTime(lap.time)}</span>`;
        lapsList.appendChild(li);
    });
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
    overlayCtx.moveTo(x - w/2, 0); overlayCtx.lineTo(x - w/2, overlayCanvas.height);
    overlayCtx.moveTo(x + w/2, 0); overlayCtx.lineTo(x + w/2, overlayCanvas.height);
    overlayCtx.stroke();
    if (flash) {
        overlayCanvas.style.filter = 'brightness(1.5)';
        setTimeout(() => overlayCanvas.style.filter = '', 200);
    }
}

function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }

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
        const name = inp.value.trim() || `Corredor ${i+1}`;
        runners.push({ id: i+1, name });
    });
    currentRunnerIndex = 0;
    currentRound = 1;
    document.getElementById('names-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    saveLaps();
    setupCamera();
    createButtons();
    statusMessage.textContent = `Ronda 1 - Listo: ${runners[0].name}`;
}

function setupWithoutNames() {
    runners = [{ id: 1, name: 'Corredor 1' }];
    currentRunnerIndex = 0;
    currentRound = 1;
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    saveLaps();
    setupCamera();
    createButtons();
    statusMessage.textContent = `Ronda 1 - Listo: ${runners[0].name}`;
}

function createButtons() {
    if (document.getElementById('download-pdf')) return;

    const dl = document.createElement('button');
    dl.id = 'download-pdf';
    dl.textContent = 'Descargar PDF';
    dl.className = 'gradient-purple';
    dl.onclick = () => {
        if (recordedLaps.length === 0) return showMessageBox('No hay tiempos');
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        doc.setFontSize(20);
        doc.text('REPORTE DE TIEMPOS', 105, 20, { align: 'center' });
        doc.setFontSize(12);
        doc.text(`Ronda ${currentRound-1} | ${new Date().toLocaleDateString()}`, 20, 35);
        let y = 50;
        recordedLaps.forEach(l => { doc.text(`${l.runnerName}: ${formatTime(l.time)}`, 30, y); y += 10; });
        doc.save(`ronda_${currentRound-1}.pdf`);
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
        const avg = calibrationSamples.length ? calibrationSamples.reduce((a,b)=>a+b)/calibrationSamples.length : 0;
        detectionThreshold = Math.max(60, Math.min(400, avg * 2 + 30));
        sensitivitySlider.value = detectionThreshold;
        isCalibrating = false;
        timerDisplay.textContent = '00:00.000';
        timerDisplay.style.color = '#e2e8f0';
    }, calibrationDuration);
}

function detectMovement() {
    if (!video.videoWidth) { requestAnimationFrame(detectMovement); return; }

    hiddenCtx.drawImage(video, 0, 0);
    drawLine();

    const x1 = hiddenCanvas.width * 0.475;
    const w = hiddenCanvas.width * 0.05;
    const frame = hiddenCtx.getImageData(x1, 0, w, hiddenCanvas.height);

    if (previousFrameData && frame.data.length === previousFrameData.data.length) {
        let diff = 0;
        for (let i = 0; i < frame.data.length; i += 4) {
            diff += Math.abs(frame.data[i] - previousFrameData.data[i]);
            diff += Math.abs(frame.data[i+1] - previousFrameData.data[i+1]);
            diff += Math.abs(frame.data[i+2] - previousFrameData.data[i+2]);
        }
        const norm = diff / (frame.data.length / 4);

        if (isCalibrating) {
            calibrationSamples.push(norm);
        } else if (timerState !== 'paused' && norm > detectionThreshold && (performance.now() - lastDetectionTime) > detectionCooldown) {
            lastDetectionTime = performance.now();
            beep.currentTime = 0; beep.play();
            drawLine('lime', true);
            vibrate(200);

            if (timerState === 'stopped') {
                startTime = performance.now();
                timerState = 'running';
                statusMessage.textContent = '¡CORRIENDO!';
                timerDisplay.style.color = '#00ffff';
            } else {
                const elapsed = performance.now() - startTime;
                const runner = runners[currentRunnerIndex];

                if (elapsed < 3000) {
                    statusMessage.textContent = 'Vuelta muy rápida';
                    drawLine('yellow', true);
                } else {
                    // VUELTA VÁLIDA
                    recordedLaps.push({ time: elapsed, runnerName: runner.name });
                    saveLaps();
                    displayLaps();

                    // === AVANZAR CORREDOR ===
                    const wasLast = currentRunnerIndex === runners.length - 1;

                    if (wasLast) {
                        // RONDA COMPLETADA
                        currentRound++;
                        currentRunnerIndex = 0;

                        showMessageBox(`¡RONDA ${currentRound-1} COMPLETADA!\n\nTodos los corredores han pasado.\n\nPulsa OK para la RONDA ${currentRound}`);

                        timerState = 'paused';
                        statusMessage.textContent = 'Esperando...';

                        messageBoxOkButton.onclick = () => {
                            messageBox.style.display = 'none';
                            timerState = 'stopped';
                            statusMessage.textContent = `RONDA ${currentRound} - Listo: ${runners[0].name}`;
                            timerDisplay.textContent = '00:00.000';
                            lastDisplayedTime = 0;
                            messageBoxOkButton.onclick = () => messageBox.style.display = 'none';
                        };
                    } else {
                        // Siguiente corredor normal
                        currentRunnerIndex++;
                        const next = runners[currentRunnerIndex];
                        statusMessage.textContent = `${runner.name} → ${formatTime(elapsed)} | Siguiente: ${next.name}`;
                    }

                    timerState = 'stopped';
                    lastDisplayedTime = elapsed;
                    timerDisplay.style.color = '#e2e8f0';
                }
            }
        }
    }

    previousFrameData = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);

    if (timerState === 'running') {
        timerDisplay.textContent = formatTime(performance.now() - startTime);
    } else {
        timerDisplay.textContent = formatTime(lastDisplayedTime);
    }

    requestAnimationFrame(detectMovement);
}

// === EVENTOS ===
resetButton.onclick = () => {
    timerState = 'stopped';
    recordedLaps = [];
    currentRunnerIndex = 0;
    currentRound = 1;
    saveLaps();
    displayLaps();
    statusMessage.textContent = 'Reiniciando...';
    setupCamera();
};

sensitivitySlider.oninput = e => {
    detectionThreshold = +e.target.value;
    statusMessage.textContent = `Sensibilidad: ${detectionThreshold}`;
};

messageBoxOkButton.onclick = () => messageBox.style.display = 'none';

document.getElementById('setup-with-names').onclick = setupWithNames;
document.getElementById('setup-without-names').onclick = setupWithoutNames;
document.getElementById('save-names').onclick = saveRunnerNames;
document.getElementById('cancel-names').onclick = () => {
    document.getElementById('names-modal').style.display = 'none';
    document.getElementById('setup-modal').style.display = 'flex';
};

// === INICIO ===
window.onload = () => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    script.onload = () => {
        loadLaps();
        if (runners.length > 0) {
            document.getElementById('app-container').style.display = 'flex';
            setupCamera();
            createButtons();
            statusMessage.textContent = `Ronda ${currentRound} - Listo: ${runners[currentRunnerIndex].name}`;
        } else {
            document.getElementById('setup-modal').style.display = 'flex';
        }
    };
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