// netlify/functions/poll.js

// Objeto para almacenar mensajes (compartido con signal.js)
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
        // Verificar que sea GET
        if (event.httpMethod !== 'GET') {
            return {
                statusCode: 405,
                headers,
                body: JSON.stringify({ error: 'Método no permitido' })
            };
        }

        // Obtener ID de los query parameters
        const { id } = event.queryStringParameters || {};

        console.log(`🔄 Polling para: ${id}`);

        if (!id) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Falta el parámetro id' })
            };
        }

        // Obtener mensajes para este ID
        const userMessages = messages[id] || [];
        
        // Limpiar mensajes después de leerlos
        messages[id] = [];

        // Limpiar mensajes antiguos periódicamente
        const now = Date.now();
        for (const key in messages) {
            if (messages[key] && Array.isArray(messages[key])) {
                messages[key] = messages[key].filter(msg => 
                    now - msg.timestamp < 30000
                );
                
                // Eliminar array vacío
                if (messages[key].length === 0) {
                    delete messages[key];
                }
            }
        }

        console.log(`📨 Enviando ${userMessages.length} mensajes a ${id}`);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(userMessages)
        };

    } catch (error) {
        console.error('❌ Error en poll:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message || 'Error interno' })
        };
    }
};