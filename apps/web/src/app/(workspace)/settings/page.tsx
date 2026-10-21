"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AgentSection } from "@/components/agent-section";
import { BillingSection } from "@/components/billing-section";
import {
  TeamCreditsAdmin,
  type TeamCreditsAdminProps,
  type TeamCreditsMemberName,
} from "@/components/credits/team-credits-admin";
import { CreditUsageHistory } from "@/components/credits/credit-usage-history";
import { ProfileSection } from "@/components/profile-section";
import { SettingsSkeleton } from "@/components/skeletons/settings-skeleton";
import { fetchTeamMembers } from "@/lib/admin-credits-api";
import { useAuth } from "@/lib/auth-context";
import {
  ApiAuthError,
  fetchModels,
  fetchViewer,
  fetchWorkspaceSettings,
  updateProfile,
  updateWorkspaceSettings,
} from "@/lib/server-api";

type SettingsTab = "profile" | "agent" | "billing" | "usage" | "team-credits";

const tabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "agent", label: "Agent" },
  { id: "billing", label: "Billing" },
  { id: "usage", label: "Usage" },
];

/**
 * AD-01 / AD-08: member administration is a team-admin surface only. The server
 * answers 403 to everyone else, so the tab is not rendered for them and a
 * `?tab=team-credits` deep link falls back to profile.
 */
const TEAM_CREDITS_TAB: { id: SettingsTab; label: string } = {
  id: "team-credits",
  label: "成员额度",
};

const TEAM_ADMIN_ROLES: readonly string[] = ["owner", "admin"];

function isSettingsTab(value: string): value is SettingsTab {
  return (
    value === "profile" ||
    value === "agent" ||
    value === "billing" ||
    value === "usage" ||
    value === "team-credits"
  );
}

export default function SettingsPage() {
  const { session } = useAuth();
  const searchParams = useSearchParams();

  const initialTab = (searchParams.get("tab") as SettingsTab) ?? "profile";
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    isSettingsTab(initialTab) ? initialTab : "profile",
  );
  const [profile, setProfile] = useState<{
    displayName: string;
    email: string;
  } | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>("gpt-5.4-mini");
  const [isTeamAdmin, setIsTeamAdmin] = useState(false);
  const [memberNames, setMemberNames] = useState<Record<
    string,
    TeamCreditsMemberName
  > | null>(null);
  const [pageLoading, setPageLoading] = useState(true);

  // Ref pattern: prevent token refresh from cascading through dependency arrays
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;
  const hasInitialized = useRef(false);

  const getToken = useCallback(() => accessTokenRef.current, []);

  const loadData = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setPageLoading(true);

    try {
      const [viewer, settings] = await Promise.all([
        fetchViewer(token),
        fetchWorkspaceSettings(token),
      ]);

      setProfile({
        displayName: viewer.profile.displayName,
        email: viewer.profile.email,
      });
      setDefaultModel(settings.settings.defaultModel);
      setIsTeamAdmin(
        TEAM_ADMIN_ROLES.includes(viewer.teamMembership?.role ?? ""),
      );
    } catch (err) {
      if (err instanceof ApiAuthError) {
        // Workspace layout handles auth redirect
        return;
      }
    } finally {
      setPageLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (hasInitialized.current) return;
    if (!session?.access_token) return;
    hasInitialized.current = true;
    loadData();
  }, [session?.access_token, loadData]);

  // AD-08: the member tab only exists for a team admin, so a deep link to it has
  // to land somewhere the viewer may actually look at.
  useEffect(() => {
    if (pageLoading) return;
    if (!isTeamAdmin && activeTab === "team-credits") {
      setActiveTab("profile");
    }
  }, [pageLoading, isTeamAdmin, activeTab]);

  // AD-01: the credits panel takes the member names from the member list, so the
  // list is read once, the first time the tab is opened. A failed read leaves the
  // names unset (the panel falls back to userId) and still opens the panel.
  const memberNamesRequested = useRef(false);
  useEffect(() => {
    if (activeTab !== "team-credits") return;
    if (!isTeamAdmin) return;
    if (memberNamesRequested.current) return;
    const token = getToken();
    if (!token) return;
    memberNamesRequested.current = true;
    void (async () => {
      try {
        const members = await fetchTeamMembers(token);
        const names: Record<string, TeamCreditsMemberName> = {};
        for (const member of members) {
          names[member.userId] = {
            displayName: member.displayName,
            email: member.email,
          };
        }
        setMemberNames(names);
      } catch {
        // Fall back to userId in the panel rather than blocking it.
      }
    })();
  }, [activeTab, isTeamAdmin, getToken]);

  const handleProfileSave = useCallback(
    async (displayName: string) => {
      const token = getToken();
      if (!token) return;
      const result = await updateProfile(token, { displayName });
      setProfile({
        displayName: result.profile.displayName,
        email: result.profile.email,
      });
    },
    [getToken],
  );

  const handleAgentSave = useCallback(
    async (model: string) => {
      const token = getToken();
      if (!token) return;
      const result = await updateWorkspaceSettings(token, {
        defaultModel: model,
      });
      setDefaultModel(result.settings.defaultModel);
    },
    [getToken],
  );

  const stableFetchModels = useCallback(() => fetchModels(), []);

  if (pageLoading) {
    return <SettingsSkeleton />;
  }

  if (!profile) return null;

  const visibleTabs = isTeamAdmin ? [...tabs, TEAM_CREDITS_TAB] : tabs;
  // `exactOptionalPropertyTypes`: omit the prop entirely instead of passing undefined.
  const teamCreditsProps: TeamCreditsAdminProps =
    memberNames === null ? {} : { memberNames };

  return (
    <div className="px-4 py-6 sm:px-6 md:p-8">
      <h1 className="mb-4 text-base font-semibold sm:mb-6 sm:text-lg">
        Settings
      </h1>

      {/* Tab bar -- scrollable on small screens, 44px min touch target */}
      <div className="mb-6 overflow-x-auto sm:mb-8">
        <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
          {visibleTabs.map((tab) => (
            <button data-testid={`settings-tab-${tab.id}`}
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`min-h-[44px] whitespace-nowrap rounded-md px-4 py-1.5 text-sm transition-colors sm:min-h-0 sm:px-3 ${
                activeTab === tab.id
                  ? "bg-card font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-xl">
        {activeTab === "profile" ? (
          <ProfileSection
            displayName={profile.displayName}
            email={profile.email}
            onSave={handleProfileSave}
          />
        ) : activeTab === "agent" ? (
          <AgentSection
            defaultModel={defaultModel}
            onSave={handleAgentSave}
            fetchModels={stableFetchModels}
          />
        ) : activeTab === "team-credits" && isTeamAdmin ? (
          <TeamCreditsAdmin {...teamCreditsProps} />
        ) : activeTab === "usage" ? (
          <CreditUsageHistory />
        ) : (
          <BillingSection />
        )}
      </div>
    </div>
  );
}
