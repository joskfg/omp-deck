import { Activity, BookOpen, BotMessageSquare, Brain, ChartNoAxesCombined, Clock, Database, FolderCog, Inbox, KanbanSquare, MessagesSquare, Plug, Settings, ShieldCheck, Sparkles, Store } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

const ITEMS: ReadonlyArray<{
	to: string;
	label: string;
	icon: typeof MessagesSquare;
}> = [
	{ to: "/", label: "Chat", icon: MessagesSquare },
	{ to: "/sessions", label: "Sessions", icon: Activity },
	{ to: "/tasks", label: "Tasks", icon: KanbanSquare },
	{ to: "/routines", label: "Routines", icon: Clock },
	{ to: "/inbox", label: "Inbox", icon: Inbox },
	{ to: "/marketplace", label: "Marketplace", icon: Store },
	{ to: "/skills", label: "Skills", icon: Sparkles },
	{ to: "/kb", label: "Knowledge", icon: BookOpen },
	{ to: "/memory", label: "Memory", icon: Brain },
	{ to: "/integrations", label: "Integrations", icon: Plug },
	{ to: "/auto-work", label: "Auto Work", icon: BotMessageSquare },
	{ to: "/project-config", label: "Project Config", icon: FolderCog },
	{ to: "/codebase-memory", label: "Codebase Memory", icon: Database },
	{ to: "/governance", label: "Governance", icon: ShieldCheck },
	{ to: "/subscription-limits", label: "Subscription limits", icon: ChartNoAxesCombined },
];

/**
 * Vertical icon rail. 48px wide, fixed left edge. Active route gets the rust
 * accent + a thin left tab; inactive entries are muted ink-3 with a hover lift.
 */
export function NavRail() {
	return (
		<nav className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-paper py-2">
			{ITEMS.map((item) => (
				<NavLink
					key={item.to}
					to={item.to}
					end={item.to === "/"}
					title={item.label}
					aria-label={item.label}
					className={({ isActive }) =>
						cn(
							"relative flex h-9 w-9 items-center justify-center rounded-md transition-colors",
							isActive
								? "text-accent bg-accent-soft/40"
								: "text-ink-3 hover:bg-paper-3 hover:text-ink",
						)
					}
				>
					{({ isActive }) => (
						<>
							<item.icon className="h-[18px] w-[18px]" />
							{isActive ? (
								<span
									className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent"
									aria-hidden="true"
								/>
							) : null}
						</>
					)}
				</NavLink>
			))}
			<div className="mt-auto h-px w-7 bg-line" aria-hidden="true" />
			<NavLink
				to="/settings"
				title="Settings"
				aria-label="Settings"
				className={({ isActive }) =>
					cn(
						"relative flex h-9 w-9 items-center justify-center rounded-md transition-colors",
						isActive
							? "text-accent bg-accent-soft/40"
							: "text-ink-3 hover:bg-paper-3 hover:text-ink",
					)
				}
			>
				{({ isActive }) => (
					<>
						<Settings className="h-[18px] w-[18px]" />
						{isActive ? (
							<span
								className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent"
								aria-hidden="true"
							/>
						) : null}
					</>
				)}
			</NavLink>
		</nav>
	);
}
