import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { kbApi } from "@/lib/kb-api";
import { cn } from "@/lib/utils";

// Windows-illegal set (same guard `createUnresolved` already applies to
// wikilink-driven creation) plus control chars. Deliberately excludes `/` —
// this field names one node, not a path; the destination directory is
// chosen by which tree row the user triggered "New file/folder" from.
const INVALID_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]/;

function validateName(raw: string, kind: "file" | "folder"): string | undefined {
	const name = raw.trim();
	if (!name) return "Name is required.";
	if (name === "." || name === "..") return "Invalid name.";
	if (INVALID_NAME_RE.test(name)) return String.raw`Name can't contain \ / : * ? " < > | or control characters.`;
	if (kind === "file" && !name.toLowerCase().endsWith(".md")) return "File name must end in .md.";
	return undefined;
}

interface Props {
	open: boolean;
	kind: "file" | "folder";
	/** kb-relative directory the new node is created into; "" = kb root. */
	parentPath: string;
	onClose: () => void;
	/** Fired with the new node's kb-relative path once creation succeeds. */
	onCreated: (path: string) => void;
}

/**
 * Shared "Create file" / "Create folder" dialog for the kb tree (T-135).
 * The location is fixed by whichever tree row launched it (root header or a
 * folder's own row) — this only asks for a name (+ optional starter content
 * for files). Deletion/rename stay out of scope; only `fs`/commands touch
 * those.
 */
export function KbCreateModal({ open, kind, parentPath, onClose, onCreated }: Props) {
	const [name, setName] = useState("");
	const [content, setContent] = useState("");
	const [error, setError] = useState<string | undefined>();
	const [saving, setSaving] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) return;
		setName("");
		setContent("");
		setError(undefined);
		setSaving(false);
		const raf = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(raf);
	}, [open]);

	async function submit(): Promise<void> {
		if (saving) return;
		const problem = validateName(name, kind);
		if (problem) {
			setError(problem);
			return;
		}
		const trimmed = name.trim();
		const targetPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;
		setSaving(true);
		setError(undefined);
		try {
			if (kind === "file") {
				await kbApi.create(targetPath, content);
			} else {
				await kbApi.createFolder(targetPath);
			}
			onCreated(targetPath);
		} catch (e) {
			setError(String((e as Error).message ?? e));
			setSaving(false);
		}
	}

	if (!open) return null;
	const locationLabel = parentPath ? `${parentPath}/` : "(kb root)";

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-md" heightClass="max-h-[80vh]">
			<div className="flex items-center justify-between border-b border-line bg-paper-2/60 px-3 py-2">
				<div className="meta">{kind === "file" ? "Create file" : "Create folder"}</div>
			</div>
			<div className="border-b border-line px-3 py-2">
				<div className="truncate font-mono text-2xs text-ink-3" title={locationLabel}>
					{locationLabel}
				</div>
			</div>
			<div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
				<div>
					<label className="mb-1 block text-2xs text-ink-3" htmlFor="kb-create-name">
						Name
					</label>
					<input
						id="kb-create-name"
						ref={inputRef}
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void submit();
							}
						}}
						placeholder={kind === "file" ? "notes.md" : "folder-name"}
						spellCheck={false}
						className="w-full rounded-md border border-line bg-paper-2 px-2 py-1.5 font-mono text-sm text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
					/>
				</div>
				{kind === "file" ? (
					<div>
						<label className="mb-1 block text-2xs text-ink-3" htmlFor="kb-create-content">
							Content (optional)
						</label>
						<textarea
							id="kb-create-content"
							value={content}
							onChange={(e) => setContent(e.target.value)}
							rows={8}
							spellCheck={false}
							placeholder={"---\ntype: knowledge\n---\n\n# Title\n"}
							className="h-40 w-full resize-none rounded-md border border-line bg-paper-2 p-2 font-mono text-xs leading-relaxed text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
						/>
					</div>
				) : null}
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 font-mono text-2xs text-danger">
						{error}
					</div>
				) : null}
			</div>
			<div className="flex items-center justify-end gap-2 border-t border-line bg-paper-2/60 px-3 py-2">
				<button type="button" onClick={onClose} disabled={saving} className="btn-ghost h-8 px-3 text-xs">
					Cancel
				</button>
				<button
					type="button"
					onClick={() => void submit()}
					disabled={saving || !name.trim()}
					className={cn("btn-primary inline-flex h-8 items-center gap-1 px-3 text-xs", (saving || !name.trim()) && "opacity-60")}
				>
					{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
					Create
				</button>
			</div>
		</Modal>
	);
}
