document.addEventListener("DOMContentLoaded", () => {
    console.log('PCscripts.js cargado');

    // --------- Firebase ---------
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

    try {
        firebase.initializeApp(firebaseConfig);
        console.log('Firebase inicializado correctamente');
        const db = firebase.database();
        console.log('Base de datos:', db);
    } catch (error) {
        console.error('Error al inicializar Firebase:', error);
        document.getElementById('status-message').textContent = 'Error al inicializar Firebase';
        return;
    }

    // --------- Generar ID de sesión y QR ---------
    const sessionId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
    console.log('Session ID:', sessionId);

    const qrcodeContainer = document.getElementById('qrcode');
    if (!qrcodeContainer) {
        console.error('Contenedor #qrcode no encontrado');
        document.getElementById('status-message').textContent = 'Error: Contenedor QR no encontrado';
        return;
    }
    console.log('Contenedor #qrcode encontrado');

    const qrUrl = `https://pacetrack.netlify.app/timer/timer.html?session=${sessionId}`;
    console.log('Generando QR para URL:', qrUrl);
    try {
        QRCode.toCanvas(qrUrl, { width: 200 }, function (error, canvas) {
            if (error) {
                console.error('Error generando QR:', error);
                document.getElementById('status-message').textContent = 'Error al generar el código QR';
                return;
            }
            qrcodeContainer.appendChild(canvas);
            console.log('QR generado exitosamente');
            document.getElementById('status-message').textContent = 'QR generado. Escanea para empezar.';
        });
    } catch (error) {
        console.error('Error al intentar generar QR:', error);
        document.getElementById('status-message').textContent = 'Error al generar el código QR';
    }

    // --------- Mostrar tiempos de paso ---------
    const statusMessage = document.getElementById('status-message');
    const lapsList = document.getElementById('laps-list');
    const lapsContainer = document.getElementById('laps-container');

    function formatTime(milliseconds) {
        const minutes = Math.floor(milliseconds / 60000);
        const seconds = Math.floor((milliseconds % 60000) / 1000);
        const ms = Math.floor(milliseconds % 1000);
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }

    function displayLaps(laps) {
        lapsList.innerHTML = '';
        if (laps && laps.length > 0) {
            lapsContainer.style.display = 'block';
            laps.forEach((lap, index) => {
                const li = document.createElement('li');
                li.innerHTML = `<span>P${index + 1}:</span> <span>${formatTime(lap)}</span>`;
                lapsList.appendChild(li);
            });
            lapsList.scrollTop = lapsList.scrollHeight;
            statusMessage.textContent = 'Tiempos actualizados en tiempo real.';
        } else {
            lapsContainer.style.display = 'none';
            statusMessage.textContent = 'No hay tiempos registrados en esta sesión. Escanea el QR para empezar.';
        }
    }

    db.ref(`sessions/${sessionId}/laps`).on('value', (snapshot) => {
        console.log('Datos recibidos de Firebase:', snapshot.val());
        const laps = snapshot.val();
        displayLaps(laps);
    }, (error) => {
        console.error('Error al leer tiempos:', error);
        statusMessage.textContent = 'Error al cargar los tiempos.';
    });
});