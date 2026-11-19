# C√≥mo se mueve un archivo por Telegram (y qu√© se puede acelerar de verdad)

Notas de la capa de transferencia de TelePlayer: lo que impone el servidor, lo
que decide `teleproto` y d√≥nde quedan los m√°rgenes reales. Todo lo que sigue se
comprob√≥ leyendo `node_modules/teleproto/network/MediaScheduler.js` y
`BalancePolicy.js`, m√°s las respuestas del propio MTProto.

## 1. Reglas del servidor que no se negocian

`upload.getFile` exige:

| Regla | Consecuencia en el cliente |
| --- | --- |
| `offset` y `limit` m√∫ltiplos de 4 KB | Los rangos se alinean hacia abajo antes de pedirlos. |
| `limit ‚â§ 1 MB` | Ninguna petici√≥n pide m√°s de 1 MB. |
| La petici√≥n no cruza el borde de un bloque de 1 MB del archivo | Un pedido de 512 KB que empieza en 512 KB del bloque no invade el siguiente. |

Eso ya est√° codificado en `src/main/stream-range.ts` (`planPartRange`), incluido
el recorte del √∫ltimo tramo de cada parte, donde Telegram devuelve menos bytes
de los pedidos porque el archivo se acaba.

Los topes por archivo son del servidor, no del cliente:

- 2 000 000 000 bytes por mensaje en cuentas gratuitas.
- 4 000 000 000 bytes en cuentas Premium.

No hay forma de subir un archivo mayor en un solo mensaje: se parte en trozos de
ese tama√±o (`fileLimitFor` en `src/main/transfer.ts`) y se reconstruye al leerlo.
Cualquier promesa de "saltarse" el l√≠mite es falsa; lo que s√≠ se puede hacer es
que el troceado no cueste velocidad.

## 2. De d√≥nde sale el ancho de banda

`MediaScheduler` reparte cada archivo entre varias conexiones al centro de datos
de medios. La ventana de datos en vuelo es:

```
ventana = sessions √ó inFlight √ó partSize
```

Valores por defecto de `teleproto` (`BalancePolicy.js`):

| | sesiones | en vuelo por sesi√≥n | parte | ventana |
| --- | --- | --- | --- | --- |
| Descarga | 4 | 4 | 512 KB | 8 MB |
| Subida | 8 | 2 | 512 KB | 8 MB |

Una ventana de 8 MB solo llena enlaces muy lentos: con 100 ms de latencia y
8 MB en vuelo el techo te√≥rico ronda los 80 MB/s, pero en la pr√°ctica la cola se
vac√≠a antes porque cada respuesta llega y hay que volver a pedir. Con m√°s
ventana, la tuber√≠a no se queda esperando.

TelePlayer configura el cliente as√≠ (`src/main/telegram.ts`):

```ts
downloadPool: {
  partSize: 512 * 1024,
  requestRetries: 6,
  requestDeadlineMs: 20_000,
  download: { partSize: 512 * 1024, sessions: 8, inFlight: 4 },
  upload: { partSize: 512 * 1024, sessions: 8, inFlight: 4 }
}
```

Es decir, 16 MB de ventana por archivo, el doble que los valores de referencia.

Dos l√≠mites que s√≠ existen y se respetan:

- **Subida en los DC 2 y 4.** `MediaScheduler` recorta las sesiones de subida a 4
  en esos centros (`LIMITED_UPLOAD_DCS`, `LIMITED_UPLOAD_SESSIONS`). All√≠ la
  ventana efectiva es 4 √ó 4 √ó 512 KB = 8 MB. No es un castigo de la app: es el
  servidor protegiendo esos DC.
- **FLOOD_WAIT_N.** Pedir demasiados bloques seguidos devuelve una espera
  obligatoria. `MediaStreamer` la lee del error y espera ese tiempo (con techo
  de 90 s) en vez de reintentar con su propio backoff, que solo reinicia el
  contador del servidor.

