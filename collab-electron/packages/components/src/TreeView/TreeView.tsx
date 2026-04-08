import React, {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	CaretRight,
	CaretDown,
	Terminal,
	Plus,
	Graph,
	Robot,
} from '@phosphor-icons/react';
import type { FlatItem } from './useFileTree';
import type { TreeNode } from '@collab/shared/types';
import {
	formatRelativeTime,
	displayFileName,
} from './Helpers';
import { displayBasename } from '@collab/shared/path-utils';
import type { SortMode } from './types';
import { SearchSortControls } from './SearchSortControls';
import type { SearchSortControlsHandle } from './SearchSortControls';
import { getFileIcon } from './fileIcons';
import { useImageThumbnail } from './useImageThumbnail';

const ICON_SIZE = 14;
export const ENABLE_GRAPH_TILES = true;

function flattenAllFiles(nodes: TreeNode[]): FlatItem[] {
	const items: FlatItem[] = [];
	function walk(children: TreeNode[]) {
		for (const node of children) {
			if (node.kind === 'file') {
				const fileName = displayBasename(node.path) || node.name;
				items.push({
					id: node.path,
					kind: 'file',
					level: 0,
					name: fileName,
					path: node.path,
					ctime: node.ctime,
					mtime: node.mtime,
				});
			}
			if (node.children) {
				walk(node.children);
			}
		}
	}
	walk(nodes);
	return items;
}

interface FolderRowProps {
	item: FlatItem;
	onToggle: (
		path: string,
		recursive: boolean,
	) => void;
	onCreateFile: (
		folderPath: string,
		name: string,
	) => void;
	onPlusClick?: (folderPath: string) => void;
	rowHeight: number;
	isRenaming: boolean;
	renameValue: string;
	renameInputRef: React.RefObject<HTMLInputElement | null>;
	onRenameChange: (value: string) => void;
	onRenameConfirm: () => void;
	onRenameCancel: () => void;
	onContextMenu?: (
		e: React.MouseEvent,
		item: FlatItem,
	) => void;
	isDropTarget: boolean;
	onDragStart?: (
		e: React.DragEvent,
		path: string,
	) => void;
	onDragOver?: (
		e: React.DragEvent,
		folderPath: string,
	) => void;
	onDragLeave?: () => void;
	onDrop?: (
		e: React.DragEvent,
		targetFolder: string,
	) => void;
	onDragEnd?: () => void;
	onSelectFolder?: (path: string) => void;
}

