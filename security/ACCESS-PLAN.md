# Acceso a salas y resultados tras la migración a Replit

## Alcance y comprobaciones

El usuario autorizó sustituir Firebase y las funciones Netlify por un servidor
en Replit con PostgreSQL. Se conservan las páginas y los cronómetros existentes.
Las reglas reales de los dos proyectos Firebase antiguos no están disponibles:
no se afirma que sean seguras, ni se modificaron datos, permisos o credenciales
en aquellos servicios. Tampoco se publicó la aplicación.

Los historiales del navegador siguen disponibles para exportar. Los registros
que existan solo en Firebase **no se han importado ni borrado**. Su importación
requiere una exportación o acceso autorizado por separado.

## Acceso mínimo activo

El contrato completo está en `server/API.md`.

- El servidor genera el UUID de sesión, dos permisos independientes y una
  invitación criptográfica. Nunca acepta roles o identidades elegidos por el
  invitado. Solo se guardan hashes de las credenciales en PostgreSQL.
- La invitación dura dos horas, se redime atómicamente una sola vez y vincula
  un único móvil/llegada. Los permisos del creador no se comparten con ella.
- El QR usa el origen actual de la aplicación. Su invitación viaja en un
  fragmento URL, no en parámetros que puedan quedar en logs del servidor.
  El móvil guarda su permiso antes de retirar el fragmento para poder recargar.
- PC: el creador puede leer sus resultados; el móvil emparejado puede crearlos.
  Los reintentos idénticos se confirman sin duplicar. Las modificaciones,
  borrados y accesos de otra sesión se rechazan en el servidor.
- Sector: salida publica su oferta e ICE; llegada publica su respuesta e ICE.
  Cada rol lee exclusivamente la señalización del otro. Solo el creador puede
  cerrar su sala. Las descripciones son inmutables y las señales están acotadas.
  Si llegada recarga después de haber publicado su respuesta, salida debe crear
  otra sala y compartir una nueva invitación. No se promete reconstruir una
  conexión WebRTC con señales anteriores ni se sobrescribe una respuesta guardada.
- Los permisos caducan: propietario PC hasta 30 días; invitaciones/móvil/salas
  sector hasta dos horas. La caducidad no borra los resultados. Los archivos
  locales permiten conservar/exportar el historial después.
- El servidor valida campos exactos, tamaños, fechas, duraciones, identificadores
  y pertenencia a sesión. Los límites de tráfico se guardan en PostgreSQL para
  compartirlos entre instancias; no son contadores en memoria.
- Las claves de cuotas son hashes con `SESSION_SECRET`. Se usa la dirección
  del socket, no un `X-Forwarded-For` arbitrario. Tras un proxy varios usuarios
  pueden compartir cuota; no se afirma que sea una identificación infalible
  de persona ni protección contra ataques distribuidos.
- La app sirve solo archivos públicos permitidos. No publica código de servidor,
  esquema, pruebas, secretos, repositorio ni funciones Netlify históricas.
- Contacto: los mensajes válidos se guardan en PostgreSQL, con límites por origen
  y tamaño. No hay un endpoint público para leerlos ni envío de correo implícito.

## TURN y conectividad

Las credenciales TURN estáticas se retiraron de todos los clientes públicos.
No se reintroducirán como solución a un problema de conexión.

El sector usa STUN mientras no haya un relay temporal autorizado. Esto puede
impedir el emparejamiento en redes restrictivas y se advierte en la pantalla.
No se ha revocado la credencial antigua en el proveedor: retirar el código
no revoca las copias descargadas.

Activar TURN temporal o revocar la credencial antigua requiere autorización
específica y configuración mediante el flujo seguro de secretos. La emisión
debe ser del servidor y solo para sesiones autorizadas, con expiración y cuotas
del proveedor. No añadir un endpoint público que entregue relay a cualquiera.

## Verificación y límites de la evidencia

- Pruebas de acceso: sin token, otra sesión, rol incorrecto, invitación
  reutilizada/caducada/cerrada, modificación de resultado confirmado, entrada
  malformada, exceso de candidatos, fallos de base de datos y fuente privada.
- Integración: servidor real y PostgreSQL de desarrollo, sesiones sintéticas;
  la prueba limpia exclusivamente los registros que ella creó.
- Navegador: emparejamiento PC/móvil, recuperación tras recarga, cola local,
  cronómetros y permisos con servicios/cámara simulados. No puede escribir
  contra servicios reales.
- No se certifican cámaras Android/iOS físicas, conectividad entre dos redes
  reales ni un despliegue público que no se ha realizado.

## Activación y recuperación

Antes de publicar, confirmar el despliegue con el usuario. Replit aplica el
esquema de desarrollo a su base gestionada de producción mediante Publish.
No ejecutar DDL en el arranque, contra producción ni en un hook de publicación.

Conservar un checkpoint del código y una copia/exportación de los datos antes
de cualquier importación o cambio incompatible. Esta migración no elimina
registros antiguos. La reversión del código no debe borrar las tablas nuevas.
Restaurar clientes antiguos reabriría sus riesgos de acceso: no es una
recuperación segura sin evaluar los permisos desplegados. Nunca recuperar
credenciales TURN expuestas como parte de un rollback.