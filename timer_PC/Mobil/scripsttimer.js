const firebaseConfig = {
  apiKey: "AIzaSyC_IPrOClJF0uIkQB_yIEMdZZ28AgCE4Qk",
  authDomain: "pacetrack-579ef.firebaseapp.com",
  databaseURL: "https://pacetrack-579ef-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "pacetrack-579ef",
  storageBucket: "pacetrack-579ef.firebasestorage.app",
  messagingSenderId: "997850928548",
  appId: "1:997850928548:web:ce6bf324a6a2c42d4bdd31",
  measurementId: "G-M7E0JYMVGX"
};

firebase.initializeApp(firebaseConfig);
const database = firebase.database();

const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session') || null;

// Variables globales
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

let timerState = 'stopped';
let startTime = 0;
let lastDisplayedTime = 0;
let animationFrameId;
let calibrationTimeoutId;
let previousFrameData = null;
let detectionThreshold = parseInt(sensitivitySlider.value);
let detectionLineX = 0.5;
let detectionLineThickness = 0.05;
let lastDetectionTime = 0;
const detectionCooldown = 500;
let isCalibrating = true;
let calibrationSamples = [];
const calibrationDuration = 3000;
let recordedLaps = [];

function saveLaps() {
    localStorage.setItem('recordedLaps', JSON.stringify(recordedLaps));
    if (sessionId) {
        database.ref(`sessions/${sessionId}/laps`).set(recordedLaps)
            .then(() => {
                console.log('Tiempos guardados en Firebase');
                statusMessage.textContent = 'Tiempos enviados al servidor';
            })
            .catch(error => {
                console.error('Error al guardar tiempos:', error);
                showMessageBox('Error al guardar los tiempos en el servidor');
            });
    } else {
        console.warn('No sessionId provided, times saved locally only');
        statusMessage.textContent = 'No se proporcionó un ID de sesión, tiempos guardados localmente';
    }
}

function loadLaps() {
    const storedLaps = localStorage.getItem('recordedLaps');
    if (storedLaps) {
        recordedLaps = JSON.parse(storedLaps);
        displayLaps();
    }
}

function displayLaps() {
    lapsList.innerHTML = '';
    if (recordedLaps.length > 0) {
        lapsContainer.style.display = 'block';
        recordedLaps.forEach((lap, index) => {
            const li = document.createElement('li');
            li.innerHTML = `<span>P${index + 1}:</span> <span>${formatTime(lap)}</span>`;
            lapsList.appendChild(li);
        });
        lapsList.scrollTop = lapsList.scrollHeight;
    } else {
        lapsContainer.style.display = 'none';
    }
}

function showMessageBox(message) {
    messageContent.textContent = message;
    messageBox.style.display = 'block';
}

function formatTime(milliseconds) {
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.floor((milliseconds % 60000) / 1000);
    const ms = Math.floor(milliseconds % 1000);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function drawDetectionLine(color = 'rgba(255, 0, 0, 0.7)', isFlashing = false) {
    overlayCtx.beginPath();
    const lineXCoord = overlayCanvas.width * detectionLineX;
    const halfLineThickness = (overlayCanvas.width * detectionLineThickness) / 2;
    overlayCtx.moveTo(lineXCoord - halfLineThickness, 0);
    overlayCtx.lineTo(lineXCoord - halfLineThickness, overlayCanvas.height);
    overlayCtx.moveTo(lineXCoord + halfLineThickness, 0);
    overlayCtx.lineTo(lineXCoord + halfLineThickness, overlayCanvas.height);
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = 4;
    
    if (isFlashing) {
        overlayCtx.stroke();
        overlayCanvas.classList.add('detection-line-flash');
        setTimeout(() => {
            overlayCanvas.classList.remove('detection-line-flash');
            drawDetectionLine();
        }, 200);
    } else {
        overlayCanvas.classList.remove('detection-line-flash');
        overlayCtx.stroke();
    }
    
    if (isCalibrating) {
        overlayCanvas.classList.add('calibrating-line');
    } else {
        overlayCanvas.classList.remove('calibrating-line');
    }
}

function vibrate(pattern) {
    if (navigator.vibrate) {
        navigator.vibrate(pattern);
    }
}

async function setupCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: 'environment' } 
        });
        video.srcObject = stream;
        
        await new Promise(resolve => {
            video.onloadedmetadata = () => {
                resolve();
            };
        });
        
        hiddenCanvas.width = video.videoWidth;
        hiddenCanvas.height = video.videoHeight;
        overlayCanvas.width = video.videoWidth;
        overlayCanvas.height = video.videoHeight;
        
        statusMessage.textContent = 'Calibrando... Mantente quieto y la cámara estable.';
        startCalibration();
        animationFrameId = requestAnimationFrame(detectMovement);
    } catch (err) {
        console.error('Error al acceder a la cámara:', err);
        showMessageBox('No se pudo acceder a la cámara. Asegúrate de haber otorgado los permisos o de que tu dispositivo tenga una cámara disponible.');
    }
}