const FolderRow = React.memo(function FolderRow({
	item,
	onToggle,
	onCreateFile,
	onPlusClick,
	rowHeight,
	isRenaming,
	renameValue,
	renameInputRef,
	onRenameChange,
	onRenameConfirm,
	onContextMenu,
	onRenameCancel,
	isDropTarget,
	onDragStart,
	onDragOver,
	onDragLeave,
	onDrop,
	onDragEnd,
	onSelectFolder,
}: FolderRowProps) {
	const style: React.CSSProperties = {
		paddingLeft: `${item.level * 16 + 8}px`,
	};

	return (
		<div
			className={`collection-tree-row collection-folder-row${isDropTarget ? ' drop-target' : ''}`}
			style={style}
			draggable
			onDragStart={(e) =>
				onDragStart?.(e, item.path)
			}
			onDragOver={(e) =>
				onDragOver?.(e, item.path)
			}
			onDragLeave={onDragLeave}
			onDrop={(e) =>
				onDrop?.(e, item.path)
			}
			onDragEnd={onDragEnd}
			onClick={(e) =>
				onToggle(item.path, e.altKey)
			}
			onContextMenu={(e) => {
				e.preventDefault();
				onContextMenu?.(e, item);
			}}
		>
			<span className="collection-tree-caret">
				{item.isExpanded ? (
					<CaretDown
						size={10}
						weight="bold"
					/>
				) : (
					<CaretRight
						size={10}
						weight="bold"
					/>
				)}
			</span>
			{isRenaming ? (
				<input
					ref={renameInputRef}
					className="inline-rename-input"
					value={renameValue}
					onChange={(e) =>
						onRenameChange(e.target.value)
					}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							onRenameConfirm();
						} else if (
							e.key === 'Escape'
						) {
							e.preventDefault();
							onRenameCancel();
						}
					}}
					onBlur={onRenameConfirm}
					onClick={(e) =>
						e.stopPropagation()
					}
				/>
			) : (
				<span className="collection-tree-name">
					{item.name}
				</span>
			)}
			{item.childCount != null && (
				<span className="collection-tree-count">
					{item.childCount}
				</span>
			)}
			<button
				className="folder-action-button"
				title="Add to folder"
				onClick={(e) => {
					e.stopPropagation();
					if (onPlusClick) {
						onPlusClick(item.path);
					} else {
						onCreateFile(item.path, '');
					}
				}}
			>
				<Plus size={12} weight="bold" />
			</button>
			<button
				className="folder-action-button"
				title="Open in Terminal"
				onClick={(e) => {
					e.stopPropagation();
					window.api.openInTerminal(
						item.path,
					);
				}}
			>
				<Terminal size={12} weight="bold" />
			</button>
			<button
				className="folder-action-button"
				title="Open AI agent"
				onClick={async (e) => {
					e.stopPropagation();
					const choice = await window.api.showContextMenu([
						{ id: "claude", label: "Claude (Opus)" },
						{ id: "copilot", label: "Copilot (Opus)" },
						{ id: "claude-test", label: "Claude-test (Haiku)" },
						{ id: "copilot-test", label: "Copilot-test (GPT-5 Mini)" },
					]);
					if (!choice) return;
					const FALLBACK_PROMPT = "Let's begin the session";
					const saved = await window.api.getPref("aiAgentDefaultPrompt");
					const defaultPrompt = (typeof saved === "string" && saved) ? saved : FALLBACK_PROMPT;
					const promptChoice = await window.api.showContextMenu([
						{ id: "default", label: `Default: "${defaultPrompt}"` },
						{ id: "custom", label: "Custom prompt..." },
						{ id: "change-default", label: "Change default prompt..." },
					]);
					if (!promptChoice) return;
					if (promptChoice === "change-default") {
						const input = await window.api.showInputDialog({
							title: "Set default prompt",
							label: "Default prompt:",
							defaultValue: defaultPrompt,
						});
						if (input !== null && input.trim()) {
							await window.api.setPref("aiAgentDefaultPrompt", input.trim());
						}
						return;
					}
					let q = defaultPrompt;
					if (promptChoice === "custom") {
						const input = await window.api.showInputDialog({
							title: "Custom prompt",
							label: "Enter your prompt:",
							defaultValue: "",
						});
						if (input === null) return;
						q = input.trim() || defaultPrompt;
					}
					const cmds: Record<string, string> = {
						claude: `claude --dangerously-skip-permissions --model opus "${q}"`,
						copilot: `copilot --yolo --model claude-opus-4.6 -i "${q}"`,
						"claude-test": `claude --dangerously-skip-permissions --model haiku "${q}"`,
						"copilot-test": `copilot --yolo --model gpt-5-mini -i "${q}"`,
					};
					const cmd = cmds[choice];
					if (cmd) window.api.openInTerminal(item.path, cmd);
				}}
			>
				<Robot size={12} weight="bold" />
			</button>
			{ENABLE_GRAPH_TILES && (
				<button
					className="folder-action-button"
					title="Open graph view"
					onClick={(e) => {
						e.stopPropagation();
						if (typeof window.api.createGraphTile === "function") {
							window.api.createGraphTile(item.path);
						}
					}}
				>
					<Graph size={12} weight="bold" />
				</button>
			)}
		</div>
	);
});

export interface FileRowProps {
	item: FlatItem;
	isSelected: boolean;
	isMultiSelected?: boolean;
	isDeleteConfirm?: boolean;
	onItemClick: (
		path: string,
		e: { metaKey: boolean; shiftKey: boolean },
	) => void;
	onDelete?: (
		e: React.MouseEvent,
		path: string,
	) => void;
	onDeleteCancel?: () => void;
	isRenaming?: boolean;
	renameValue?: string;
	renameInputRef?: React.RefObject<HTMLInputElement | null>;
	onRenameChange?: (value: string) => void;
	onRenameConfirm?: () => void;
	onRenameCancel?: () => void;
	onContextMenu?: (
		e: React.MouseEvent,
		item: FlatItem,
	) => void;
	onDragStart?: (
		e: React.DragEvent,
		path: string,
	) => void;
	onDragEnd?: () => void;
	sortMode?: SortMode;
}

