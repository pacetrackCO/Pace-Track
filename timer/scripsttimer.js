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

// Nuevas variables para múltiples corredores
let runners = [];
let currentRunnerIndex = 0;
let useRunnerNames = false;
const MIN_LAP_TIME = 3500; // 3 segundos mínimo para contar como vuelta válida
const MIN_STOP_TIME = 1000; // 1 segundo mínimo para detener sin guardar

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
    localStorage.setItem('runners', JSON.stringify(runners));
    localStorage.setItem('currentRunnerIndex', currentRunnerIndex);
    localStorage.setItem('useRunnerNames', useRunnerNames);
}

function loadLaps() {
    const storedLaps = localStorage.getItem('recordedLaps');
    const storedRunners = localStorage.getItem('runners');
    const storedCurrentRunnerIndex = localStorage.getItem('currentRunnerIndex');
    const storedUseRunnerNames = localStorage.getItem('useRunnerNames');
    
    if (storedLaps) {
        recordedLaps = JSON.parse(storedLaps);
    }
    
    if (storedRunners) {
        runners = JSON.parse(storedRunners);
    }
    
    if (storedCurrentRunnerIndex) {
        currentRunnerIndex = JSON.parse(storedCurrentRunnerIndex);
    }
    
    if (storedUseRunnerNames) {
        useRunnerNames = JSON.parse(storedUseRunnerNames);
    }
    
    displayLaps();
}

