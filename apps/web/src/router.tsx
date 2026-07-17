import { useEffect, useRef } from "react";
import { createBrowserRouter, Outlet, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { ChatView } from "./views/ChatView";
import { TasksView } from "./views/TasksView";
import { RoutinesView } from "./views/RoutinesView";
import { RunDetailView } from "./views/RunDetailView";
import { InboxView } from "./views/InboxView";
import { MarketplaceView } from "./views/MarketplaceView";
import { KbView } from "./views/KbView";
import { SkillsView } from "./views/SkillsView";
import { SettingsView } from "./views/SettingsView";
import { IntegrationsView } from "./views/IntegrationsView";
import { OnboardingView } from "./views/OnboardingView";
import { AutoWorkView } from "./views/AutoWorkView";
import { ProjectConfigView } from "./views/ProjectConfigView";
import { CodebaseMemoryView } from "./views/CodebaseMemoryView";
import { MemoryView } from "./views/MemoryView";
import { SubscriptionLimitsView } from "./views/SubscriptionLimitsView";
import { SessionsView } from "./views/SessionsView";
import { GovernanceView } from "./views/GovernanceView";
import { onboardingApi } from "./lib/onboarding-api";

/**
 * First-paint redirect: if the server reports `needsOnboarding`, route
 * brand-new users to the wizard instead of an empty chat. Only triggers
 * once per page load and only when the user lands on `/` — typing any
 * other URL bypasses the gate (the wizard is escapable, and we don't
 * want to re-trap users who already saw it).
 */
function OnboardingGate() {
	const navigate = useNavigate();
	const location = useLocation();
	const checked = useRef(false);
	useEffect(() => {
		if (checked.current) return;
		checked.current = true;
		if (location.pathname !== "/") return; // user explicitly navigated; respect that
		void onboardingApi
			.state()
			.then((state) => {
				if (state.needsOnboarding) navigate("/onboarding", { replace: true });
			})
			.catch(() => {
				// State endpoint failed — don't block the app. Onboarding can be
				// re-run from Settings if the gate misfires.
			});
	}, [location.pathname, navigate]);
	return <Outlet />;
}

const router = createBrowserRouter([
	{
		element: <OnboardingGate />,
		children: [
			{ path: "/", element: <ChatView /> },
			{ path: "/c/:sessionId", element: <ChatView /> },
			{ path: "/tasks", element: <TasksView /> },
			{ path: "/routines", element: <RoutinesView /> },
			{ path: "/routines/:id/runs/:runId", element: <RunDetailView /> },
			{ path: "/inbox", element: <InboxView /> },
			{ path: "/marketplace", element: <MarketplaceView /> },
			{ path: "/skills", element: <SkillsView /> },
			{ path: "/kb", element: <KbView /> },
			{ path: "/integrations", element: <IntegrationsView /> },
			{ path: "/auto-work", element: <AutoWorkView /> },
			{ path: "/project-config", element: <ProjectConfigView /> },
			{ path: "/codebase-memory", element: <CodebaseMemoryView /> },
			{ path: "/memory", element: <MemoryView /> },
			{ path: "/sessions", element: <SessionsView /> },
			{ path: "/governance", element: <GovernanceView /> },
			{ path: "/subscription-limits", element: <SubscriptionLimitsView /> },
			{ path: "/settings", element: <SettingsView /> },
			{ path: "/onboarding", element: <OnboardingView /> },
		],
	},
]);

export function AppRouter() {
	return <RouterProvider router={router} />;
}
