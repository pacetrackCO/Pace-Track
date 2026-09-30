document.addEventListener("DOMContentLoaded", () => {
    console.log('PCscripts.js cargado');

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

    const qrUrl = `/__mockup/pacetrack-current/timer_PC/Mobil/timer.html?session=${sessionId}`;
    console.log('Generando QR para URL:', qrUrl);
    try {
        if (typeof QRCode === 'undefined') throw new Error('Librería QR no cargada (sin conexión)');
        qrcodeContainer.innerHTML = '';
        // qrcodejs (davidshimjs) API: new QRCode(elemento, {text, width, height})
        new QRCode(qrcodeContainer, { text: qrUrl, width: 200, height: 200 });
        console.log('QR generado exitosamente');
        document.getElementById('status-message').textContent = 'Vista previa: QR local generado; la sincronización externa está desactivada.';
    } catch (error) {
        console.error('Error al intentar generar QR:', error);
        document.getElementById('status-message').textContent = 'Error al generar el código QR';
    }

    // Firebase y la sincronización con móvil no están disponibles en esta vista previa.
    document.getElementById('status-message').textContent = 'Vista previa: Firebase y sincronización con móvil desactivados.';
});