function displayLaps() {
    lapsList.innerHTML = '';
    if (recordedLaps.length > 0) {
        lapsContainer.style.display = 'block';
        recordedLaps.forEach((lap, index) => {
            const li = document.createElement('li');
            li.innerHTML = `<span>${lap.runnerName}:</span> <span>${formatTime(lap.time)}</span>`;
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

function formatTimeForPDF(milliseconds) {
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

// Funciones para gestión de corredores
function showSetupModal() {
    document.getElementById('setup-modal').style.display = 'flex';
    document.getElementById('app-container').style.display = 'none';
}

function setupWithNames() {
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('names-modal').style.display = 'flex';
    createRunnerInputs();
}

function setupWithoutNames() {
    document.getElementById('setup-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    useRunnerNames = false;
    // Crear un corredor por defecto
    runners = [{ id: 1, name: 'Corredor 1' }];
    currentRunnerIndex = 0;
    saveLaps();
    setupCamera();
    createDownloadButton();
    createAddRunnerButton();
}

function createRunnerInputs() {
    const container = document.getElementById('names-input-container');
    container.innerHTML = '';
    
    // Solo un input para el primer corredor
    const inputGroup = document.createElement('div');
    inputGroup.className = 'name-input-group';
    
    const label = document.createElement('label');
    label.textContent = 'Nombre del primer corredor:';
    
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Corredor 1';
    input.id = 'runner-name-0';
    
    inputGroup.appendChild(label);
    inputGroup.appendChild(input);
    container.appendChild(inputGroup);
    
    // Botón para agregar más corredores
    const addButton = document.createElement('button');
    addButton.id = 'add-runner-button';
    addButton.textContent = '+ Agregar otro corredor';
    addButton.style.backgroundImage = 'linear-gradient(90deg, #3b82f6, #60a5fa)';
    addButton.style.marginTop = '1rem';
    addButton.addEventListener('click', addRunnerInput);
    
    container.appendChild(addButton);
}

function addRunnerInput() {
    const container = document.getElementById('names-input-container');
    const currentCount = document.querySelectorAll('.name-input-group').length;
    
    const inputGroup = document.createElement('div');
    inputGroup.className = 'name-input-group';
    
    const label = document.createElement('label');
    label.textContent = `Nombre del corredor ${currentCount + 1}:`;
    
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `Corredor ${currentCount + 1}`;
    input.id = `runner-name-${currentCount}`;
    
    inputGroup.appendChild(label);
    inputGroup.appendChild(input);
    
    // Insertar antes del botón de agregar
    const addButton = document.getElementById('add-runner-button');
    container.insertBefore(inputGroup, addButton);
}

function saveRunnerNames() {
    runners = [];
    const inputs = document.querySelectorAll('#names-input-container input');
    
    inputs.forEach((input, index) => {
        const name = input.value.trim() || `Corredor ${index + 1}`;
        runners.push({ id: index + 1, name: name });
    });
    
    useRunnerNames = true;
    currentRunnerIndex = 0;
    document.getElementById('names-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    saveLaps();
    setupCamera();
    createDownloadButton();
    createAddRunnerButton();
}

function addNewRunner() {
    const newRunnerNumber = runners.length + 1;
    const newRunner = { 
        id: newRunnerNumber, 
        name: `Corredor ${newRunnerNumber}` 
    };
    runners.push(newRunner);
    saveLaps();
    
    showMessageBox(`Nuevo corredor agregado: ${newRunner.name}`);
    console.log(`Corredor agregado: ${newRunner.name}`);
}

function createAddRunnerButton() {
    // Verificar si el botón ya existe
    if (document.getElementById('add-runner-button-main')) {
        return;
    }
    
    const addRunnerButton = document.createElement('button');
    addRunnerButton.id = 'add-runner-button-main';
    addRunnerButton.textContent = '+ Agregar Corredor';
    addRunnerButton.style.backgroundImage = 'linear-gradient(90deg, #10b981, #34d399)';
    
    // Insertar el botón después del botón de descarga PDF
    const downloadButton = document.getElementById('download-pdf-button');
    if (downloadButton) {
        downloadButton.parentNode.insertBefore(addRunnerButton, downloadButton.nextSibling);
    } else {
        resetButton.parentNode.insertBefore(addRunnerButton, resetButton.nextSibling);
    }
    
    // Event listener para el botón de agregar corredor
    addRunnerButton.addEventListener('click', addNewRunner);
}

// Función para descargar PDF
function downloadPDF() {
    if (recordedLaps.length === 0) {
        showMessageBox('No hay tiempos registrados para descargar.');
        return;
    }

    // Crear un nuevo documento PDF
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    
    // Configuración del documento
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    
    // Título
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(44, 62, 80);
    doc.text('REPORTE DE TIEMPOS - CRONÓMETRO', pageWidth / 2, 30, { align: 'center' });
    
    // Información de la sesión
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(128, 139, 150);
    doc.text(`Fecha: ${new Date().toLocaleDateString()}`, 20, 50);
    doc.text(`Hora: ${new Date().toLocaleTimeString()}`, 20, 60);
    doc.text(`Total de corredores: ${new Set(recordedLaps.map(lap => lap.runnerName)).size}`, pageWidth - 20, 50, { align: 'right' });
    doc.text(`Total de tiempos: ${recordedLaps.length}`, pageWidth - 20, 60, { align: 'right' });
    
    // Calcular estadísticas por corredor
    const runnersStats = {};
    recordedLaps.forEach(lap => {
        if (!runnersStats[lap.runnerName]) {
            runnersStats[lap.runnerName] = {
                times: [],
                count: 0
            };
        }
        runnersStats[lap.runnerName].times.push(lap.time);
        runnersStats[lap.runnerName].count++;
    });
    
    // Línea separadora
    doc.setDrawColor(200, 200, 200);
    doc.line(20, 80, pageWidth - 20, 80);
    
    // Encabezado de la tabla
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(44, 62, 80);
    doc.text('CORREDOR', 30, 95);
    doc.text('TIEMPO', pageWidth - 30, 95, { align: 'right' });
    
    // Línea bajo el encabezado
    doc.setDrawColor(100, 100, 100);
    doc.line(20, 100, pageWidth - 20, 100);
    
    // Lista de tiempos
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    let yPosition = 115;
    
    recordedLaps.forEach((lap, index) => {
        doc.setTextColor(44, 62, 80); // Color normal
        
        doc.text(lap.runnerName, 30, yPosition);
        doc.text(formatTimeForPDF(lap.time), pageWidth - 30, yPosition, { align: 'right' });
        
        yPosition += 10;
        
        // Verificar si necesita nueva página
        if (yPosition > pageHeight - 30 && index < recordedLaps.length - 1) {
            doc.addPage();
            yPosition = 30;
            
            // Encabezado de la nueva página
            doc.setFontSize(12);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(128, 139, 150);
            doc.text('REPORTE DE TIEMPOS - CRONÓMETRO (Continuación)', pageWidth / 2, 20, { align: 'center' });
            
            // Encabezado de tabla en nueva página
            doc.setFontSize(14);
            doc.setTextColor(44, 62, 80);
            doc.text('CORREDOR', 30, 35);
            doc.text('TIEMPO', pageWidth - 30, 35, { align: 'right' });
            doc.setDrawColor(100, 100, 100);
            doc.line(20, 40, pageWidth - 20, 40);
            
            yPosition = 50;
        }
    });
    
    // Estadísticas por corredor
    doc.addPage();
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(44, 62, 80);
    doc.text('ESTADÍSTICAS POR CORREDOR', pageWidth / 2, 30, { align: 'center' });
    
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    let statsY = 50;
    
    Object.keys(runnersStats).forEach(runnerName => {
        const stats = runnersStats[runnerName];
        const bestTime = Math.min(...stats.times);
        const averageTime = stats.times.reduce((sum, time) => sum + time, 0) / stats.times.length;
        
        doc.setTextColor(52, 152, 219); // Azul
        doc.text(`${runnerName}:`, 20, statsY);
        
        statsY += 10;
        doc.setTextColor(128, 139, 150); // Gris
        doc.text(`Mejor tiempo: ${formatTimeForPDF(bestTime)}`, 30, statsY);
        
        statsY += 8;
        doc.text(`Promedio: ${formatTimeForPDF(averageTime)}`, 30, statsY);
        
        statsY += 8;
        doc.text(`Total de vueltas: ${stats.count}`, 30, statsY);
        
        statsY += 15;
    });
    
    // Descargar el PDF
    const fileName = `tiempos_cronometro_${new Date().toISOString().split('T')[0]}.pdf`;
    doc.save(fileName);
    
    showMessageBox('PDF descargado exitosamente.');
}

function createDownloadButton() {
    // Verificar si el botón ya existe
    if (document.getElementById('download-pdf-button')) {
        return;
    }
    
    const downloadButton = document.createElement('button');
    downloadButton.id = 'download-pdf-button';
    downloadButton.textContent = 'Descargar PDF';
    downloadButton.style.backgroundImage = 'linear-gradient(90deg, #8e44ad, #9b59b6)';
    
    // Insertar el botón después del botón de reset
    resetButton.parentNode.insertBefore(downloadButton, resetButton.nextSibling);
    
    // Agregar event listener para descargar PDF
    downloadButton.addEventListener('click', downloadPDF);
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
        
        detectionThreshold = Math.max(parseInt(sensitivitySlider.min), averageNoise * 2 || 100);
        detectionThreshold = Math.min(parseInt(sensitivitySlider.max), detectionThreshold + 5);
        sensitivitySlider.value = detectionThreshold;
        
        isCalibrating = false;
        statusMessage.textContent = 'Calibración completa. ¡Listo para el primer corredor!';
        timerDisplay.textContent = '00:00.000';
        lastDisplayedTime = 0;
        timerDisplay.style.color = '#e2e8f0';
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
            
            if (normalizedDiff > detectionThreshold) {
                if ((currentTime - lastDetectionTime) > detectionCooldown) {
                    console.log('Movimiento detectado! Diferencia normalizada:', normalizedDiff.toFixed(2));
                    lastDetectionTime = currentTime;
                    drawDetectionLine('limegreen', true);
                    vibrate(200);
                    
                    if (timerState === 'stopped') {
                        // Iniciar el cronómetro
                        startTime = currentTime;
                        timerState = 'running';
                        statusMessage.textContent = 'Contando...';
                        timerDisplay.style.color = '#00FFFF';
                        timerDisplay.textContent = '00:00.000';
                        lastDisplayedTime = 0;
                    } else if (timerState === 'running') {
                        // Registrar tiempo de paso con validación
                        const elapsed = currentTime - startTime;
                        
                        if (elapsed < MIN_STOP_TIME) {
                            // Menos de 1 segundo: detener el cronómetro, no guardar
                            timerState = 'stopped';
                            lastDisplayedTime = elapsed;
                            statusMessage.textContent = `Vuelta cancelada: demasiado rápida (${formatTime(elapsed)})`;
                            timerDisplay.style.color = '#e2e8f0';
                            vibrate([100, 50, 100]); // Vibración para detección cancelada
                            drawDetectionLine('red', true);
                        } else if (elapsed < MIN_LAP_TIME) {
                            // Entre 1 y 3 segundos: ignorar detección, seguir contando
                            statusMessage.textContent = `Detección ignorada: tiempo intermedio (${formatTime(elapsed)})`;
                            vibrate([50, 50, 50]); // Vibración suave para detección ignorada
                            drawDetectionLine('yellow', true);
                        } else {
                            // Más de 3 segundos: vuelta válida
                            const currentRunner = runners[currentRunnerIndex];
                            
                            recordedLaps.push({
                                time: elapsed,
                                runnerName: currentRunner.name,
                                runnerId: currentRunner.id
                            });
                            
                            saveLaps();
                            displayLaps();
                            
                            // Avanzar al siguiente corredor
                            currentRunnerIndex = (currentRunnerIndex + 1) % runners.length;
                            
                            // Reiniciar para el siguiente corredor
                            timerState = 'stopped';
                            lastDisplayedTime = elapsed;
                            
                            const nextRunner = runners[currentRunnerIndex];
                            statusMessage.textContent = `${currentRunner.name} - ${formatTime(elapsed)} - Listo para: ${nextRunner.name}`;
                            timerDisplay.style.color = '#e2e8f0';
                        }
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
    detectionThreshold = parseInt(event.target.value);
    statusMessage.textContent = `Sensibilidad: ${detectionThreshold}. Ajusta para tu entorno.`;
    console.log(`Sensibilidad ajustada a: ${detectionThreshold}. Prueba a moverte por la línea. Si no detecta, baja la sensibilidad. Si detecta demasiado, súbela. Asegúrate de buena iluminación y un fondo uniforme.`);
});

messageBoxOkButton.addEventListener('click', () => {
    messageBox.style.display = 'none';
});

// Event listeners para los nuevos botones
document.getElementById('setup-with-names').addEventListener('click', setupWithNames);
document.getElementById('setup-without-names').addEventListener('click', setupWithoutNames);
document.getElementById('save-names').addEventListener('click', saveRunnerNames);
document.getElementById('cancel-names').addEventListener('click', () => {
    document.getElementById('names-modal').style.display = 'none';
    showSetupModal();
});

// Inicialización
window.addEventListener('load', () => {
    // Cargar la librería jsPDF desde CDN
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    script.onload = () => {
        // Verificar si hay configuración guardada
        const storedUseRunnerNames = localStorage.getItem('useRunnerNames');
        
        if (storedUseRunnerNames !== null) {
            // Ya hay configuración guardada, cargarla
            loadLaps();
            setupCamera();
            createDownloadButton();
            createAddRunnerButton();
            document.getElementById('app-container').style.display = 'flex';
        } else {
            // No hay configuración, mostrar modal de configuración
            showSetupModal();
        }
    };
    document.head.appendChild(script);
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