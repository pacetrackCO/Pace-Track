// ==========================
// VARIABLES GLOBALES
// ==========================
const video = document.getElementById('video');
const overlayCanvas = document.getElementById('overlay-canvas');
const overlayCtx = overlayCanvas.getContext('2d');
const hiddenCanvas = document.createElement('canvas');
const hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });

const timerDisplay = document.getElementById('timer-display');
const statusMessage = document.getElementById('status-message');
const resetButton = document.getElementById('reset-button');
const sensitivitySlider = document.getElementById('sensitivity-slider');
const lapsContainer = document.getElementById('laps-container');
const lapsList = document.getElementById('laps-list');
const messageBox = document.getElementById('message-box');
const messageContent = document.getElementById('message-content');
const messageBoxOkButton = document.getElementById('message-box-ok');

// ==========================
// ESTADO
// ==========================
let timerState = 'stopped';
let startTime = 0;
let lastDisplayedTime = 0;
let previousFrameData = null;
let detectionThreshold = parseInt(sensitivitySlider.value);
let detectionLineX = 0.5;
let detectionLineThickness = 0.05;
let lastDetectionTime = 0;
const detectionCooldown = 500;
let isCalibrating = false;
let calibrationSamples = [];
let recordedLaps = [];

// ==========================
// FUNCIONES AUXILIARES
// ==========================
function formatTime(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msPart = Math.floor(ms % 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msPart).padStart(3, '0')}`;
}

function showMessageBox(message) {
  messageContent.textContent = message;
  messageBox.style.display = 'block';
}
messageBoxOkButton.addEventListener('click', () => {
  messageBox.style.display = 'none';
});

function displayLaps() {
  lapsList.innerHTML = '';
  if (recordedLaps.length === 0) {
    lapsContainer.style.display = 'none';
    return;
  }
  lapsContainer.style.display = 'block';
  recordedLaps.forEach((lap, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>P${i + 1}:</span> <span>${formatTime(lap)}</span>`;
    lapsList.appendChild(li);
  });
  lapsList.scrollTop = lapsList.scrollHeight;
}

function saveLaps() {
  try {
    if (recordedLaps.length % 10 === 0) {
      localStorage.setItem('recordedLaps', JSON.stringify(recordedLaps));
    }
  } catch (e) {
    console.warn('⚠️ Límite de almacenamiento alcanzado');
  }
}
function loadLaps() {
  const data = localStorage.getItem('recordedLaps');
  if (data) {
    recordedLaps = JSON.parse(data);
    displayLaps();
  }
}

// ==========================
// CÁMARA Y DETECCIÓN
// ==========================
async function setupCamera() {
  try {
    statusMessage.textContent = 'Solicitando acceso a la cámara...';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });
    video.srcObject = stream;
    await new Promise(resolve => (video.onloadedmetadata = resolve));

    hiddenCanvas.width = video.videoWidth;
    hiddenCanvas.height = video.videoHeight;
    overlayCanvas.width = video.videoWidth;
    overlayCanvas.height = video.videoHeight;

    statusMessage.textContent = 'Calibrando... mantén la cámara estable';
    startCalibration();
    requestAnimationFrame(detectMovement);
  } catch (err) {
    console.error('Error cámara:', err);
    showMessageBox('❌ No se pudo acceder a la cámara. Revisa permisos.');
    statusMessage.textContent = 'Cámara no disponible';
  }
}

function startCalibration() {
  isCalibrating = true;
  calibrationSamples = [];
  timerDisplay.textContent = 'CALIBRANDO';
  timerDisplay.style.color = '#facc15';

  setTimeout(() => {
    const avgNoise =
      calibrationSamples.length > 0
        ? calibrationSamples.reduce((a, b) => a + b, 0) / calibrationSamples.length
        : 0;

    detectionThreshold = Math.max(parseInt(sensitivitySlider.min), avgNoise * 2 || 50);
    isCalibrating = false;

    statusMessage.textContent = 'Calibración completa. Listo.';
    timerDisplay.style.color = '#e2e8f0';
    timerDisplay.textContent = '00:00.000';
    showMessageBox(`✅ Calibración completada. Umbral: ${detectionThreshold.toFixed(0)}`);
  }, 3000);
}

function drawDetectionLine(color = 'rgba(255, 0, 0, 0.7)', flash = false) {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  const x = overlayCanvas.width * detectionLineX;
  const halfW = (overlayCanvas.width * detectionLineThickness) / 2;

  overlayCtx.beginPath();
  overlayCtx.moveTo(x - halfW, 0);
  overlayCtx.lineTo(x - halfW, overlayCanvas.height);
  overlayCtx.moveTo(x + halfW, 0);
  overlayCtx.lineTo(x + halfW, overlayCanvas.height);
  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = 4;
  overlayCtx.stroke();

  if (flash) {
    overlayCanvas.classList.add('detection-line-flash');
    setTimeout(() => overlayCanvas.classList.remove('detection-line-flash'), 150);
  }

  if (isCalibrating) overlayCanvas.classList.add('calibrating-line');
  else overlayCanvas.classList.remove('calibrating-line');
}

function detectMovement() {
  if (video.readyState !== video.HAVE_ENOUGH_DATA) {
    requestAnimationFrame(detectMovement);
    return;
  }

  hiddenCtx.drawImage(video, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
  const current = hiddenCtx.getImageData(0, 0, hiddenCanvas.width, hiddenCanvas.height);

  if (previousFrameData) {
    let diff = 0;
    for (let i = 0; i < current.data.length; i += 4) {
      diff += Math.abs(current.data[i] - previousFrameData.data[i]);
    }
    const normalized = diff / (current.data.length / 4);

    if (isCalibrating) {
      calibrationSamples.push(normalized);
    } else {
      const now = performance.now();
      const adjustedThreshold = detectionThreshold * 0.5;

      if (normalized > adjustedThreshold && now - lastDetectionTime > detectionCooldown) {
        lastDetectionTime = now;
        drawDetectionLine('lime', true);

        if (timerState === 'stopped') {
          startTime = now;
          timerState = 'running';
          statusMessage.textContent = 'Contando...';
          timerDisplay.style.color = '#34d399';
        } else {
          const elapsed = now - startTime;
          recordedLaps.push(elapsed);
          saveLaps();
          displayLaps();
          startTime = now;
          statusMessage.textContent = `Paso ${recordedLaps.length} - ${formatTime(elapsed)}`;
        }
      }
    }
  }

  previousFrameData = new ImageData(
    new Uint8ClampedArray(current.data),
    current.width,
    current.height
  );

  if (timerState === 'running') {
    const elapsed = performance.now() - startTime;
    timerDisplay.textContent = formatTime(elapsed);
  }

  drawDetectionLine();
  requestAnimationFrame(detectMovement);
}

// ==========================
// EVENTOS
// ==========================
sensitivitySlider.addEventListener('input', e => {
  detectionThreshold = parseInt(e.target.value);
});

resetButton.addEventListener('click', () => {
  timerState = 'stopped';
  startTime = 0;
  lastDisplayedTime = 0;
  previousFrameData = null;
  recordedLaps = [];
  localStorage.removeItem('recordedLaps');
  displayLaps();
  timerDisplay.textContent = '00:00.000';
  statusMessage.textContent = 'Reiniciando cámara...';
  setupCamera();
});

window.addEventListener('load', () => {
  loadLaps();
  setupCamera();
});