El tama√±o de parte de subida sigue el criterio de `getAppropriatedPartSize` de
`teleproto`: 128 KB hasta 100 MB, 256 KB hasta 750 MB y 512 KB por encima.
Partes m√°s peque√±as no aceleran nada: multiplican peticiones y `saveFilePart`
tiene su propio coste por llamada.

## 3. Una sola cach√© para reproducir y descargar

Antes hab√≠a dos caminos de escritura:

- el streaming guardaba bloques de 512 KB en `<videoId><ext>` con un manifiesto
  `<videoId><ext>.tp.json`;
- la descarga completa abr√≠a el mismo archivo con un `WriteStream` y volv√≠a a
  bajar todo desde cero, borrando la cach√© parcial si se cancelaba.

Ahora `MediaStreamer.downloadAll()` recorre los mismos bloques de la misma
sesi√≥n. Guardar un v√≠deo que se estaba reproduciendo solo baja lo que falta, y
cancelar una descarga conserva lo descargado: al reintentar se retoma desde el
manifiesto.

Consecuencias pr√°cticas:

- Descargar tras ver 10 minutos de un v√≠deo no vuelve a pedir esos 10 minutos.
- Un archivo a medias ocupa espacio en la cach√© y se cuenta en `cacheInfo()`.
- `deleteVideo` y "borrar cach√©" siguen eliminando archivo y manifiesto juntos.

## 4. El salto en la barra de progreso

El error al saltar muy adelante no era de Telegram: eran tres fallos que se
sumaban.

1. **Tormenta de peticiones.** El `<input type="range">` aplicaba
   `element.currentTime` en cada `onChange`. Arrastrar la barra lanzaba decenas
   de peticiones de rango en pocos milisegundos, cada una cancelando la
   anterior, hasta que alguna llegaba a un estado que el reproductor no
   recuperaba.
   Ahora el valor se previsualiza y se aplica 180 ms despu√©s del √∫ltimo
   movimiento, con `flush` inmediato al soltar el dedo o el bot√≥n.

2. **Error pegajoso en el streamer.** `serve()` marcaba la sesi√≥n como
   `status: 'error'` ante cualquier fallo de un bloque y no la limpiaba nunca.
   El renderer ve√≠a ese estado y saltaba a la pantalla de error aunque el v√≠deo
   siguiera siendo reproducible.
   Ahora cada petici√≥n nueva limpia el error de la sesi√≥n, y un bloque que se
   escribe con √©xito tambi√©n lo limpia.

3. **Elemento de v√≠deo muerto.** Cuando Chromium descarta el elemento tras un
   rango fallido, no vuelve a intentarlo solo.
   Ahora el reproductor recarga el mismo origen (`key` del `<video>`), vuelve a
   la posici√≥n donde estaba y lo intenta hasta 3 veces con 4 s de separaci√≥n.
   Solo si eso falla aparece la pantalla de error.

Adem√°s, cerrar la sesi√≥n por inactividad ya no puede cortar una lectura en
curso: `close()` comprueba `active` y `pinned` (descarga completa en marcha), y
`prepare()` serializa la apertura para que dos peticiones simult√°neas no abran
el archivo dos veces.

## 5. Importar carpetas

Electron 32 elimin√≥ `File.path`. La ruta de un archivo arrastrado se obtiene con
`webUtils.getPathForFile()` en el preload (`src/preload/index.ts`) y se manda al
proceso principal, que:

1. Comprueba cada ruta con `stat`.
2. Si es un archivo de v√≠deo, lo encola en la carpeta actual.
3. Si es un directorio, lo recorre (`src/main/folder-import.ts`) saltando
   carpetas ocultas, del sistema y enlaces simb√≥licos, con topes de 4 000
   archivos y 12 niveles de profundidad.
4. Crea (o reutiliza por nombre) una carpeta de la biblioteca y encola cada
   v√≠deo con su subcarpeta en el t√≠tulo (`"Temporada 1 ¬∑ clip"`).

El mismo recorrido se usa desde "A√±adir carpeta", que abre un di√°logo de
directorios: sirve de respaldo cuando el arrastre no expone la ruta (por
ejemplo, al soltar desde un gestor que solo entrega `File` sin ruta).

