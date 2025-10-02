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

// Funciones de utilidad
function saveLaps() {
    localStorage.setItem('recordedLaps', JSON.stringify(recordedLaps));
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

// Configuración de cámara y calibración
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
        
        // MODIFICACIÓN: Aplicar reducción del 50% en la sensibilidad
        const baseThreshold = Math.max(parseInt(sensitivitySlider.min), averageNoise * 2 || 100);
        detectionThreshold = Math.min(parseInt(sensitivitySlider.max), baseThreshold + 5);
        detectionThreshold = Math.floor(detectionThreshold * 2); // Reducir sensibilidad al 50%
        
        sensitivitySlider.value = detectionThreshold;
        
        isCalibrating = false;
        statusMessage.textContent = 'Calibración completa. ¡Listo para el primer paso!';
        timerDisplay.textContent = '00:00.000';
        lastDisplayedTime = 0;
        timerDisplay.style.color = '#e2e8f0';
        
        showMessageBox(`Calibración completa. Umbral de detección inicial: ${detectionThreshold.toFixed(0)}. Ahora, el primer paso iniciará el cronómetro.`);
        console.log(`Calibración: Ruido promedio = ${averageNoise.toFixed(2)}. Umbral ajustado a: ${detectionThreshold.toFixed(0)}.`);
    }, calibrationDuration);
}

// Detección de movimiento
function detectMovement() {
    if (video.paused || video.ended || !video.videoWidth) {
        animationFrameId = requestAnimationFrame(detectMovement);
        return;
    }
    
    // Asegurarse de que los canvas tengan el tamaño correcto
    if (hiddenCanvas.width !== video.videoWidth || hiddenCanvas.height !== video.videoHeight) {
        hiddenCanvas.width = video.videoWidth;
        hiddenCanvas.height = video.videoHeight;
    }
    
    if (overlayCanvas.width !== video.videoWidth || overlayCanvas.height !== video.videoHeight) {
        overlayCanvas.width = video.videoWidth;
        overlayCanvas.height = video.videoHeight;
    }
    
    // Dibujar el video en el canvas oculto para procesamiento
    hiddenCtx.drawImage(video, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
    
    // Limpiar y dibujar en el canvas de superposición
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.drawImage(video, 0, 0, overlayCanvas.width, overlayCanvas.height);
    drawDetectionLine();
    
    // Definir la región de detección
    const lineStartX = Math.max(0, hiddenCanvas.width * detectionLineX - hiddenCanvas.width * detectionLineThickness / 2);
    const lineEndX = Math.min(hiddenCanvas.width, hiddenCanvas.width * detectionLineX + hiddenCanvas.width * detectionLineThickness / 2);
    const lineRegionWidth = lineEndX - lineStartX;
    
    // Obtener datos de la región de interés
    const currentFrameData = hiddenCtx.getImageData(lineStartX, 0, lineRegionWidth, hiddenCanvas.height);
    
    if (previousFrameData && previousFrameData.data.length === currentFrameData.data.length) {
        let diff = 0;
        
        // Calcular la diferencia entre frames
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
            
            // MODIFICACIÓN: Aplicar reducción del 50% en la sensibilidad para la detección
            const adjustedThreshold = detectionThreshold * 0.5;
            
            if (normalizedDiff > adjustedThreshold) {
                if ((currentTime - lastDetectionTime) > detectionCooldown) {
                    console.log('Movimiento detectado! Diferencia normalizada:', normalizedDiff.toFixed(2));
                    lastDetectionTime = currentTime;
                    drawDetectionLine('limegreen', true);
                    
                    if (timerState === 'stopped') {
                        // Iniciar el cronómetro
                        vibrate(100); // Vibración corta para inicio
                        startTime = currentTime;
                        timerState = 'running';
                        statusMessage.textContent = 'Contando...';
                        timerDisplay.style.color = '#00FFFF';
                        timerDisplay.textContent = '00:00.000';
                        lastDisplayedTime = 0;
                    } else if (timerState === 'running') {
                        // Registrar tiempo de paso y reiniciar inmediatamente
                        vibrate([100, 50, 100]); // Vibración doble para paso registrado
                        const elapsed = currentTime - startTime;
                        recordedLaps.push(elapsed);
                        saveLaps();
                        displayLaps();
                        
                        // Reiniciar inmediatamente para el siguiente paso
                        startTime = currentTime; // Reiniciar el tiempo de inicio
                        lastDisplayedTime = 0;
                        statusMessage.textContent = `Paso ${recordedLaps.length} - ${formatTime(elapsed)} - Cronómetro reiniciado automáticamente`;
                        // El timerState sigue siendo 'running', no cambia a 'stopped'
                    }
                }
            }
        }
    }
    
    // Guardar el frame actual para la siguiente comparación
    previousFrameData = new ImageData(
        new Uint8ClampedArray(currentFrameData.data),
        currentFrameData.width,
        currentFrameData.height
    );
    
    // Actualizar el display del cronómetro
    if (timerState === 'running') {
        const elapsed = performance.now() - startTime;
        timerDisplay.textContent = formatTime(elapsed);
    } else {
        timerDisplay.textContent = formatTime(lastDisplayedTime);
    }
    
    animationFrameId = requestAnimationFrame(detectMovement);
}

// Event listeners
resetButton.addEventListener('click', () => {
    // Detener la animación y la calibración si están activas
    cancelAnimationFrame(animationFrameId);
    clearTimeout(calibrationTimeoutId);
    
    // Restablecer todas las variables del estado del cronómetro
    timerState = 'stopped';
    startTime = 0;
    lastDisplayedTime = 0;
    
    // Limpiar la lista de tiempos y el almacenamiento local
    recordedLaps = [];
    saveLaps(); // Borra los tiempos guardados
    displayLaps(); // Limpia la lista en la interfaz
    
    // Reiniciar los displays de la interfaz
    timerDisplay.textContent = '00:00.000';
    statusMessage.textContent = 'Iniciando cámara...';
    timerDisplay.style.color = '#e2e8f0';
    
    previousFrameData = null;
    lastDetectionTime = 0;
    
    // Iniciar el proceso desde el principio (configurar cámara y calibrar)
    setupCamera();
});

sensitivitySlider.addEventListener('input', (event) => {
    // MODIFICACIÓN: Aplicar reducción del 50% en la sensibilidad
    const rawValue = parseInt(event.target.value);
    detectionThreshold = Math.floor(rawValue * 2); // Reducir sensibilidad al 50%
    statusMessage.textContent = `Sensibilidad: ${rawValue}. Ajusta para tu entorno.`;
    console.log(`Sensibilidad ajustada a: ${rawValue} (umbral real: ${detectionThreshold}). Prueba a moverte por la línea. Si no detecta, baja la sensibilidad. Si detecta demasiado, súbela. Asegúrate de buena iluminación y un fondo uniforme.`);
});

messageBoxOkButton.addEventListener('click', () => {
    messageBox.style.display = 'none';
});

// Inicialización
window.addEventListener('load', () => {
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