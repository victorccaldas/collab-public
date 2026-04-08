import { describe, test, expect } from "bun:test";
import { findAutoPlacement } from "./canvas-rpc.js";

interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe("findAutoPlacement", () => {
  test("places first tile at origin with no existing tiles", () => {
    const pos = findAutoPlacement([], 400, 500);
    expect(pos).toEqual({ x: 0, y: 0 });
  });

  test("places tile to the right of a single existing tile", () => {
    const existing: Tile[] = [
      { x: 0, y: 0, width: 400, height: 500 },
    ];
    const pos = findAutoPlacement(existing, 400, 500);
    // Should be right edge (400) + 20 gap = 420
    expect(pos).toEqual({ x: 420, y: 0 });
  });

  test("aligns to the y of the rightmost tile", () => {
    const existing: Tile[] = [
      { x: 0, y: 100, width: 200, height: 200 },
      { x: 300, y: 60, width: 200, height: 200 },
    ];
    const pos = findAutoPlacement(existing, 200, 200);
    // Rightmost edge is 300+200=500, y of that tile is 60
    expect(pos).toEqual({ x: 520, y: 60 });
  });

  test("result snaps to 20px grid", () => {
    const existing: Tile[] = [
      { x: 0, y: 0, width: 100, height: 100 },
    ];
    const pos = findAutoPlacement(existing, 100, 100);
    expect(pos.x % 20).toBe(0);
    expect(pos.y % 20).toBe(0);
  });

  test("places tile after a row of tiles", () => {
    const existing: Tile[] = [];
    for (let i = 0; i < 5; i++) {
      existing.push({
        x: i * 200, y: 0, width: 200, height: 200,
      });
    }
    const pos = findAutoPlacement(existing, 200, 200);
    // Rightmost edge is 4*200+200=1000, plus 20 gap
    expect(pos).toEqual({ x: 1020, y: 0 });
  });

  test("works with tiles at non-origin positions", () => {
    const existing: Tile[] = [
      { x: 2000, y: 1000, width: 400, height: 500 },
    ];
    const pos = findAutoPlacement(existing, 400, 500);
    expect(pos).toEqual({ x: 2420, y: 1000 });
  });
});