## 6. Portadas y vista previa

La portada de una tarjeta es el fotograma 0 del propio archivo, no una captura
del `<video>` del renderer. El proceso principal lo extrae con ffmpeg
(`generateThumbnail` en `src/main/media.ts`):

```
ffmpeg -ss 0 -i <archivo> -frames:v 1 \
  -vf scale=320:320:force_original_aspect_ratio=increase,crop=320:320 \
  -q:v 5 <videoId>.jpg
```

- 320√ó320 es el tama√±o al que Telegram satura sus propios `thumb`; el recorte
  centrado evita que las tarjetas cambien de proporci√≥n entre un 16:9 y un
  vertical.
- El JPEG vive en la cach√© de miniaturas (`getThumbPath`) y se sirve por
  `tp-media://thumb/<videoId>`, as√≠ que la tarjeta lo pinta al instante.
- El mismo archivo se sube como `thumb` del mensaje, para que la videoteca se
  vea igual desde el m√≥vil. Cada parte sube su propia copia: el `file_id` de una
  subida temporal se reclama al enviar el mensaje y no se puede reutilizar en el
  siguiente.
- Si ffmpeg no est√° o el archivo no se deja leer, el v√≠deo se sube igual y la
  tarjeta ense√±a el degradado de siempre. La portada es decorativa; la
  importaci√≥n no depende de ella.

`ffmpeg-static` es dependencia de desarrollo y el instalador lleva el binario en
`resources/bin/ffmpeg.exe` (unos 40 MB m√°s de instalador, el precio de no
depender de un ffmpeg instalado en el sistema).

Los v√≠deos que ya estaban en la biblioteca no tienen portada hasta que exista
una copia local o unos bloques en la cach√© progresiva. Al abrir la biblioteca se
encolan esos v√≠deos (dos a la vez, una sola vez por sesi√≥n) y se genera la
portada desde el archivo; el renderer la recibe por el evento `library:thumb`
sin recargar la lista. Los que solo viven en Telegram estrenan portada cuando se
reproducen una vez: al cerrar la sesi√≥n de streaming, los bloques que quedan en
disco se usan para sacar el fotograma.

### Vista previa al pasar el rat√≥n

`VideoCard` reproduce los primeros 10 s del v√≠deo sobre la portada:

- 450 ms de espera antes de pedir nada: cruzar la rejilla no abre una sesi√≥n por
  tarjeta.
- Una sola vista previa a la vez (`activePreviewStop`): la tarjeta anterior se
  detiene antes de que arranque la siguiente.
- Solo en dispositivos con puntero real (`matchMedia('(hover: hover)')`); en
  pantalla t√°ctil el toque sigue abriendo el reproductor.
- El `<video>` va silenciado y sin controles; a los 10 s se pausa y la tarjeta
  vuelve a la portada. El men√∫ contextual o el clic la paran de inmediato.
- La vista previa usa la misma cach√© progresiva que el reproductor: los bloques
  que baja no se tiran, y el v√≠deo se abre en el segundo cero cuando se pulsa.
  Si nadie sigue leyendo, el streamer cierra la sesi√≥n a los 25 s.
- Para una vista previa el colch√≥n de descarga baja a 2 MB
  (`PREVIEW_PREFETCH_BYTES`): 10 s de v√≠deo no necesitan el margen de 16 s que
  se calcula por bitrate para el reproductor. Al abrir el v√≠deo de verdad se
  vuelve al colch√≥n normal.

**Portada negra.** Muchos v√≠deos empiezan con un fundido desde negro y el
fotograma 0 sale casi liso. `generateCover()` comprueba el tama√±o del JPEG: si
no llega a 3 500 bytes, extrae otro fotograma a los 2,5 s y se queda el que
tenga m√°s detalle. El segundo intento solo cuesta cuando el primero falla.

**Regenerar portadas.** Ajustes incluye "Regenerar portadas que falten". Para
cada v√≠deo sin portada:

1. Si hay copia local, se genera desde el archivo.
2. Si no, se piden a Telegram los primeros 8 MB (`headCover`) a un temporal y
   se prueba con ellos.

La segunda v√≠a funciona en formatos con el √≠ndice al principio (`moov` delante,
como el MP4 de c√°mara o el WebM). Un MP4 con el √≠ndice al final no se puede leer
a medias y se queda sin portada hasta que exista una copia completa: es una
limitaci√≥n del contenedor, no del generador.

## 7. Subida: reintentos, cola y duplicados

**Reintento por parte.** Antes, un solo fallo de `saveFilePart` (un corte de red,
un timeout) abortaba el archivo entero. Ahora cada parte tiene hasta 5 intentos
(`savePartWithRetry` en `src/main/transfer.ts`) con backoff exponencial y
jitter, y respetando `FLOOD_WAIT_N` con el mismo techo de 90 s que la descarga.
Una parte cuesta unos cientos de KB; reintentarla es mucho m√°s barato que
reempezar la importaci√≥n.

**Dos archivos a la vez.** La cola de importaci√≥n mantiene
`IMPORT_CONCURRENCY = 2`. El pool de subida ya reparte cada archivo entre 8
sesiones, as√≠ que subir dos no duplica el ancho de banda, pero evita que una
carpeta de clips cortos avance de uno en uno mientras el resto espera. El orden
de los archivos se conserva.

**Duplicados.** Al encolar se compara nombre (sin distinguir may√∫sculas) y
tama√±o exacto contra el √≠ndice de la biblioteca. Un archivo repetido no se vuelve
a subir y se cuenta aparte: `ImportBatchResult.duplicates`, que el renderer
resume en el aviso ("3 repetidos omitidos"). Esto protege sobre todo de volver a
soltar la misma carpeta.

## 8. La cach√© parcial sobrevive al reinicio

`cleanupOrphanedCache()` borraba al arrancar todo lo que no estuviera en
`state.cache`, es decir, cada archivo de la cach√© progresiva. La promesa de
"reanudar donde lo dejaste" mor√≠a al cerrar la app.

Ahora el arranque conserva los pares v√°lidos v√≠deo + manifiesto:

- El manifiesto tiene que ser de la versi√≥n actual, con el mismo tama√±o de bloque
  (512 KB) y un `totalSize` mayor que cero.
- Un manifiesto sin su v√≠deo (o al rev√©s) se descarta: no sirve para reanudar.
- `cacheInfo()` devuelve `partialBytes` y `partialFiles` aparte de las descargas
  completas, y `pruneCache()` los cuenta en el l√≠mite: si hace falta espacio, se
  van primero las descargas completas m√°s viejas y despu√©s los bloques
  progresivos con m√°s tiempo sin tocarse.
- Ajustes muestra esos bytes como "v√≠deos a medio guardar", porque ocupan disco
  igual que una descarga.


## 9. Historial paginado

La biblioteca pedÌa 1 500 mensajes en cada arranque. En un canal con aÒos de
backup eso es tiempo, cuota de red y un Ìndice en memoria que casi nadie mira
entero.

Ahora se pide una p·gina del historial y se pide m·s solo cuando hace falta:

- `PAGE_SIZE = 400` mensajes por p·gina, de m·s nuevo a m·s antiguo.
- `libraryCursor` guarda el id m·s antiguo visto. `messages.getHistory` con
  `offsetId` es exclusivo, asÌ que la p·gina siguiente empieza justo detr·s sin
  repetir mensajes ni necesitar un cursor persistido.
- `Library.hasMore` dice al renderer si quedan p·ginas. La rejilla muestra
  "Cargar vÌdeos anteriores" solo en ese caso.
- `loadMore()` funde la p·gina nueva con el Ìndice (`mergePage`). Un vÌdeo cuyas
  partes caen a caballo entre dos p·ginas no se duplica: las partes se unen por
  `messageId`.
- Las carpetas que solo aparecen en una p·gina antigua se recrean al vuelo
  (`rememberFolders`) para que el filtro siga completo.