export const FileRow = React.memo(
	function FileRow({
		item,
		isSelected,
		isMultiSelected = false,
		isDeleteConfirm = false,
		onItemClick,
		onDelete,
		onDeleteCancel,
		isRenaming = false,
		renameValue = '',
		renameInputRef,
		onRenameChange,
		onRenameConfirm,
		onContextMenu,
		onRenameCancel,
		onDragStart,
		onDragEnd,
		sortMode,
	}: FileRowProps) {
		const { stem, ext } = displayFileName(
			item.name,
		);
		const thumbnailUrl = useImageThumbnail(item.path, ICON_SIZE * 4);
		const showTimestamp = !sortMode?.startsWith('alpha');

		return (
			<div
				data-item-id={item.path}
				className={`collection-tree-row collection-item-row${isSelected ? ' isFocused' : ''}${isMultiSelected ? ' isMultiSelected' : ''}`}
				style={{
					paddingLeft: `${item.level * 16 + 8}px`,
				}}
				draggable
				onDragStart={(e) =>
					onDragStart?.(e, item.path)
				}
				onDragEnd={onDragEnd}
				onClick={(e) =>
					onItemClick(item.path, {
						metaKey: e.metaKey,
						shiftKey: e.shiftKey,
					})
				}
				onContextMenu={(e) => {
					e.preventDefault();
					onContextMenu?.(e, item);
				}}
				onMouseLeave={() => {
					if (isDeleteConfirm)
						onDeleteCancel?.();
				}}
			>
				<span className="item-icon">
					{thumbnailUrl ? (
						<img
							src={thumbnailUrl}
							width={ICON_SIZE}
							height={ICON_SIZE}
							style={{
								borderRadius: 2,
								objectFit: "cover",
							}}
							alt=""
						/>
					) : (() => {
						const { icon: IconComp, color } = getFileIcon(item.name);
						return (
							<IconComp
								size={ICON_SIZE}
								weight="regular"
								style={{ color }}
							/>
						);
					})()}
				</span>
				{isRenaming ? (
					<input
						ref={renameInputRef}
						className="inline-rename-input"
						value={renameValue}
						onChange={(e) =>
							onRenameChange(e.target.value)
						}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								onRenameConfirm();
							} else if (e.key === 'Escape') {
								e.preventDefault();
								onRenameCancel();
							}
						}}
						onBlur={onRenameConfirm}
						onClick={(e) => e.stopPropagation()}
					/>
				) : (
					<span className="item-text">
						{stem}
						{ext && (
							<span style={{ opacity: 0.4 }}>
								{ext}
							</span>
						)}
					</span>
				)}
				<div className="row-action-buttons">
					{showTimestamp && (
						<span className="row-timestamp">
							{formatRelativeTime(item.ctime)}
						</span>
					)}
				</div>
			</div>
		);
	},
	(prev, next) =>
		prev.item.id === next.item.id &&
		prev.item.name === next.item.name &&
		prev.item.ctime === next.item.ctime &&
		prev.isSelected === next.isSelected &&
		prev.isMultiSelected ===
			next.isMultiSelected &&
		prev.isDeleteConfirm ===
			next.isDeleteConfirm &&
		prev.item.level === next.item.level &&
		prev.onItemClick === next.onItemClick &&
		prev.onDelete === next.onDelete &&
		prev.isRenaming === next.isRenaming &&
		prev.renameValue === next.renameValue &&
		prev.onContextMenu === next.onContextMenu &&
		prev.onDragStart === next.onDragStart &&
		prev.onDragEnd === next.onDragEnd &&
		prev.sortMode === next.sortMode,
);

