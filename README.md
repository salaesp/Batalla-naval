# ⚓ Batalla Naval

Batalla naval online para dos jugadores. Uno crea la partida, le pasa el código (o el link) a un amigo, y juegan cada uno desde su navegador.

## Cómo se juega

1. **Crear partida**: te da un código de 5 letras y un link para compartir.
2. Tu amigo entra al link (o pone el código y toca **Unirse**).
3. Cada uno ubica sus barcos (a mano, tocando el tablero, o con **Al azar**) y toca **¡Listo!**.
4. Se sortea quién arranca y se dispara por turnos. Gana quien hunde primero toda la flota rival.
5. Al terminar podés pedir **Revancha** sin tener que reconectar.

Flota: portaaviones (5), acorazado (4), crucero (3), submarino (3) y destructor (2). Hay chat entre los dos jugadores.

## Cómo funciona

Es un Cloudflare Worker con dos partes:

- **`public/`**: la página del juego (HTML + CSS + JS, sin build).
- **`src/worker.js`**: el servidor. Cada partida es una "sala" (un [Durable Object](https://developers.cloudflare.com/durable-objects/)) identificada por su código. Los dos jugadores se conectan a la sala por WebSocket y la sala reenvía los mensajes de uno al otro.

La sala guarda los mensajes numerados. Si un jugador pierde la conexión un rato (por ejemplo, al cambiar de app en el celular para mandar el código), al volver se reconecta solo, recibe lo que se perdió y reenvía lo que no llegó a salir: la partida sigue donde estaba. Las salas se borran solas después de un día sin actividad.

Cada jugador guarda su propia flota: cuando el rival dispara, tu navegador responde si fue agua, tocado o hundido. Al final, el ganador muestra dónde estaban sus barcos.

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

Abrí `http://localhost:8787` en dos pestañas y jugá contra vos mismo.

## Notas

- Si un jugador recarga la página o cierra la pestaña, pierde su partida (su flota sólo está en su navegador) y hay que crear una nueva. Cambiar de app o bloquear el celular no corta la partida.