- `open()`, `download()`, `deleteVideo()`, `moveVideo()` y `renameVideo()` usan
  `ensureIndexed()`: si el vÌdeo no est· en la primera p·gina, piden p·ginas
  hasta encontrarlo. Abrir un vÌdeo viejo no obliga a pulsar "Cargar m·s".
- Un refresco silencioso (importaciÛn terminada, descarga completa) vuelve a
  pedir las mismas p·ginas que habÌa abiertas en vez de devolver la vista a la
  primera.

Cuando se agota el historial (`hasMore === false`) el Ìndice es la biblioteca
real y se limpian las portadas de vÌdeos que ya no existen (`pruneThumbs`).
Antes de eso no se toca nada: un vÌdeo de una p·gina no cargada a˙n podrÌa
perder su portada.

## 10. Importaciones que se pueden cancelar y reintentar

Antes, la ficha de importaciÛn nacÌa cuando el archivo empezaba a subir. Un
archivo en cola no existÌa para el renderer y no habÌa forma de pararlo.

Ahora cada trabajo se crea al encolarse (`status: 'queued'`) y vive en
`importJobs`:

- `imports()` devuelve las fichas vivas. El renderer las pide al arrancar y al
  reconectar, asÌ que la bandeja reaparece con lo que siga subiendo.
- `cancelImport()` aborta el `AbortController` del trabajo si ya est· subiendo
  (`uploadRange` y las esperas respetan la seÒal) o lo saca de la cola si a˙n no
  arrancÛ. No se borra la ficha: queda como `cancelled` con su botÛn de
  reintentar.
- `retryImport()` reencola un trabajo `error` o `cancelled` con la misma ficha,
  un `videoId` nuevo y los contadores a cero.
- Las fichas ya no se autodestruyen a los dos minutos. Se quedan hasta que el
  usuario las quita, que es lo que permite reintentar un fallo de red.
- Los mensajes de las partes que sÌ llegaron a subirse se borran del canal
  (`deleteMessages`) cuando el trabajo falla o se cancela, para no dejar
  huÈrfanos.

## 11. Duplicados por contenido

Comparar nombre + tamaÒo protege de volver a soltar la misma carpeta, pero no de
un archivo renombrado. `fingerprintFile()` (`src/main/fingerprint.ts`) calcula
SHA-256 de:

- el tamaÒo,
- los primeros 256 KB,
- los ˙ltimos 256 KB.

Dos vÌdeos distintos que coincidan en tamaÒo y en ambos extremos son, en la
pr·ctica, el mismo archivo, y leer 512 KB por importaciÛn no cuesta gigas. La
huella se guarda por `videoId` en `state.fingerprints` y se borra al eliminar el
vÌdeo. Si un archivo no se deja leer, la importaciÛn sigue con la comprobaciÛn
por nombre y tamaÒo.

## 12. VerificaciÛn de tamaÒo al enviar

`sendFile` devuelve el mensaje creado. Antes se apuntaba su id sin mirar el
`document.size`. Si Telegram guardaba menos bytes que los enviados (una subida
truncada), el vÌdeo entraba en la biblioteca y fallaba al buscar en la lÌnea de
tiempo.

Ahora cada parte comprueba `document.size` contra los bytes enviados y lanza un
error si no coinciden. El trabajo queda en `error`, se borran las partes ya
subidas y se puede reintentar sin dejar basura en el canal.

## 13. Un solo formato de cachÈ

`MediaStreamer` y `AppStore` tenÌan cada uno su copia de `512 * 1024`, la
versiÛn del manifiesto y el sufijo `.tp.json`. Un cambio en uno dejaba al otro
leyendo manifiestos que no entendÌa, que es exactamente cÛmo se pierde una
reanudaciÛn.

Ahora ambos importan `CHUNK_SIZE`, `MANIFEST_VERSION`, `MANIFEST_SUFFIX` y
`manifestPathFor()` de `src/main/cache-format.ts`. `store.ts` conserva alias
locales con los nombres antiguos para no tocar el resto del archivo, pero el
valor sale de un ˙nico sitio.