function startCalibration() {
    isCalibrating = true;
    calibrationSamples = [];
    statusMessage.textContent = 'Calibrando... mantén la cámara estable.';
    timerDisplay.textContent = 'CALIBRANDO';
    timerDisplay.style.color = 'yellow';
    
    calibrationTimeoutId = setTimeout(() => {
        const validSamples = calibrationSamples.filter(s => !isNaN(s) && isFinite(s));
        const averageNoise = validSamples.length > 0 ? 
            validSamples.reduce((sum, val) => sum + val, 0) / validSamples.length : 0;
        
        detectionThreshold = Math.max(parseInt(sensitivitySlider.min), averageNoise * 2 || 100);
        detectionThreshold = Math.min(parseInt(sensitivitySlider.max), detectionThreshold + 5);
        sensitivitySlider.value = detectionThreshold;
        
        isCalibrating = false;
        statusMessage.textContent = 'Calibración completa. ¡Listo para el primer paso!';
        timerDisplay.textContent = '00:00.000';
        lastDisplayedTime = 0;
        timerDisplay.style.color = '#e2e8f0';
        
        showMessageBox(`Calibración completa. Umbral de detección inicial: ${detectionThreshold.toFixed(0)}.`);
    }, calibrationDuration);
}

function detectMovement() {
    if (video.paused || video.ended || !video.videoWidth) {
        animationFrameId = requestAnimationFrame(detectMovement);
        return;
    }
    
    if (hiddenCanvas.width !== video.videoWidth || hiddenCanvas.height !== video.videoHeight) {
        hiddenCanvas.width = video.videoWidth;
        hiddenCanvas.height = video.videoHeight;
    }
    
    if (overlayCanvas.width !== video.videoWidth || overlayCanvas.height !== video.videoHeight) {
        overlayCanvas.width = video.videoWidth;
        overlayCanvas.height = video.videoHeight;
    }
    
    hiddenCtx.drawImage(video, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.drawImage(video, 0, 0, overlayCanvas.width, overlayCanvas.height);
    drawDetectionLine();
    
    const lineStartX = Math.max(0, hiddenCanvas.width * detectionLineX - hiddenCanvas.width * detectionLineThickness / 2);
    const lineEndX = Math.min(hiddenCanvas.width, hiddenCanvas.width * detectionLineX + hiddenCanvas.width * detectionLineThickness / 2);
    const lineRegionWidth = lineEndX - lineStartX;
    
    const currentFrameData = hiddenCtx.getImageData(lineStartX, 0, lineRegionWidth, hiddenCanvas.height);
    
    if (previousFrameData && previousFrameData.data.length === currentFrameData.data.length) {
        let diff = 0;
        
        for (let i = 0; i < currentFrameData.data.length; i += 4) {
            diff += Math.abs(currentFrameData.data[i] - previousFrameData.data[i]);
            diff += Math.abs(currentFrameData.data[i + 1] - previousFrameData.data[i + 1]);
            diff += Math.abs(currentFrameData.data[i + 2] - previousFrameData.data[i + 2]);
        }
        
        const normalizedDiff = diff / (currentFrameData.data.length / 4);
        
        if (isCalibrating) {
            calibrationSamples.push(normalizedDiff);
        } else {
            const currentTime = performance.now();
            
            if (normalizedDiff > detectionThreshold) {
                if ((currentTime - lastDetectionTime) > detectionCooldown) {
                    console.log('Movimiento detectado! Diferencia normalizada:', normalizedDiff.toFixed(2));
                    lastDetectionTime = currentTime;
                    drawDetectionLine('limegreen', true);
                    vibrate(200);
                    
                    if (timerState === 'stopped') {
                        startTime = currentTime;
                        timerState = 'running';
                        statusMessage.textContent = 'Contando...';
                        timerDisplay.style.color = '#00FFFF';
                        timerDisplay.textContent = '00:00.000';
                        lastDisplayedTime = 0;
                    } else if (timerState === 'running') {
                        const elapsed = currentTime - startTime;
                        recordedLaps.push(elapsed);
                        saveLaps();
                        displayLaps();
                        
                        timerState = 'stopped';
                        lastDisplayedTime = elapsed;
                        statusMessage.textContent = `Paso ${recordedLaps.length} - ${formatTime(elapsed)} - Listo para el siguiente paso.`;
                        timerDisplay.style.color = '#e2e8f0';
                    }
                }
            }
        }
    }
    
    previousFrameData = new ImageData(
        new Uint8ClampedArray(currentFrameData.data),
        currentFrameData.width,
        currentFrameData.height
    );
    
    if (timerState === 'running') {
        const elapsed = performance.now() - startTime;
        timerDisplay.textContent = formatTime(elapsed);
    } else {
        timerDisplay.textContent = formatTime(lastDisplayedTime);
    }
    
    animationFrameId = requestAnimationFrame(detectMovement);
}

resetButton.addEventListener('click', () => {
    cancelAnimationFrame(animationFrameId);
    clearTimeout(calibrationTimeoutId);
    
    timerState = 'stopped';
    startTime = 0;
    lastDisplayedTime = 0;
    
    recordedLaps = [];
    saveLaps();
    displayLaps();
    
    timerDisplay.textContent = '00:00.000';
    statusMessage.textContent = 'Iniciando cámara...';
    timerDisplay.style.color = '#e2e8f0';
    
    previousFrameData = null;
    lastDetectionTime = 0;
    
    setupCamera();
});

sensitivitySlider.addEventListener('input', (event) => {
    detectionThreshold = parseInt(event.target.value);
    statusMessage.textContent = `Sensibilidad: ${detectionThreshold}. Ajusta para tu entorno.`;
    console.log(`Sensibilidad ajustada a: ${detectionThreshold}. Prueba a moverte por la línea. Si no detecta, baja la sensibilidad. Si detecta demasiado, súbela. Asegúrate de buena iluminación y un fondo uniforme.`);
});

messageBoxOkButton.addEventListener('click', () => {
    messageBox.style.display = 'none';
});

window.addEventListener('load', () => {
    if (!sessionId) {
        showMessageBox('No se proporcionó un ID de sesión. Por favor, escanea el código QR desde la página de resultados.');
    }
    setupCamera();
    loadLaps();
});

window.addEventListener('resize', () => {
    if (video.videoWidth && video.videoHeight) {
        overlayCanvas.width = video.videoWidth;
        overlayCanvas.height = video.videoHeight;
        hiddenCanvas.width = video.videoWidth;
        hiddenCanvas.height = video.videoHeight;
        
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        overlayCtx.drawImage(video, 0, 0, overlayCanvas.width, overlayCanvas.height);
        drawDetectionLine();
    }
});