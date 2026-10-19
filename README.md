# ⚓ Batalla Naval

Batalla naval online para dos jugadores. Uno crea la partida, le pasa el link a un amigo, y juegan cada uno desde su navegador: en vivo o de a ratos, cada uno dispara cuando le toca.

## Cómo se juega

1. **Nueva partida**: te da un código de 5 letras y un link para compartir. Mientras tu amigo no entra, ya podés ubicar tus barcos.
2. Tu amigo abre el link (o pone el código y toca **Unirse**) y entra directo a la partida.
3. Cada uno ubica sus barcos (tocando el tablero, o con **Al azar**) y toca **¡Listo!**.
4. Se sortea quién arranca y se dispara por turnos. Gana quien hunde primero toda la flota rival.
5. Al terminar se puede pedir **Revancha**.

Flota: portaaviones (5), acorazado (4), crucero (3), submarino (3) y destructor (2). Hay chat entre los dos jugadores.

### Jugar de a ratos

- La partida queda guardada: podés cerrar el juego y volver cuando quieras. En el inicio, **Mis partidas** muestra todas tus partidas y en cuáles te toca.
- **Avisos**: si los activás, te llega una notificación cuando te toca, cuando tu rival te escribe o cuando pide la revancha (no llegan si tenés esa partida abierta en pantalla). Si pasa un día sin que juegues tu turno, llega un recordatorio.
  - En Android y en la compu funcionan desde el navegador.
  - En iPhone (iOS 16.4 o más nuevo) primero hay que agregar el juego a la pantalla de inicio (**Compartir → Agregar a inicio**) y abrirlo desde ese ícono.
- Tus partidas se guardan en el navegador (no hay cuentas). Con **Pasar mis partidas a otro dispositivo** se genera un link para seguirlas desde otro lado; quien tenga ese link puede jugar en tu lugar.
- Con la ✕ de una partida la quitás de tu lista. Si estaba en juego, cuenta como abandono y gana tu rival.
- Las partidas se borran solas después de 30 días sin jugadas.

## Cómo funciona

Es un Cloudflare Worker con dos partes:

- **`public/`**: la página del juego (HTML + CSS + JS, sin build), el service worker que muestra los avisos (`sw.js`) y el manifiesto para instalarla como app.
- **`src/`**: el servidor.
  - `worker.js`: cada partida es una "sala" (un [Durable Object](https://developers.cloudflare.com/durable-objects/)) identificada por su código. La sala guarda la partida entera (las dos flotas, los disparos, el chat) y aplica las reglas (`rules.js`). Los jugadores se conectan por WebSocket; cada jugada se manda a la sala y la sala le devuelve a cada uno lo que puede ver (nunca la flota del rival mientras se juega).
  - `push.js` y `webpush.js`: los avisos ([Web Push](https://developer.mozilla.org/docs/Web/API/Push_API)), hechos con WebCrypto y sin dependencias. Las claves VAPID con las que el servidor firma los avisos se generan solas la primera vez y quedan guardadas en un Durable Object, así que no hay nada que configurar.

Cada jugador se identifica con un token que genera su navegador al crear o unirse a la partida. Si se corta la conexión, al reconectar llega el estado completo de la partida.

Todo entra en el plan gratuito de Cloudflare (Durable Objects con almacenamiento SQLite).

## Publicar en Cloudflare

### Conectado a GitHub (Workers Builds)

En el panel de Cloudflare: **Workers & Pages → (el Worker `batalla-naval`) → Settings → Build**:

- **Build command**: *(vacío)*
- **Deploy command**: `npx wrangler deploy`
- Rama: `main`

La configuración (nombre, archivos estáticos y Durable Object) está en `wrangler.jsonc`. Cada push a `main` vuelve a publicar.

### Desde la terminal

```sh
npm install
npx wrangler login
npm run deploy
```

## Probarlo localmente

```sh
npm install
npm run dev
```

Abrí `http://localhost:8787` en dos navegadores distintos (o en una ventana normal y otra privada) y jugá contra vos mismo. En dos pestañas del mismo navegador no se puede, porque comparten la lista de partidas.

## Notas

- La partida está en el servidor: recargar la página, cerrar el navegador o cambiar de app no la corta.
- Los avisos necesitan HTTPS (en Cloudflare ya lo es). En `localhost` también funcionan para probar.