interface TreeViewProps {
	flatItems: FlatItem[];
	selectedPath: string | null;
	selectedPaths: Set<string>;
	onItemClick: (
		path: string,
		e: { metaKey: boolean; shiftKey: boolean },
	) => void;
	onToggleFolder: (
		path: string,
		recursive: boolean,
	) => void;
	onCreateFile: (
		folderPath: string,
		name: string,
	) => void;
	onPlusClick?: (folderPath: string) => void;
	onContextMenu?: (
		e: React.MouseEvent,
		item: FlatItem | null,
	) => void;
	onDeleteFile?: (path: string) => void;
	onDeleteFiles?: (paths: string[]) => void;
	sortMode: SortMode;
	onCycleSortMode: () => void;
	leadingContent?: React.ReactNode;
	renamingPath?: string | null;
	renameValue?: string;
	renameInputRef?: React.RefObject<HTMLInputElement | null>;
	onRenameChange?: (value: string) => void;
	onRenameConfirm?: () => void;
	onRenameCancel?: () => void;
	dropTargetPath?: string | null;
	onDragStart?: (
		e: React.DragEvent,
		path: string,
	) => void;
	onDragOver?: (
		e: React.DragEvent,
		folderPath: string,
	) => void;
	onDragLeave?: () => void;
	onDrop?: (
		e: React.DragEvent,
		targetFolder: string,
	) => void;
	onDragEnd?: () => void;
	workspacePath?: string;
	cursorPath?: string | null;
	onSelectFolder?: (path: string) => void;
	isActive?: boolean;
	searchRef?: React.RefObject<SearchSortControlsHandle | null>;
}

export const TreeView: React.FC<
	TreeViewProps
