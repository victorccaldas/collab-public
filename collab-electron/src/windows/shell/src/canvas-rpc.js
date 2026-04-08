import {
	tiles, getTile, defaultSize, snapToGrid,
} from "./canvas-state.js";

/**
 * Find a position for a new tile on the canvas.
 * Places the tile to the right of the farthest-right existing tile,
 * aligned to that tile's top edge, with a 1-grid-unit (20 px) gap.
 */
export function findAutoPlacement(existingTiles, width, height) {
	const GAP = 20; // 1 grid unit

	if (existingTiles.length === 0) {
		return { x: 0, y: 0 };
	}

	let maxRight = -Infinity;
	let alignY = 0;
	for (const t of existingTiles) {
		const right = t.x + t.width;
		if (right > maxRight) {
			maxRight = right;
			alignY = t.y;
		}
	}

	const x = Math.round((maxRight + GAP) / 20) * 20;
	const y = Math.round(alignY / 20) * 20;
	return { x, y };
}

/**
 * Create the canvas RPC request handler.
 *
 * Methods: tileList, tileCreate, tileRemove, tileMove, tileResize,
 *          viewportGet, viewportSet, terminalWrite, terminalRead,
 *          tileFocus.
 */
export function createCanvasRpc({
	tileManager, viewportState, viewport, workspaceManager,
	edgeIndicators,
}) {
	function respond(requestId, result) {
		window.shellApi.canvasRpcResponse({ requestId, result });
	}

	function respondError(requestId, code, message) {
		window.shellApi.canvasRpcResponse({
			requestId, error: { code, message },
		});
	}

	function requireTile(requestId, tileId) {
		const tile = getTile(tileId);
		if (!tile) {
			respondError(requestId, 3, "Tile not found");
			return null;
		}
		return tile;
	}

	return async function handleCanvasRpc(request) {
		const { requestId, method, params } = request;

		try {
			let result;
			switch (method) {
				case "tileList": {
					result = {
						tiles: tiles.map((t) => ({
							id: t.id,
							type: t.type,
							filePath: t.filePath,
							folderPath: t.folderPath,
							position: { x: t.x, y: t.y },
							size: { width: t.width, height: t.height },
						})),
					};
					break;
				}
				case "tileCreate": {
					const tileType = params.tileType || "note";
					const size = defaultSize(tileType);
					const pos = params.position
						? { x: params.position.x, y: params.position.y }
						: findAutoPlacement(tiles, size.width, size.height);

					let tile;
					if (tileType === "term") {
						tile = tileManager.createCanvasTile(
							"term", pos.x, pos.y,
						);
						tileManager.spawnTerminalWebview(tile);
					} else if (tileType === "graph") {
						const ws = workspaceManager.getActiveWorkspace();
						const wsPath = ws?.path ?? "";
						tile = tileManager.createGraphTile(
							pos.x, pos.y, params.filePath, wsPath,
						);
					} else {
						tile = tileManager.createFileTile(
							tileType, pos.x, pos.y, params.filePath,
						);
					}
					tileManager.saveCanvasImmediate();
					result = { tileId: tile.id };
					break;
				}
				case "tileRemove": {
					if (!requireTile(requestId, params.tileId)) return;
					tileManager.closeCanvasTile(params.tileId);
					result = {};
					break;
				}
				case "tileMove": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					const mx = params.position?.x;
					const my = params.position?.y;
					if (!Number.isFinite(mx) || !Number.isFinite(my)) {
						respondError(requestId, 4, "Invalid position");
						return;
					}
					tile.x = mx;
					tile.y = my;
					snapToGrid(tile);
					tileManager.repositionAllTiles();
					tileManager.saveCanvasImmediate();
					result = {};
					break;
				}
				case "tileResize": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					const rw = params.size?.width;
					const rh = params.size?.height;
					if (!Number.isFinite(rw) || !Number.isFinite(rh)) {
						respondError(requestId, 4, "Invalid size");
						return;
					}
					tile.width = rw;
					tile.height = rh;
					snapToGrid(tile);
					tileManager.repositionAllTiles();
					tileManager.saveCanvasImmediate();
					result = {};
					break;
				}
				case "viewportGet": {
					result = {
						pan: {
							x: viewportState.panX,
							y: viewportState.panY,
						},
						zoom: viewportState.zoom,
					};
					break;
				}
				case "viewportSet": {
					if (params.pan) {
						viewportState.panX = params.pan.x;
						viewportState.panY = params.pan.y;
					}
					if (params.zoom !== undefined) {
						viewportState.zoom = params.zoom;
					}
					viewport.updateCanvas();
					tileManager.saveCanvasDebounced();
					result = {};
					break;
				}
				case "terminalWrite": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					if (tile.type !== "term") {
						respondError(requestId, 4, "Tile is not a terminal");
						return;
					}
					if (!tile.ptySessionId) {
						respondError(requestId, 4, "Terminal has no session");
						return;
					}
					await window.shellApi.ptyWrite(
						tile.ptySessionId, params.input,
					);
					result = {};
					break;
				}
				case "terminalRead": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					if (tile.type !== "term") {
						respondError(requestId, 4, "Tile is not a terminal");
						return;
					}
					if (!tile.ptySessionId) {
						respondError(requestId, 4, "Terminal has no session");
						return;
					}
					const lines = params.lines ?? 50;
					const output = await window.shellApi.ptyCapture(
						tile.ptySessionId, lines,
					);
					result = { output };
					break;
				}
				case "tileFocus": {
					const ids = params.tileIds;
					if (!Array.isArray(ids) || ids.length === 0) {
						respondError(
							requestId, 4,
							"tileIds must be a non-empty array",
						);
						return;
					}
					const focusTiles = [];
					for (const id of ids) {
						const t = getTile(id);
						if (!t) {
							respondError(
								requestId, 3, `Tile not found: ${id}`,
							);
							return;
						}
						focusTiles.push(t);
					}
					edgeIndicators.panToTiles(focusTiles);
					result = {};
					break;
				}
				default: {
					respondError(
						requestId, -32601,
						`Unknown method: ${method}`,
					);
					return;
				}
			}
			respond(requestId, result);
		} catch (err) {
			respondError(
				requestId, -32603,
				err.message || "Internal error",
			);
		}
	};
}
