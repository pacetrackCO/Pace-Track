# Señalización Netlify: contrato y límites

**Referencia histórica, no servicio activo.** El usuario pidió migrar el
funcionamiento a Replit PostgreSQL. Los clientes actuales usan `/api/sessions`
del servidor Express y no llaman estas funciones. Replit no sirve el directorio
`netlify`. Las instrucciones siguientes corresponden al endurecimiento anterior
de las rutas antiguas y no deben activarse para el nuevo despliegue.

Las rutas mantienen el servicio Netlify y el almacén `webrtc-signal`. No hay
llamadas activas a `signal`/`poll` en los clientes Firebase revisados. No cambiar
el emparejamiento del sector o PC a estas rutas sin implementar el emisor
autorizado y probar ambos dispositivos.

## Antes de activar

- Instalar la dependencia fijada `@netlify/blobs` 11.1.2 en el proceso de build
  de las funciones, con Node >=22.12.0. No se ha instalado ni publicado en
  Netlify durante esta revisión.
- Configurar `SIGNAL_SESSION_SECRET` mediante el flujo seguro del hosting
  efectivo. No reutilizar una credencial TURN ni asumir que un secreto del
  entorno Replit está disponible en Netlify.
- Implementar el emisor **autenticado y autorizado** de capacidades de pareja.
  `mintCapability` es una función interna del servidor, no un endpoint público.
  Cada participante recibe su propio token; el servidor decide `id`, `peer`
  y vencimiento. No dejar que el solicitante elija identidades arbitrarias.
- Configurar límites de solicitudes y creación/redención de sesiones en el
  hosting/emisor. El límite de cola no limita solicitudes HTTP ni consumo
  de cómputo; tampoco garantiza un máximo global de sesiones.
- Verificar el contrato de Netlify Blobs con un entorno de prueba autorizado.
  Las pruebas actuales emplean un doble del SDK, no el almacén desplegado.

Sin secreto válido se responde 503. Sin capacidad válida se responde 401, sin
abrir el almacén. No existe fallback de almacenamiento en memoria.

## Peticiones permitidas

`signal`: POST JSON `{id, target, data}` con `Authorization: Bearer <capacidad>`.
`poll`: GET con `?id=...` y la misma cabecera. No poner capacidades en URLs.
El token solo permite enviar de su `id` a su `peer`, o leer su propia bandeja
de ese par. Vencimiento predeterminado cinco minutos, máximo una hora.

Identificadores: ASCII alfanumérico, guion o guion bajo, 1–64 caracteres exactos;
no se transforman, recortan ni normalizan. Datos: oferta/respuesta SDP o ICE
con campos y tamaños limitados. Cuerpo máximo 20 KiB, señal máxima 16 KiB.
Cola: 32 mensajes pendientes por pareja, señales legibles durante cinco
minutos. Métodos y orígenes no permitidos se rechazan; CORS no sustituye la
autenticación.

## Almacenamiento y concurrencia

La versión anterior 8.1.0 del SDK solo tomaba `metadata` en `setJSON`; ignoraba
opciones condicionales. La versión fijada 11.1.2 implementa `onlyIfNew`,
`onlyIfMatch` y resultados `{modified, etag}`. Se revisó su código publicado
en npm, incluido el punto de entrada CommonJS y `getWithMetadata`.

Se usan lecturas fuertes y escrituras condicionales por ETag. La lectura de
una señal reemplaza exactamente esa versión por un marcador vacío, en lugar
de borrar incondicionalmente una señal nueva que haya llegado a la misma
posición. La cola reserva 32 posiciones por pareja, no una lista actualizada
sin protección ante concurrencia.

La caducidad es lógica: una señal caducada no se devuelve. Netlify Blobs no
ofrece en este contrato una opción de expiración automática del objeto;
un contenido caducado puede permanecer hasta el siguiente acceso de esa
pareja. Las posiciones vacías también permanecen. La limpieza global,
retención y cuotas de creación deben acordarse antes de activarlo.

Las pruebas de contrato cubren acceso sin token, firma/fecha inválida,
suplantación de identidad, otra pareja, entradas malformadas, límites de
tamaño/cola, fallos de almacenamiento y conflictos concurrentes. No
certifican reglas Firebase, disponibilidad de TURN ni acceso real al hosting.