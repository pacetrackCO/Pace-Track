// netlify/functions/signal.js

// Objeto para almacenar mensajes temporalmente
const messages = {};

exports.handler = async (event, context) => {
    // Habilitar CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Manejar preflight request
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    try {
        // Verificar que sea POST
        if (event.httpMethod !== 'POST') {
            return {
                statusCode: 405,
                headers,
                body: JSON.stringify({ error: 'Método no permitido' })
            };
        }

        // Parsear el cuerpo
        const body = JSON.parse(event.body || '{}');
        const { id, target, data } = body;

        console.log(`📤 Signal: ${id} -> ${target}, tipo: ${data?.type}`);

        // Validar parámetros
        if (!id || !target) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Faltan parámetros id o target' })
            };
        }

        // Inicializar array si no existe
        if (!messages[target]) {
            messages[target] = [];
        }

        // Agregar mensaje
        messages[target].push({
            from: id,
            data: data,
            timestamp: Date.now()
        });

        // Limitar a 10 mensajes por destinatario
        if (messages[target].length > 10) {
            messages[target] = messages[target].slice(-10);
        }

        // Limpiar mensajes antiguos (más de 30 segundos)
        const now = Date.now();
        messages[target] = messages[target].filter(msg => 
            now - msg.timestamp < 30000
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                success: true,
                message: 'Señal enviada correctamente'
            })
        };

    } catch (error) {
        console.error('❌ Error en signal:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message || 'Error interno' })
        };
    }
};