> = ({
	flatItems,
	selectedPath,
	selectedPaths,
	onItemClick,
	onToggleFolder,
	onCreateFile,
	onPlusClick,
	onContextMenu,
	onDeleteFile,
	sortMode,
	onCycleSortMode,
	leadingContent,
	renamingPath,
	renameValue,
	renameInputRef,
	onRenameChange,
	onRenameConfirm,
	onRenameCancel,
	dropTargetPath,
	onDragStart,
	onDragOver,
	onDragLeave,
	onDrop,
	onDragEnd,
	workspacePath,
	cursorPath,
	onSelectFolder,
	isActive = true,
	searchRef,
}) => {
	const [searchQuery, setSearchQuery] = useState('');
	const [deleteConfirmId, setDeleteConfirmId] =
		useState<string | null>(null);
	const [allFiles, setAllFiles] = useState<FlatItem[] | null>(null);
	const isSearching = searchQuery.trim().length > 0;

	useEffect(() => {
		if (!isSearching || !workspacePath) {
			setAllFiles(null);
			return;
		}
		if (allFiles) return;
		let cancelled = false;
		window.api.readTree({ root: workspacePath }).then((tree: TreeNode[]) => {
			if (cancelled) return;
			setAllFiles(flattenAllFiles(tree));
		});
		return () => { cancelled = true; };
	}, [isSearching, workspacePath, allFiles]);

	const filteredItems = useMemo(() => {
		if (!searchQuery.trim()) return flatItems;
		const query = searchQuery.toLowerCase();
		const source = allFiles ?? flatItems;
		return source.filter((item) => {
			if (item.kind === 'folder') return true;
			return item.name
				.toLowerCase()
				.includes(query);
		});
	}, [flatItems, allFiles, searchQuery]);

	const deleteConfirmRef = useRef(deleteConfirmId);
	deleteConfirmRef.current = deleteConfirmId;

	const handleDelete = useCallback(
		(
			e: React.MouseEvent,
			filePath: string,
		) => {
			e.preventDefault();
			e.stopPropagation();
			if (
				deleteConfirmRef.current === filePath
			) {
				onDeleteFile?.(filePath);
				setDeleteConfirmId(null);
			} else {
				setDeleteConfirmId(filePath);
			}
		},
		[onDeleteFile],
	);

	const handleDeleteCancel = useCallback(() => {
		setDeleteConfirmId(null);
	}, []);

	const containerRef =
		useRef<HTMLDivElement>(null);
	const [folderRowHeight, setFolderRowHeight] =
		useState(0);

	useLayoutEffect(() => {
		if (
			folderRowHeight > 0 ||
			!containerRef.current
		)
			return;
		const el =
			containerRef.current.querySelector(
				'.collection-folder-row',
			);
		if (el) {
			setFolderRowHeight(
				el.getBoundingClientRect().height,
			);
		}
	}, [folderRowHeight, filteredItems]);

	useEffect(() => {
		if (!selectedPath || !containerRef.current)
			return;
		const el = containerRef.current.querySelector(
			`[data-item-id="${CSS.escape(selectedPath)}"]`,
		);
		if (!el) return;
		const container = containerRef.current;
		const elRect = el.getBoundingClientRect();
		const boxRect =
			container.getBoundingClientRect();
		const top = elRect.top - boxRect.top;
		const bottom = elRect.bottom - boxRect.top;

		if (top < 0) {
			container.scrollTop += top;
		} else if (bottom > container.clientHeight) {
			container.scrollTop +=
				bottom - container.clientHeight;
		}
	}, [selectedPath, filteredItems]);

	const lastSelectedIndexRef = useRef<number>(-1);

	const navigableItems = useMemo(
		() =>
			filteredItems.filter(
				(item) => item.kind === 'file',
			),
		[filteredItems],
	);

	useEffect(() => {
		const idx = navigableItems.findIndex(
			(d) => d.path === selectedPath,
		);
		if (idx >= 0)
			lastSelectedIndexRef.current = idx;
	}, [navigableItems, selectedPath]);

	const navigateItems = useCallback(
		(direction: 'up' | 'down', shiftKey: boolean) => {
			if (navigableItems.length === 0) return;

			const effectivePath =
				cursorPath ?? selectedPath;
			let currentIndex =
				navigableItems.findIndex(
					(d) => d.path === effectivePath,
				);

			if (
				currentIndex < 0 &&
				lastSelectedIndexRef.current >= 0
			) {
				currentIndex = Math.min(
					lastSelectedIndexRef.current,
					navigableItems.length - 1,
				);
			}

			let nextIndex: number;
			if (direction === 'down') {
				nextIndex =
					currentIndex < 0
						? 0
						: Math.min(
								currentIndex + 1,
								navigableItems.length -
									1,
							);
			} else {
				nextIndex =
					currentIndex < 0
						? 0
						: Math.max(
								currentIndex - 1,
								0,
							);
			}

			lastSelectedIndexRef.current = nextIndex;
			const next = navigableItems[nextIndex];
			if (!next) return;

			onItemClick(next.path, {
				metaKey: false,
				shiftKey,
			});

			const container = containerRef.current;
			const el = container?.querySelector(
				`[data-item-id="${CSS.escape(next.path)}"]`,
			);
			if (el && container) {
				const elRect =
					el.getBoundingClientRect();
				const boxRect =
					container.getBoundingClientRect();
				const stickyTop =
					next.level * folderRowHeight;
				const top =
					elRect.top - boxRect.top;
				const bottom =
					elRect.bottom - boxRect.top;

				if (top < stickyTop) {
					container.scrollTop +=
						top - stickyTop;
				} else if (
					bottom > container.clientHeight
				) {
					container.scrollTop +=
						bottom -
						container.clientHeight;
				}
			}
		},
		[
			navigableItems,
			selectedPath,
			cursorPath,
			onItemClick,
			folderRowHeight,
		],
	);

	useEffect(() => {
		if (!isActive) return;

		const handleKeyDown = (
			e: KeyboardEvent,
		) => {
			if (
				e.key !== 'ArrowUp' &&
				e.key !== 'ArrowDown'
			)
				return;

			const active = document.activeElement;
			if (
				active?.tagName === 'INPUT' ||
				active?.tagName === 'TEXTAREA'
			)
				return;

			e.preventDefault();
			navigateItems(
				e.key === 'ArrowDown' ? 'down' : 'up',
				e.shiftKey,
			);
		};

		window.addEventListener(
			'keydown',
			handleKeyDown,
		);
		return () =>
			window.removeEventListener(
				'keydown',
				handleKeyDown,
			);
	}, [isActive, navigateItems]);

	const renderItems = (
		start: number,
		minLevel: number,
	): [React.ReactNode[], number] => {
		const nodes: React.ReactNode[] = [];
		let i = start;

		while (i < filteredItems.length) {
			const item = filteredItems[i]!;
			if (item.level < minLevel) break;

			if (
				item.kind === 'folder' &&
				item.isExpanded
			) {
				i++;
				const [children, nextI] = renderItems(
					i,
					item.level + 1,
				);
				const guideStyle = {
					'--guide-left': `${item.level * 16 + 14}px`,
					'--guide-top': `${folderRowHeight}px`,
					'--guide-z': 9 - item.level,
				} as React.CSSProperties;
				nodes.push(
					<div
						key={item.id}
						className="folder-group"
						style={guideStyle}
					>
						<FolderRow
							item={item}
							onToggle={onToggleFolder}
							onCreateFile={
								onCreateFile
							}
							onPlusClick={
								onPlusClick
							}
							rowHeight={
								folderRowHeight
							}
							isRenaming={
								renamingPath ===
								item.path
							}
							renameValue={
								renameValue ?? ''
							}
							renameInputRef={
								renameInputRef ?? {
									current: null,
								}
							}
							onRenameChange={
								onRenameChange ??
								(() => {})
							}
							onRenameConfirm={
								onRenameConfirm ??
								(() => {})
							}
							onRenameCancel={
								onRenameCancel ??
								(() => {})
							}
							onContextMenu={
								onContextMenu
							}
							isDropTarget={
								dropTargetPath ===
								item.path
							}
							onDragStart={
								onDragStart
							}
							onDragOver={
								onDragOver
							}
							onDragLeave={
								onDragLeave
							}
							onDrop={onDrop}
							onDragEnd={
								onDragEnd
							}
							onSelectFolder={
								onSelectFolder
							}
						/>
						{children}
					</div>,
				);
				i = nextI;
			} else if (item.kind === 'folder') {
				nodes.push(
					<FolderRow
						key={item.id}
						item={item}
						onToggle={onToggleFolder}
						onCreateFile={onCreateFile}
						onPlusClick={onPlusClick}
						rowHeight={folderRowHeight}
						isRenaming={
							renamingPath ===
							item.path
						}
						renameValue={
							renameValue ?? ''
						}
						renameInputRef={
							renameInputRef ?? {
								current: null,
							}
						}
						onRenameChange={
							onRenameChange ??
							(() => {})
						}
						onRenameConfirm={
							onRenameConfirm ??
							(() => {})
						}
						onRenameCancel={
							onRenameCancel ??
							(() => {})
						}
						onContextMenu={
							onContextMenu
						}
						isDropTarget={
							dropTargetPath ===
							item.path
						}
						onDragStart={onDragStart}
						onDragOver={onDragOver}
						onDragLeave={onDragLeave}
						onDrop={onDrop}
						onDragEnd={onDragEnd}
						onSelectFolder={
							onSelectFolder
						}
					/>,
				);
				i++;
			} else {
				nodes.push(
					<FileRow
						key={item.id}
						item={item}
						isSelected={
							item.path === selectedPath
						}
						isMultiSelected={
							selectedPaths.has(
								item.path,
							) &&
							item.path !== selectedPath
						}
						isDeleteConfirm={
							deleteConfirmId ===
							item.path
						}
						onItemClick={onItemClick}
						onDelete={handleDelete}
						onDeleteCancel={
							handleDeleteCancel
						}
						isRenaming={
							renamingPath ===
							item.path
						}
						renameValue={
							renameValue ?? ''
						}
						renameInputRef={
							renameInputRef ?? {
								current: null,
							}
						}
						onRenameChange={
							onRenameChange ??
							(() => {})
						}
						onRenameConfirm={
							onRenameConfirm ??
							(() => {})
						}
						onRenameCancel={
							onRenameCancel ??
							(() => {})
						}
						onContextMenu={
							onContextMenu
						}
						onDragStart={onDragStart}
						onDragEnd={onDragEnd}
						sortMode={sortMode}
					/>,
				);
				i++;
			}
		}

		return [nodes, i];
	};

	const [treeContent] = renderItems(0, 0);

	return (
		<div className="table-container items-table">
			<SearchSortControls
				ref={searchRef}
				leadingContent={leadingContent}
				searchQuery={searchQuery}
				onSearchQueryChange={setSearchQuery}
				sortMode={sortMode}
				onCycleSortMode={onCycleSortMode}
				searchPlaceholder="Search  ⌘K"
				onArrowNav={navigateItems}
			/>
			<div className="table-wrapper">
				<div
					ref={containerRef}
					className="table-body-scroll scrollbar-hover"
					onDragOver={
						workspacePath
							? (e) => {
									if (
										e.target !==
										e.currentTarget
									)
										return;
									onDragOver?.(
										e,
										workspacePath,
									);
								}
							: undefined
					}
					onDrop={
						workspacePath
							? (e) => {
									if (
										e.target !==
										e.currentTarget
									)
										return;
									onDrop?.(
										e,
										workspacePath,
									);
								}
							: undefined
					}
					onContextMenu={(e) => {
						if (
							e.target ===
							e.currentTarget
						) {
							e.preventDefault();
							onContextMenu?.(
								e,
								null,
							);
						}
					}}
				>
					{treeContent}
				</div>
			</div>
		</div>
	);
};
