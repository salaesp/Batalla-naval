// Reglas del juego del lado del servidor. La flota tiene que coincidir con la de
// public/game.js.

export const SIZE = 10;
const LETTERS = 'ABCDEFGHIJ';
export const FLEET = [
  { id: 'portaaviones', name: 'Portaaviones', size: 5 },
  { id: 'acorazado', name: 'Acorazado', size: 4 },
  { id: 'crucero', name: 'Crucero', size: 3 },
  { id: 'submarino', name: 'Submarino', size: 3 },
  { id: 'destructor', name: 'Destructor', size: 2 },
];

export const validCoord = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;
export const coordName = (x, y) => `${LETTERS[x]}${y + 1}`;

export function cleanName(raw, fallback = 'Capitán') {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return name || fallback;
}

// Valida la flota que manda un jugador: todos los barcos, en línea recta, dentro
// del tablero y sin pisarse. Devuelve la flota lista para guardar, o null.
export function validFleet(ships) {
  if (!Array.isArray(ships) || ships.length !== FLEET.length) return null;
  const used = new Set();
  const fleet = [];
  for (const f of FLEET) {
    const ship = ships.find((s) => s && s.id === f.id);
    if (!ship || !Array.isArray(ship.cells) || ship.cells.length !== f.size) return null;
    const cells = ship.cells.map((c) => ({ x: c?.x, y: c?.y }));
    if (!cells.every((c) => validCoord(c.x, c.y))) return null;
    cells.sort((a, b) => a.x - b.x || a.y - b.y);
    const horizontal = cells.every((c) => c.y === cells[0].y);
    const vertical = cells.every((c) => c.x === cells[0].x);
    if (!horizontal && !vertical) return null;
    for (let i = 1; i < cells.length; i++) {
      const step = horizontal ? cells[i].x - cells[i - 1].x : cells[i].y - cells[i - 1].y;
      if (step !== 1) return null;
    }
    for (const c of cells) {
      const k = `${c.x},${c.y}`;
      if (used.has(k)) return null;
      used.add(k);
    }
    fleet.push({ id: f.id, name: f.name, size: f.size, cells, hits: 0 });
  }
  return fleet;
}
